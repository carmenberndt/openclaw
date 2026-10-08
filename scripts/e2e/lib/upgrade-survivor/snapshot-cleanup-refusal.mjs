// Explicit release-cell fault injection; never imports or rewrites product modules.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import sqlite, { DatabaseSync } from "node:sqlite";
import { inspect } from "node:util";
import { isMainThread, parentPort, threadId } from "node:worker_threads";
import {
  observeRequiredSnapshotRequests,
  observeSnapshotAllocations,
  readNativeSnapshotRequest,
} from "./snapshot-capture-binding.mjs";
import {
  assertSelectedSnapshotAcquisitions,
  createSnapshotAcquisitionRecorder,
  snapshotEvidenceRecords,
  summarizeSnapshotCleanupEvidence,
} from "./snapshot-cleanup-evidence.mjs";
import {
  assertWorkerCellPackageIdentity,
  readWorkerCellPackageIdentity,
} from "./worker-cell-package.mjs";

const fixtureName = "snapshot-cleanup-fixture.json";
const monotonic = () => String(process.hrtime.bigint());
const nativeReceipt = (artifacts, root) =>
  path.join(artifacts, "snapshot-cleanup-native-" + hash(root) + ".json");
const optionalJson = (file) => (fs.existsSync(file) ? readJson(file) : undefined);
const refusal = "SQLite artifact-preserving copy and cleanup failed";
const denial = "snapshot cleanup refusal fixture";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const writeJson = (file, value) =>
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });

function family(source) {
  return Object.fromEntries(
    ["", "-wal", "-shm", "-journal"].flatMap((suffix) => {
      const file = source + suffix;
      return fs.existsSync(file) ? [[suffix, hash(fs.readFileSync(file))]] : [];
    }),
  );
}

function isRuntimeEntrypoint(relative) {
  return relative === "openclaw.mjs" || relative.startsWith("dist/");
}

function readIdentityAtRoot(root, file, relative) {
  const manifest = fs.readFileSync(path.join(root, "package.json"));
  const build = fs.readFileSync(path.join(root, "dist/build-info.json"));
  const info = JSON.parse(build.toString("utf8"));
  return {
    root,
    version: info.version,
    commit: info.commit,
    entrypoint: relative,
    entrypointSha256: hash(fs.readFileSync(file)),
    manifestSha256: hash(manifest),
    buildInfoSha256: hash(build),
  };
}

export function readSnapshotProcessIdentity(entrypoint, expected, admittedRoot) {
  if (!entrypoint) {
    return undefined;
  }
  const requested = path.resolve(entrypoint);
  const relative = (file) => path.relative(admittedRoot, file).split(path.sep).join("/");
  // Preserve selection from the already verified Doctor root, not mutable
  // package metadata. Resolve parent aliases even when the entry was removed.
  let selectedRelative =
    admittedRoot && isRuntimeEntrypoint(relative(requested)) ? relative(requested) : undefined;
  let resolved;
  if (admittedRoot) {
    let ancestor = requested;
    const missing = [];
    while (!fs.lstatSync(ancestor, { throwIfNoEntry: false })) {
      const parent = path.dirname(ancestor);
      assert(parent !== ancestor, "Runtime argument has no existing ancestor");
      missing.unshift(path.basename(ancestor));
      ancestor = parent;
    }
    const viaAncestor = path.join(fs.realpathSync(ancestor), ...missing);
    if (isRuntimeEntrypoint(relative(viaAncestor))) {
      selectedRelative ??= relative(viaAncestor);
    }
    if (!missing.length) {
      resolved = viaAncestor;
    }
  }
  if (!fs.lstatSync(requested, { throwIfNoEntry: false })) {
    assert(selectedRelative === undefined, "Selected candidate runtime is missing");
    return undefined;
  }
  const file = resolved ?? fs.realpathSync(requested);
  const actualRelative = admittedRoot ? relative(file) : undefined;
  if (selectedRelative !== undefined || (actualRelative && isRuntimeEntrypoint(actualRelative))) {
    assert(
      actualRelative && isRuntimeEntrypoint(actualRelative),
      "Selected runtime escaped its admitted package",
    );
    assert(fs.statSync(file).isFile(), "Selected candidate runtime is not a regular file");
    return bindSnapshotRuntimeIdentity(
      readIdentityAtRoot(admittedRoot, file, actualRelative),
      expected,
    );
  }
  // Eval/print probes can pass directories as argv[1]. They are not selected
  // application invocations; never try to hash them as executable files.
  if (!fs.statSync(file).isFile()) {
    return undefined;
  }
  for (let root = path.dirname(file), depth = 0; depth < 5; root = path.dirname(root), depth++) {
    const manifest = path.join(root, "package.json");
    const build = path.join(root, "dist/build-info.json");
    if (fs.existsSync(manifest) && fs.existsSync(build) && readJson(manifest).name === "openclaw") {
      const identity = readIdentityAtRoot(
        root,
        file,
        path.relative(root, file).split(path.sep).join("/"),
      );
      return expected && identity.commit === expected.buildInfo.commit
        ? bindSnapshotRuntimeIdentity(identity, expected)
        : identity;
    }
  }
  return undefined;
}

export function seedSnapshotCleanupRefusal({
  source,
  artifacts,
  candidateIdentity,
  baseline,
  gatewayPid,
}) {
  assert.equal(baseline.version, "2026.9.7");
  const candidateCommit = candidateIdentity.buildInfo.commit;
  assert.match(candidateCommit, /^[0-9a-f]{40}$/u);
  assert(Number.isSafeInteger(gatewayPid) && gatewayPid > 1);
  const database = new DatabaseSync(source);
  try {
    database.exec(
      "CREATE TABLE snapshot_cleanup_witness(value INTEGER NOT NULL); INSERT INTO snapshot_cleanup_witness VALUES(0)",
    );
  } finally {
    database.close();
  }
  writeJson(path.join(artifacts, "snapshot-cleanup-candidate-identity.json"), candidateIdentity);
  writeJson(path.join(artifacts, fixtureName), { source, candidateCommit, baseline, gatewayPid });
}

function doctorAncestor(artifacts) {
  for (let pid = process.pid, depth = 0; pid > 1 && depth < 12; depth++) {
    const file = path.join(artifacts, "snapshot-cleanup-doctor-" + pid + ".json");
    if (fs.existsSync(file)) {
      return readJson(file);
    }
    try {
      const stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
      pid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

// Native online backup bypasses descriptor copy. Observe its native boundary
// without changing source admission, arguments, completion, or cleanup.
export function observeSnapshotNativeBackups(sourcePath, onAcquisition) {
  const backup = sqlite.backup;
  sqlite.backup = (source, destination, ...args) => {
    if (source.location() === sourcePath) {
      onAcquisition(path.dirname(String(destination)));
    }
    return backup(source, destination, ...args);
  };
  syncBuiltinESMExports();
  return () => {
    sqlite.backup = backup;
    syncBuiltinESMExports();
  };
}

export function bindSnapshotRuntimeIdentity(identity, expected) {
  // NODE_OPTIONS reaches npm lifecycle scripts too. Only packaged application
  // entrypoints belong to this observer; unknown dist workers still fail closed.
  if (!isRuntimeEntrypoint(identity.entrypoint)) {
    return undefined;
  }
  assert.equal(identity.entrypointSha256, expected.files[identity.entrypoint]?.sha256);
  assert.equal(identity.manifestSha256, expected.files["package.json"]?.sha256);
  assert.equal(identity.buildInfoSha256, expected.files["dist/build-info.json"]?.sha256);
  return { ...identity, payloadSha256: hash(JSON.stringify(expected)) };
}

function installFault() {
  const artifacts = process.env.OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT;
  if (!artifacts || !fs.existsSync(path.join(artifacts, fixtureName))) {
    return;
  }
  assert.equal(process.platform, "linux");
  assert(fs.existsSync("/.dockerenv"), "Snapshot fault injection requires disposable Docker state");
  const fixture = readJson(path.join(artifacts, fixtureName));
  const expected = readJson(path.join(artifacts, "snapshot-cleanup-candidate-identity.json"));
  const admittedDoctor = doctorAncestor(artifacts);
  if (admittedDoctor) {
    assert.equal(admittedDoctor.fullPayloadVerified, true);
    assert.equal(admittedDoctor.identity.commit, fixture.candidateCommit);
    assert.equal(admittedDoctor.identity.payloadSha256, hash(JSON.stringify(expected)));
  }
  const admittedRoot = admittedDoctor?.identity.root;
  const identity = readSnapshotProcessIdentity(process.argv[1], expected, admittedRoot);
  if (!identity) {
    return;
  }
  const role = process.argv[2] === "--doctor" ? "doctor" : process.argv[2];
  if (isMainThread && role === "update" && identity.version === fixture.baseline.version) {
    writeJson(path.join(artifacts, "snapshot-cleanup-driver.json"), { pid: process.pid, identity });
  }
  // The old driver's own capture is deliberately untouched. A candidate Doctor
  // (and its real inspection subprocesses) must reach the repaired producer.
  if (identity.commit !== fixture.candidateCommit) {
    return;
  }
  if (isMainThread && role === "doctor") {
    assertWorkerCellPackageIdentity(readWorkerCellPackageIdentity(identity.root), expected);
    writeJson(path.join(artifacts, "snapshot-cleanup-doctor-" + process.pid + ".json"), {
      pid: process.pid,
      parentPid: process.ppid,
      identity,
      updateInProgress: process.env.OPENCLAW_UPDATE_IN_PROGRESS === "1",
      fullPayloadVerified: true,
      start: fs
        .readFileSync("/proc/" + process.pid + "/stat", "utf8")
        .split(") ")[1]
        .split(" ")[19],
    });
  }
  const doctorFile = path.join(artifacts, "snapshot-cleanup-doctor-" + process.pid + ".json");
  const parentRequests = [];
  const observer =
    isMainThread && role === "doctor"
      ? observeRequiredSnapshotRequests({
          source: fixture.source,
          verifyFrame(site) {
            const relative = path.relative(identity.root, site.file).split(path.sep).join("/");
            assert(relative.startsWith("dist/"), "Capture caller escaped the admitted package");
            assert.equal(hash(fs.readFileSync(site.file)), expected.files[relative]?.sha256);
            site.file = relative;
            site.sha256 = expected.files[relative].sha256;
          },
          onRequest(request) {
            request.parentPid = process.pid;
            request.parentStart = readJson(doctorFile).start;
            request.at = monotonic();
            if (request.binding) {
              request.operationId =
                process.pid + ":" + request.parentStart + ":" + request.binding.operation;
            }
            if (request.binding) {
              request.binding.operationId = request.operationId;
              parentRequests.push(request);
              writeJson(nativeReceipt(artifacts, request.stagingRoot), request);
            }
          },
          onClose(request) {
            if (request.binding) {
              request.closedAt = monotonic();
              writeJson(nativeReceipt(artifacts, request.stagingRoot), request);
            }
          },
        })
      : undefined;
  const nativeRequest = readNativeSnapshotRequest(process.argv.slice(1));
  const native = nativeRequest
    ? optionalJson(nativeReceipt(artifacts, nativeRequest.stagingRoot))
    : undefined;
  if (native?.binding) {
    assert.equal(native.source, fixture.source);
    assert.equal(native.stagingRoot, nativeRequest.stagingRoot);
    assert.equal(native.parentPid, process.ppid);
    assert.equal(native.parentPid, admittedDoctor?.pid);
    assert.equal(native.parentStart, admittedDoctor?.start);
    assert.deepEqual(
      native.binding.sourceIdentity,
      ((stat) => ({ dev: String(stat.dev), ino: String(stat.ino) }))(
        fs.statSync(fixture.source, { bigint: true }),
      ),
    );
  }
  const writeFile = fs.promises.writeFile;
  if (isMainThread && role === "doctor") {
    fs.promises.writeFile = async function (file, data, ...rest) {
      const result = await writeFile.call(this, file, data, ...rest);
      if (String(file) === process.env.OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH) {
        const value = JSON.parse(String(data));
        const doctor = readJson(doctorFile);
        doctor.result = {
          status: value.status,
          failureFacts: value.failureFacts,
          sha256: hash(String(data)),
        };
        writeJson(doctorFile, doctor);
      }
      return result;
    };
  }
  // The owned service keeps only heap options; retain the probe stack budget here.
  Error.stackTraceLimit = Math.max(Error.stackTraceLimit, 32);
  const descriptors = new Map();
  const open = fs.openSync.bind(fs);
  const close = fs.closeSync.bind(fs);
  const sync = fs.fsyncSync.bind(fs);
  const read = fs.readSync.bind(fs);
  const remove = fs.rmSync.bind(fs);
  const removeAsync = fs.promises.rm.bind(fs.promises);
  const recordAcquisition = createSnapshotAcquisitionRecorder(artifacts, {
    identity,
    pid: process.pid,
    threadId,
    operationId: () => native?.operationId ?? observer?.currentBinding()?.operationId,
  });
  observeSnapshotNativeBackups(fixture.source, recordAcquisition);
  let observed;
  let injecting = false;
  let transcript = "";
  const receipt = path.join(
    artifacts,
    "snapshot-cleanup-copy-" + process.pid + "-" + threadId + ".json",
  );
  const save = () => writeJson(receipt, observed);
  const owns = (file) =>
    observed &&
    (path.resolve(String(file)) === observed.staging ||
      path.resolve(String(file)).startsWith(observed.staging + path.sep));
  const inject = () => {
    if (observed || injecting) {
      return;
    }
    if (!native?.binding || nativeRequest.source !== fixture.source) {
      return;
    }
    injecting = true;
    try {
      const doctor = doctorAncestor(artifacts);
      if (!doctor?.updateInProgress) {
        return;
      }
      try {
        process.kill(fixture.gatewayPid, 0);
        return;
      } catch (error) {
        if (error.code !== "ESRCH") {
          throw error;
        }
      }
      const target = [...descriptors.values()].find(
        (file) =>
          /(?:^|\/)(?:first|database\.sqlite\.partial)$/u.test(file) &&
          path.basename(path.dirname(file)).startsWith("openclaw-sqlite-readonly-") &&
          fs.existsSync(file) &&
          fs.statSync(file).size > 0,
      );
      if (
        !target ||
        !path.resolve(target).startsWith(native.stagingRoot + path.sep) ||
        ![...descriptors.values()].includes(fixture.source)
      ) {
        return;
      }
      try {
        fs.writeFileSync(
          path.join(artifacts, "snapshot-cleanup-fault-claim"),
          String(process.pid),
          { flag: "wx", mode: 0o600 },
        );
      } catch (error) {
        if (error.code === "EEXIST") {
          return;
        }
        throw error;
      }
      const writer = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          "import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(process.argv[1]); db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_checkpoint(TRUNCATE); UPDATE snapshot_cleanup_witness SET value=value+1;'); process.kill(process.pid, 'SIGKILL');",
          fixture.source,
        ],
        { env: { ...process.env, NODE_OPTIONS: "" }, encoding: "utf8", timeout: 30000 },
      );
      assert.equal(
        writer.signal,
        "SIGKILL",
        "Native fixture writer did not commit and settle: " + writer.stderr,
      );
      observed = {
        pid: process.pid,
        threadId,
        parentPid: process.ppid,
        identity,
        doctor,
        native,
        injectedAt: monotonic(),
        writer: { pid: writer.pid, signal: writer.signal },
        staging: path.dirname(target),
        afterWriter: family(fixture.source),
        cleanupDenials: 0,
        terminalRefusal: false,
        sourcePreservedAtRefusal: false,
        cleanupOwnerObserved: false,
        removed: false,
      };
      save();
    } finally {
      injecting = false;
    }
  };
  fs.openSync = (file, flags, mode) => {
    const fd = open(file, flags, mode);
    const pathname = path.resolve(String(file));
    descriptors.set(fd, pathname);
    return fd;
  };
  fs.closeSync = (fd) => {
    try {
      return close(fd);
    } finally {
      descriptors.delete(fd);
    }
  };
  fs.fsyncSync = (fd) => {
    const result = sync(fd);
    inject();
    return result;
  };
  fs.readSync = (...args) => {
    const result = read(...args);
    inject();
    return result;
  };
  observeSnapshotAllocations(fixture.source, nativeRequest, recordAcquisition);
  const parentRemoval = (file) =>
    parentRequests.find((request) => path.resolve(String(file)) === request.stagingRoot);
  const beforeRemove = (file) => {
    const request = parentRemoval(file);
    if (request) {
      const fault = optionalJson(
        path.join(artifacts, "snapshot-cleanup-copy-" + request.pid + "-0.json"),
      );
      request.retirement = {
        afterNativeClose: Boolean(request.close && request.closedAt),
        producerRefused: fault?.terminalRefusal === true,
        startedAt: monotonic(),
        removed: false,
      };
      writeJson(nativeReceipt(artifacts, request.stagingRoot), request);
    }
    if (!owns(file)) {
      return;
    }
    if (!observed.terminalRefusal) {
      observed.cleanupDenials++;
      save();
      throw Object.assign(new Error(denial), { code: "EACCES", path: String(file) });
    }
    observed.cleanupOwnerObserved ||= /removeTempDirectory|retireSqliteSnapshotPayload/u.test(
      new Error().stack ?? "",
    );
  };
  const afterRemove = (file) => {
    const request = parentRemoval(file);
    if (request) {
      request.retirement.removed = !fs.existsSync(request.stagingRoot);
      request.retirement.finishedAt = monotonic();
      writeJson(nativeReceipt(artifacts, request.stagingRoot), request);
    }
    if (owns(file)) {
      observed.removed = !fs.existsSync(observed.staging);
      save();
    }
  };
  fs.rmSync = (file, options) => {
    beforeRemove(file);
    const result = remove(file, options);
    afterRemove(file);
    return result;
  };
  fs.promises.rm = async (file, options) => {
    beforeRemove(file);
    try {
      await removeAsync(file, options);
      afterRemove(file);
    } catch (error) {
      const request = parentRemoval(file);
      if (request) {
        request.retirement.error = {
          code: error.code,
          message: String(error.message).slice(0, 512),
        };
        writeJson(nativeReceipt(artifacts, request.stagingRoot), request);
      }
      throw error;
    }
  };
  const observeTerminal = (data) => {
    if (observed && !observed.terminalRefusal) {
      transcript = (transcript + data).slice(-32768);
      if (
        transcript.includes(refusal) &&
        transcript.includes(denial) &&
        /SQLite (?:journal state|journal mode|WAL generation|WAL|main database).*changed/u.test(
          transcript,
        )
      ) {
        observed.terminalRefusal = true;
        observed.retainedAtRefusal = fs.existsSync(observed.staging);
        observed.failure = {
          message: transcript.slice(-2500),
          sha256: hash(transcript),
          truncated: transcript.length > 2500,
        };
        observed.groupIncompleteAtRefusal =
          fs.existsSync(native.binding.marker) && !fs.existsSync(native.binding.target);
        observed.unpublishedAtRefusal = !fs.existsSync(
          path.join(observed.staging, "database.sqlite"),
        );
        observed.sourcePreservedAtRefusal =
          JSON.stringify(family(fixture.source)) === JSON.stringify(observed.afterWriter);
        save();
      }
    }
  };
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream);
    stream.write = (...args) => {
      observeTerminal(String(args[0]));
      return write(...args);
    };
  }
  const observeMessage = (value) => {
    if (observed && !observed.terminalRefusal) {
      observeTerminal(
        inspect(value, {
          depth: 8,
          customInspect: false,
          getters: false,
          maxArrayLength: 20,
          maxStringLength: 32768,
        }),
      );
    }
  };
  if (process.send) {
    const send = process.send.bind(process);
    process.send = (...args) => {
      observeMessage(args[0]);
      return send(...args);
    };
  }
  if (parentPort) {
    const postMessage = parentPort.postMessage.bind(parentPort);
    parentPort.postMessage = (value, ...args) => {
      observeMessage(value);
      return postMessage(value, ...args);
    };
  }
  syncBuiltinESMExports();
}

export function writeSnapshotCleanupEvidence(artifacts) {
  let summary;
  try {
    summary = summarizeSnapshotCleanupEvidence(artifacts);
  } catch (error) {
    summary = {
      version: 2,
      unknown: ["evidence-collection"],
      overflow: false,
      error: String(error.message).slice(0, 256),
    };
  }
  writeJson(path.join(artifacts, "snapshot-cleanup-evidence.json"), summary);
}

export function assertSnapshotCleanupRefusal(artifacts, updateResult, updateFailure) {
  if (!updateResult) {
    throw updateFailure ?? new Error("Published update did not settle before the fault proof");
  }
  const stdout = fs.readFileSync(path.join(artifacts, "update.stdout"), "utf8");
  const result = JSON.parse(stdout.slice(stdout.indexOf("{")));
  writeJson(path.join(artifacts, "snapshot-cleanup-result.json"), {
    exitCode: updateResult.exitCode,
    signal: updateResult.signal,
    status: result.status,
    failedDoctorStep:
      result.steps?.some(
        (step) =>
          step.name === "openclaw doctor" && Number.isInteger(step.exitCode) && step.exitCode > 0,
      ) === true,
  });
  const fixture = readJson(path.join(artifacts, fixtureName));
  const driver = readJson(path.join(artifacts, "snapshot-cleanup-driver.json"));
  assert.equal(driver.identity.commit, fixture.baseline.commit);
  const receipts = fs
    .readdirSync(artifacts)
    .filter((file) => /^snapshot-cleanup-copy-\d+-\d+\.json$/u.test(file))
    .map((file) => readJson(path.join(artifacts, file)));
  assert.equal(
    receipts.length,
    1,
    "Expected one candidate-owned fault, not an old-driver or direct helper call",
  );
  const observed = receipts[0];
  assert.equal(observed.identity.commit, fixture.candidateCommit);
  assert.equal(observed.doctor.identity.commit, fixture.candidateCommit);
  assert.equal(observed.doctor.updateInProgress, true);
  assert.equal(observed.doctor.fullPayloadVerified, true);
  const expectedPayload = hash(
    JSON.stringify(readJson(path.join(artifacts, "snapshot-cleanup-candidate-identity.json"))),
  );
  assert.equal(observed.identity.payloadSha256, expectedPayload);
  assert.equal(observed.doctor.identity.payloadSha256, expectedPayload);
  assert(observed.cleanupDenials > 0, "No real copy cleanup was refused");
  const records = snapshotEvidenceRecords(artifacts);
  const { native: selected, counts: acquisitions } = assertSelectedSnapshotAcquisitions(
    records,
    observed,
    expectedPayload,
  );
  assert.equal(
    observed.groupIncompleteAtRefusal,
    true,
    "Failed required backup group was not incomplete",
  );
  assert.equal(
    fs.existsSync(selected.binding.target),
    false,
    "Failed source was published as a verified backup",
  );
  assert.equal(selected.source, fixture.source);
  assert.equal(selected.parentPid, observed.doctor.pid);
  assert.equal(selected.operationId, observed.native.operationId);
  const marker = fs.lstatSync(selected.binding.marker, { bigint: true });
  assert(marker.isFile() && marker.size === 0n, "Failed required group lost its incomplete marker");
  assert.deepEqual(
    { dev: String(marker.dev), ino: String(marker.ino), mtimeNs: String(marker.mtimeNs) },
    selected.binding.markerIdentity,
  );
  const doctor = records.doctors.find((row) => row.pid === observed.doctor.pid);
  assert.equal(
    doctor?.result?.status,
    "error",
    "Required capture did not produce Doctor status:error",
  );
  assert.equal(
    observed.terminalRefusal,
    true,
    "Candidate did not surface terminal aggregate refusal",
  );
  assert.equal(
    observed.sourcePreservedAtRefusal,
    true,
    "Capture changed the source after the fixture writer",
  );
  assert.equal(
    observed.unpublishedAtRefusal,
    true,
    "The failed attempt was published as a snapshot",
  );
  assert(
    Number.isInteger(updateResult.exitCode) && updateResult.exitCode > 0,
    "Updater swallowed the copy refusal and returned success",
  );
  assert.equal(updateResult.signal, null, "Updater was terminated instead of reporting refusal");
  assert.equal(result.status, "error", "Updater did not publish a failed result");
  assert.equal(
    readJson(path.join(artifacts, "snapshot-cleanup-result.json")).failedDoctorStep,
    true,
    "Required Doctor failure was not a failed public step",
  );
  const publicOutput = stdout + fs.readFileSync(path.join(artifacts, "update.stderr"), "utf8");
  assert(publicOutput.includes(refusal), "Published updater omitted the candidate capture refusal");
  // Source-family hashes were compared at the producer refusal boundary,
  // before the installed updater's independent rollback/restore policy runs.
  assert.equal(
    observed.retainedAtRefusal,
    true,
    "Unresolved private scratch was not retained at refusal",
  );
  assert(selected.close && selected.closedAt, "Selected native child close was not observed");
  assert.equal(selected.close.code, 1, "Selected native worker did not exit with refusal code 1");
  assert.equal(
    selected.close.signal,
    null,
    "Native child was terminated instead of reporting refusal",
  );
  assert.equal(
    selected.retirement?.afterNativeClose,
    true,
    "Parent retirement preceded native close or was unobserved",
  );
  assert.equal(
    selected.retirement?.producerRefused,
    true,
    "Parent retirement lacks observed producer refusal",
  );
  assert.equal(
    selected.retirement?.removed,
    true,
    "Parent staging retirement did not settle failed scratch",
  );
  assert.equal(fs.existsSync(selected.stagingRoot), false);
  assert(
    !fs.existsSync(observed.staging),
    "Unpublished staging still exists after updater settlement",
  );
  const compact = summarizeSnapshotCleanupEvidence(artifacts);
  assert.equal(compact.overflow, false, "Critical snapshot evidence overflow");
  assert.deepEqual(compact.unknown, [], "Critical snapshot evidence remains unobserved");
  const proof = {
    status: "passed",
    baseline: fixture.baseline,
    candidateCommit: fixture.candidateCommit,
    updateExit: updateResult.exitCode,
    acquisitions,
    fault: { pid: observed.pid, operationId: selected.operationId },
    custody: selected.retirement,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    limitation:
      "Synthetic SQLite writer commits then exits by SIGKILL to retain WAL; filesystem EACCES is injected in a Linux container. Not Darwin or large-data proof.",
  };
  writeJson(path.join(artifacts, "snapshot-cleanup-proof.json"), proof);
  console.log("SNAPSHOT_CLEANUP_REFUSAL " + JSON.stringify(proof));
}

installFault();
