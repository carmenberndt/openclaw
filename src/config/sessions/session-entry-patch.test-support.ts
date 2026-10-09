import { afterEach, vi } from "vitest";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { readExactSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";

// mock-isolation: Entry assertions exclude the maintenance owner's background writes and timers.
vi.mock("./session-accessor.sqlite-maintenance-kick.js", () => ({
  kickSessionEntryMaintenanceAfterWrite() {},
}));
// mock-isolation: Disk-budget sweeps must not mutate the fixture outside its explicit entry writes.
vi.mock("./session-history-eviction.js", () => ({ kickSessionHistoryDiskBudgetMaintenance() {} }));

const delivery = vi.hoisted(() => ({
  afterPrepare: undefined as (() => void) | undefined,
  afterCommit: undefined as (() => void) | undefined,
  beforeCommit: undefined as (() => void) | undefined,
  commands: [] as string[],
}));
vi.mock("../../state/openclaw-agent-execution.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/openclaw-agent-execution.js")>();
  return {
    ...actual,
    captureOpenClawAgentDatabaseExecution: (
      ...args: Parameters<typeof actual.captureOpenClawAgentDatabaseExecution>
    ): ReturnType<typeof actual.captureOpenClawAgentDatabaseExecution> => {
      const owner = actual.captureOpenClawAgentDatabaseExecution(...args);
      return {
        ...owner,
        get fileIdentity() {
          return owner.fileIdentity;
        },
        runExisting: (source, operation, options) =>
          owner.runExisting(
            source,
            (worker) =>
              operation({
                execute: async (command, commandOptions) => {
                  delivery.commands.push(command.type);
                  if (command.type === "session.entry.patch.commit") {
                    delivery.beforeCommit?.();
                  }
                  const result = await worker.execute(command, commandOptions);
                  if (command.type === "session.entry.patch.prepare") {
                    delivery.afterPrepare?.();
                  }
                  if (command.type === "session.entry.patch.commit") {
                    delivery.afterCommit?.();
                  }
                  return result;
                },
              }),
            options,
          ),
      };
    },
  };
});

afterEach(() => {
  delivery.afterPrepare = undefined;
  delivery.afterCommit = undefined;
  delivery.beforeCommit = undefined;
  delivery.commands = [];
  vi.restoreAllMocks();
});

export function createSessionEntryPatchFixture() {
  const database = openOpenClawAgentDatabase({ agentId: "main" });
  const scope = {
    agentId: "main",
    storePath: database.path,
    sessionKey: "agent:main:patch-worker",
  };
  replaceSessionEntrySync(scope, { sessionId: "original", updatedAt: 1, label: "initial" });
  return {
    database,
    scope,
    read: () => readExactSessionEntryRow(database, scope.sessionKey)?.entry,
  };
}

export function getSessionEntryPatchDelivery() {
  return delivery;
}
