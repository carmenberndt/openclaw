// Anthropic's /v1/models rows advertise each model's thinking and effort contract.
// Request shaping reads those facts from the catalog row (`params.claudeCapabilities`
// and `thinkingLevelMap`), so a newly listed model is selectable and shaped
// correctly before OpenClaw learns its id. Rows without them keep the id rules.
import type { LiveModelRowProjection } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  asOptionalRecord,
  asPositiveSafeInteger,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";

// Same conservative limits the forward-compat row uses when a listing omits them.
const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 64_000;

function readSupported(capabilities: unknown, path: readonly string[]): boolean | undefined {
  let current = capabilities;
  for (const key of path) {
    current = asOptionalRecord(current)?.[key];
  }
  // Anthropic reports a level the model does not offer at all (for example xhigh) as null.
  if (current === null) {
    return false;
  }
  const supported = asOptionalRecord(current)?.supported;
  return typeof supported === "boolean" ? supported : undefined;
}

function readClaudeListedCapabilities(capabilities: unknown) {
  const adaptiveThinking = readSupported(capabilities, ["thinking", "types", "adaptive"]);
  const xhighEffort = readSupported(capabilities, ["effort", "xhigh"]);
  const maxEffort = readSupported(capabilities, ["effort", "max"]);
  if (adaptiveThinking === undefined || xhighEffort === undefined || maxEffort === undefined) {
    return undefined;
  }
  const disabledThinking = readSupported(capabilities, ["thinking", "types", "disabled"]);
  return {
    adaptiveThinking,
    xhighEffort,
    maxEffort,
    ...(disabledThinking === undefined ? {} : { disabledThinking }),
  };
}

export const projectAnthropicLiveModels: LiveModelRowProjection = (rows, fallback) => {
  const seeds = new Map(fallback.models.map((model) => [model.id, model]));
  const models = new Map<string, ModelDefinitionConfig>();
  for (const row of rows) {
    const record = asOptionalRecord(row);
    const id = normalizeOptionalString(record?.id);
    if (
      !record ||
      !id ||
      id.length > 512 ||
      /[\s\p{Cc}]/u.test(id) ||
      (record.type !== undefined && record.type !== "model")
    ) {
      continue;
    }
    const seed = seeds.get(id);
    const claudeCapabilities = readClaudeListedCapabilities(record.capabilities);
    if (!claudeCapabilities) {
      // Without advertised capabilities only a shipped id has a known request contract.
      if (seed) {
        models.set(id, seed);
      }
      continue;
    }
    const base: ModelDefinitionConfig = seed ?? {
      id,
      name: normalizeOptionalString(record.display_name) ?? id,
      reasoning: readSupported(record.capabilities, ["thinking"]) ?? true,
      input: readSupported(record.capabilities, ["image_input"]) ? ["text", "image"] : ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: asPositiveSafeInteger(record.max_input_tokens) ?? DEFAULT_CONTEXT_WINDOW,
      maxTokens: asPositiveSafeInteger(record.max_tokens) ?? DEFAULT_MAX_TOKENS,
    };
    models.set(id, {
      ...base,
      thinkingLevelMap: {
        ...base.thinkingLevelMap,
        xhigh: claudeCapabilities.xhighEffort ? "xhigh" : null,
        max: claudeCapabilities.maxEffort ? "max" : null,
      },
      params: { ...base.params, claudeCapabilities },
    });
  }
  return [...models.values()].toSorted((left, right) => left.id.localeCompare(right.id));
};
