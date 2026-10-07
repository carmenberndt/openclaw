import { throwSqliteLifecycleErrors } from "../../infra/sqlite-lifecycle-errors.js";
import type { CapturedSessionEntryReadSource } from "./session-entry-read-source.types.js";
import type { SessionTranscriptContextVersion } from "./session-transcript-context-version.types.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

export type SessionSourceConversationPredicate = {
  conversationRef: string;
  sessionKey: string | null;
};

/** Prepared source facts are compared again on the existing writer's connection. */
export type SessionSourcePredicate = {
  source: CapturedSessionEntryReadSource;
  sessionKey: string;
  fields: (keyof SessionEntry)[];
  expected: Partial<SessionEntry> | undefined;
  members?: readonly string[];
  transcript?: { sessionId: string; version: SessionTranscriptContextVersion };
  conversationAlternatives?: readonly (readonly SessionSourceConversationPredicate[])[];
};

export type SessionSourcePredicateFacts = {
  entry: SessionEntry | undefined;
  members?: readonly string[];
};

export type SessionSourceValidation = {
  refusedSource?: { index: number; facts: SessionSourcePredicateFacts };
  conversationMatches: Array<{ index: number; alternatives: number[] }>;
};

export type PreparedSessionSourceAuthority = {
  /** Process-held sources require native atomicity when writing a durable target. */
  nativeSource?: boolean;
  assertCurrent: () => void;
  /** Prepared components only; opaque callbacks still require the full native fence. */
  assertPreparedCurrent?: () => void;
  checks: {
    predicate: SessionSourcePredicate;
    refuse: (facts: SessionSourcePredicateFacts) => never;
    acceptConversationMatches?: (alternatives: readonly number[]) => void;
  }[];
  release?: () => void | Promise<void>;
};

export type SessionSourceAssertion = (() => void) & {
  nativeSource?: boolean;
  prepareSessionSource?: () => Promise<PreparedSessionSourceAuthority>;
};

/** Public boolean callbacks stay callable; bundled owners also carry their prepared writer source. */
export type SessionSourceCheck = (() => boolean) & { sessionSource?: SessionSourceAssertion };

export function sessionEntryCommitGuardOptions(source: SessionSourceAssertion | undefined) {
  return source?.nativeSource ? { assertCommitAllowed: source } : { workerGuard: { source } };
}

/** Install transaction facts before composed host assertions recheck their live alternatives. */
export function acceptSessionSourceValidation(
  source: PreparedSessionSourceAuthority,
  validation: SessionSourceValidation | undefined,
): void {
  const refused = validation?.refusedSource;
  if (refused) {
    source.checks[refused.index]?.refuse(refused.facts);
    throw new Error("Session source refusal omitted its prepared assertion");
  }
  for (const [index, check] of source.checks.entries()) {
    if (!check.acceptConversationMatches) {
      continue;
    }
    const matched = validation?.conversationMatches.find((entry) => entry.index === index);
    if (
      !matched ||
      matched.alternatives.some(
        (alternative) =>
          !Number.isSafeInteger(alternative) ||
          alternative < 0 ||
          alternative >= (check.predicate.conversationAlternatives?.length ?? 0),
      )
    ) {
      throw new Error("Session source validation omitted its matching alternatives");
    }
    check.acceptConversationMatches(matched.alternatives);
  }
}

/** Classify request/SDK callbacks before adapters compose them with prepared internal authority. */
export function captureExternalSessionCommitGuard(guard: SessionSourceAssertion | undefined) {
  return guard && !guard.prepareSessionSource
    ? Object.assign(() => guard(), { nativeSource: true })
    : guard;
}

export async function releaseSessionSourceAuthorities(
  sources: readonly Pick<PreparedSessionSourceAuthority, "release">[],
  priorErrors: readonly unknown[] = [],
): Promise<void> {
  const errors: unknown[] = [...priorErrors];
  for (const source of sources.toReversed()) {
    try {
      await source.release?.();
    } catch (error) {
      errors.push(error);
    }
  }
  throwSqliteLifecycleErrors(errors, "Session source cleanup failed");
}

export async function prepareSessionSourceAuthority(
  assertion: SessionSourceAssertion | undefined,
): Promise<PreparedSessionSourceAuthority> {
  return assertion?.prepareSessionSource
    ? assertion.prepareSessionSource()
    : { assertCurrent: () => assertion?.(), checks: [], nativeSource: assertion?.nativeSource };
}

/** A live selector may advance between operations, never during one prepared write. */
export function createDynamicSessionSourceAssertion(
  select: () => SessionSourceAssertion | undefined,
  refuse: () => never,
): SessionSourceAssertion {
  const assertion = Object.assign(() => select()?.(), {
    prepareSessionSource() {
      const selected = select();
      return prepareSessionSourceAuthority(
        composeSessionSourceAssertion([selected], (assertSource) => {
          if (select() !== selected) {
            refuse();
          }
          assertSource();
        }),
      );
    },
  });
  return Object.defineProperty(assertion, "nativeSource", {
    enumerable: true,
    get: () => select()?.nativeSource,
  });
}

/** Preserve each owner's error/lifetime wrapper while preparing its storage-dependent sources. */
export function composeSessionSourceAssertion(
  sources: readonly (SessionSourceAssertion | undefined)[],
  check: (assertSources: () => void) => void = (assertSources) => assertSources(),
  options?: { preparedCheck: (assertSources: () => void) => void },
): SessionSourceAssertion {
  const assertion = Object.assign(() => check(() => sources.forEach((source) => source?.())), {
    async prepareSessionSource(): Promise<PreparedSessionSourceAuthority> {
      const prepared: PreparedSessionSourceAuthority[] = [];
      const release = () => releaseSessionSourceAuthorities(prepared);
      try {
        for (const source of sources) {
          prepared.push(await prepareSessionSourceAuthority(source));
        }
        return {
          nativeSource: prepared.some((source) => source.nativeSource),
          assertCurrent: () => check(() => prepared.forEach((source) => source.assertCurrent())),
          assertPreparedCurrent: () =>
            (options?.preparedCheck ?? check)(() => {
              for (const source of prepared) {
                if (source.assertPreparedCurrent) {
                  source.assertPreparedCurrent();
                } else if (!source.nativeSource) {
                  source.assertCurrent();
                }
              }
            }),
          checks: prepared.flatMap((source, index) =>
            source.checks.map(({ refuse, ...preparedCheck }) => ({
              ...preparedCheck,
              refuse: (facts) => {
                check(() => {
                  prepared.slice(0, index).forEach((previous) => previous.assertCurrent());
                  refuse(facts);
                });
                throw new Error("Source authority refusal was suppressed");
              },
            })),
          ),
          release,
        };
      } catch (error) {
        let failure = error;
        try {
          check(() => {
            prepared.forEach((source) => source.assertCurrent());
            throw error;
          });
        } catch (translatedError) {
          failure = translatedError;
        }
        await releaseSessionSourceAuthorities(prepared, [failure]);
        throw failure;
      }
    },
  });
  return Object.defineProperty(assertion, "nativeSource", {
    enumerable: true,
    get: () => sources.some((source) => source?.nativeSource),
  });
}
