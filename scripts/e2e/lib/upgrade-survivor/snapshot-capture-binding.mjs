// Release-cell observation only. No product import, caller wrapper, or source rewrite.
import assert from "node:assert/strict";
import { createHook, executionAsyncId } from "node:async_hooks";
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const snapshotChildArg = "--openclaw-sqlite-readonly-child";

function frames() {
  const prepare = Error.prepareStackTrace;
  try {
    Error.prepareStackTrace = (_error, sites) => sites;
    return new Error().stack.map((site) => ({
      name: site.getFunctionName(),
      file: site.getFileName(),
      line: site.getLineNumber(),
    }));
  } finally {
    Error.prepareStackTrace = prepare;
  }
}

export function readNativeSnapshotRequest(argv) {
  const index = argv.indexOf(snapshotChildArg);
  if (index < 1 || argv[index + 1] !== "sync" || argv.length !== index + 4) {
    return undefined;
  }
  return {
    entrypoint: argv[index - 1],
    source: path.resolve(argv[index + 2]),
    stagingRoot: path.resolve(argv[index + 3]),
  };
}

export function observeSnapshotAllocations(source, request, onAcquisition) {
  const allocate = fs.mkdtempSync;
  fs.mkdtempSync = (...args) => {
    const directory = allocate(...args);
    if (
      request?.source === source &&
      path.dirname(directory) === request.stagingRoot &&
      path.basename(directory).startsWith("openclaw-sqlite-readonly-")
    ) {
      onAcquisition(directory);
    }
    return directory;
  };
  syncBuiltinESMExports();
  return () => {
    fs.mkdtempSync = allocate;
    syncBuiltinESMExports();
  };
}

export function observeRequiredSnapshotRequests({ source, verifyFrame, onRequest, onClose }) {
  const contexts = new Map();
  const requests = [];
  let sequence = 0;
  const stat = fs.promises.lstat;
  const execFile = childProcess.execFile;
  const stackLimit = Error.stackTraceLimit;
  Error.stackTraceLimit = Math.max(stackLimit, 32);
  // Follow the actual target-absence await to its native launch. Merely sharing
  // a database name, stack spelling, marker, or Doctor PID does not bind a call.
  const hook = createHook({
    init(id, _type, trigger) {
      const context = contexts.get(executionAsyncId()) ?? contexts.get(trigger);
      if (context) {
        assert(contexts.size < 65536, "Snapshot caller context observation overflow");
        contexts.set(id, context);
      }
    },
    destroy(id) {
      contexts.delete(id);
    },
  }).enable();
  fs.promises.lstat = function (file, ...args) {
    const target = String(file);
    if (target.startsWith(source + ".pre-startup-migration-") && target.endsWith(".bak")) {
      const sites = frames();
      const owner = sites.find((site) => site.name === "backupDoctorSqliteDatabases");
      const snapshot = sites.find((site) => site.name === "createVerifiedSqliteSnapshot");
      const absent = sites.find((site) => site.name === "assertTargetAbsent");
      if (owner && snapshot && absent) {
        for (const site of [owner, snapshot, absent]) {
          assert(site.file, "Missing capture caller location");
          if (site.file.startsWith("file:")) {
            site.file = fileURLToPath(site.file);
          }
          verifyFrame(site);
        }
        const group = target.slice(source.length + ".pre-startup-migration-".length, -4);
        assert.match(group, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/u);
        const marker = target + ".capturing";
        const markerStat = fs.lstatSync(marker, { bigint: true });
        assert(markerStat.isFile() && markerStat.size === 0n, "Required capture group is not open");
        const sourceStat = fs.lstatSync(source, { bigint: true });
        const context = {
          operation: ++sequence,
          owner,
          snapshot,
          source,
          sourceIdentity: { dev: String(sourceStat.dev), ino: String(sourceStat.ino) },
          target,
          marker,
          markerIdentity: {
            dev: String(markerStat.dev),
            ino: String(markerStat.ino),
            mtimeNs: String(markerStat.mtimeNs),
          },
        };
        contexts.set(executionAsyncId(), context);
      }
    }
    return stat.call(this, file, ...args);
  };
  childProcess.execFile = function (file, argv, ...args) {
    const native = Array.isArray(argv) ? readNativeSnapshotRequest(argv) : undefined;
    const context = contexts.get(executionAsyncId());
    // An unrelated read of this DB never inherits a target just because a
    // required capture exists elsewhere. A joined flight without a native
    // launch here remains unbound and cannot receive this cell's fault.
    const binding = native && context && native.source === context.source ? context : undefined;
    const request = native ? { ...native, binding, request: requests.length + 1 } : undefined;
    if (request) {
      assert(requests.length < 1024, "Snapshot native request observation overflow");
      requests.push(request);
      onRequest(request);
    }
    const child = execFile.call(this, file, argv, ...args);
    if (request) {
      request.pid = child.pid;
      child.once("close", (code, signal) => {
        request.close = { code, signal };
        onClose(request);
      });
    }
    return child;
  };
  syncBuiltinESMExports();
  return {
    requests,
    currentBinding: () => contexts.get(executionAsyncId()),
    restore() {
      fs.promises.lstat = stat;
      childProcess.execFile = execFile;
      syncBuiltinESMExports();
      hook.disable();
      contexts.clear();
      Error.stackTraceLimit = stackLimit;
    },
  };
}
