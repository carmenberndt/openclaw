import type { DatabaseSync } from "node:sqlite";
import {
  captureOpenClawAgentDatabaseExecution,
  readOpenClawAgentDatabaseIdentity,
  supportsOpenClawAgentDatabaseExecution,
  type OpenClawAgentDatabaseExecution,
} from "openclaw/plugin-sdk/sqlite-runtime";

export async function withMemoryPublicationExecution(
  params: {
    db: DatabaseSync;
    writeOptions?: Parameters<typeof captureOpenClawAgentDatabaseExecution>[0];
    readOnly: boolean;
    closed: boolean;
  },
  run: () => Promise<void>,
): Promise<void> {
  let execution: OpenClawAgentDatabaseExecution | undefined;
  if (
    params.writeOptions &&
    !params.readOnly &&
    supportsOpenClawAgentDatabaseExecution(params.writeOptions)
  ) {
    const source = readOpenClawAgentDatabaseIdentity({ db: params.db });
    if (params.closed || !params.db.isOpen || typeof source.identity !== "string") {
      throw new Error("Memory publication requires its live file owner");
    }
    // Retain across fallback preparation; a no-op generation never opens a native worker.
    execution = captureOpenClawAgentDatabaseExecution(params.writeOptions, {
      expectedIdentity: {
        kind: "file",
        physicalIdentity: source.identity,
        nativeLocation: source.filename,
        birthtime: source.birthtime,
      },
    });
  }
  const failures: unknown[] = [];
  try {
    await run();
  } catch (error) {
    failures.push(error);
  }
  try {
    await execution?.release();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, `${String(failures[0])}; Memory sync cleanup failed`, {
      cause: failures[0],
    });
  }
}
