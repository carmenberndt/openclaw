import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const read = (root, name) => JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
export function createSnapshotAcquisitionRecorder(root, { identity, pid, threadId, operationId }) {
  const acquisitions = [];
  return (directory) => {
    acquisitions.push({
      directory,
      at: String(process.hrtime.bigint()),
      operationId: operationId(),
    });
    fs.writeFileSync(
      path.join(root, "snapshot-cleanup-attempts-" + pid + "-" + threadId + ".json"),
      JSON.stringify({ pid, threadId, identity, acquisitions }),
      { mode: 0o600 },
    );
  };
}

export function snapshotEvidenceRecords(root) {
  const names = fs.readdirSync(root).toSorted();
  const rows = (pattern) =>
    names.filter((name) => pattern.test(name)).map((name) => read(root, name));
  return {
    copies: rows(/^snapshot-cleanup-copy-\d+-\d+\.json$/u),
    natives: rows(/^snapshot-cleanup-native-[0-9a-f]{64}\.json$/u),
    attempts: rows(/^snapshot-cleanup-attempts-\d+-\d+\.json$/u),
    doctors: rows(/^snapshot-cleanup-doctor-\d+\.json$/u),
  };
}

function snapshotAcquisitionSummary(records, selected) {
  const counts = { selected: 0, unselectedBefore: 0, unselectedAfter: 0, unknown: 0 };
  const digest = createHash("sha256");
  const directories = [];
  for (const attempt of records.attempts) {
    if (!Array.isArray(attempt.acquisitions)) {
      counts.unknown += attempt.directories?.length ?? 1;
      continue;
    }
    for (const entry of attempt.acquisitions) {
      digest.update(JSON.stringify([attempt.pid, attempt.threadId, entry]) + "\n");
      if (selected?.native?.operationId && entry.operationId === selected.native.operationId) {
        counts.selected++;
        directories.push(entry.directory);
      } else if (/^\d+$/u.test(entry.at ?? "") && /^\d+$/u.test(selected?.injectedAt ?? "")) {
        counts[
          BigInt(entry.at) < BigInt(selected.injectedAt) ? "unselectedBefore" : "unselectedAfter"
        ]++;
      } else {
        counts.unknown++;
      }
    }
  }
  return { ...counts, digest: digest.digest("hex"), directories };
}

export function summarizeSnapshotCleanupEvidence(root) {
  const records = snapshotEvidenceRecords(root);
  const fault = records.copies.length === 1 ? records.copies[0] : undefined;
  const native =
    fault && records.natives.find((row) => row.stagingRoot === fault.native?.stagingRoot);
  const doctor = fault && records.doctors.find((row) => row.pid === fault.doctor?.pid);
  const optional = (name) => (fs.existsSync(path.join(root, name)) ? read(root, name) : undefined);
  const fixture = optional("snapshot-cleanup-fixture.json");
  const outer = optional("snapshot-cleanup-result.json");
  const acquisitions = snapshotAcquisitionSummary(records, fault);
  const unknown = [];
  if (!fault) {
    unknown.push("selected-fault");
  }
  if (!native?.binding) {
    unknown.push("native-request-binding");
  }
  if (!native?.close) {
    unknown.push("native-close");
  }
  if (!native?.retirement) {
    unknown.push("parent-retirement");
  }
  if (!doctor?.result) {
    unknown.push("doctor-result");
  }
  if (!outer) {
    unknown.push("outer-result");
  }
  if (acquisitions.unknown) {
    unknown.push("acquisition-order");
  }
  const identity = fault?.identity;
  const binding = native?.binding;
  // Critical facts lead; repeated paths, inventories and unselected rows stay private.
  const result = {
    version: 2,
    fault: fault && {
      pid: fault.pid,
      threadId: fault.threadId,
      operationId: native?.operationId,
      request: native?.request,
      writer: fault.writer,
      cleanupDenials: fault.cleanupDenials,
      terminalRefusal: fault.terminalRefusal,
      retainedAtRefusal: fault.retainedAtRefusal,
      failure: fault.failure && {
        sha256: fault.failure.sha256,
        excerpt: fault.failure.message.slice(-192),
        excerptOmitted: fault.failure.message.length > 192 || fault.failure.truncated,
      },
      sourcePreservedAtRefusal: fault.sourcePreservedAtRefusal,
      sourceFamily: fault.afterWriter,
      unpublishedAtRefusal: fault.unpublishedAtRefusal,
      groupIncompleteAtRefusal: fault.groupIncompleteAtRefusal,
      innerRemoved: fault.removed,
    },
    doctor: doctor && {
      pid: doctor.pid,
      start: doctor.start,
      fullPayloadVerified: doctor.fullPayloadVerified,
      updateInProgress: doctor.updateInProgress,
      result: doctor.result && {
        status: doctor.result.status,
        sha256: doctor.result.sha256,
        failureFactCount: doctor.result.failureFacts?.length ?? 0,
      },
    },
    outer,
    custody: native && { child: native.pid, close: native.close, retirement: native.retirement },
    acquisitions: { ...acquisitions, directories: undefined },
    binding: binding && {
      sourceIdentity: binding.sourceIdentity,
      sourceSha256: hash(binding.source),
      targetSha256: hash(binding.target),
      stagingRootSha256: hash(native.stagingRoot),
      markerIdentity: binding.markerIdentity,
      owner: binding.owner,
      snapshot: binding.snapshot,
    },
    identity: identity && {
      commit: identity.commit,
      entrypoint: identity.entrypoint,
      entrypointSha256: identity.entrypointSha256,
      manifestSha256: identity.manifestSha256,
      buildInfoSha256: identity.buildInfoSha256,
      payloadSha256: identity.payloadSha256,
    },
    baseline: fixture?.baseline,
    candidate: optional("snapshot-cleanup-candidate.json"),
    inventoryOmitted: true,
    unknown,
    overflow: false,
  };
  // Bound the JSON-string representation, which the existing host publisher caps.
  if (Buffer.byteLength(JSON.stringify(JSON.stringify(result))) > 7 * 1024) {
    return {
      version: 2,
      overflow: true,
      unknown: ["critical-summary-overflow"],
      digest: hash(JSON.stringify(result)),
    };
  }
  return result;
}

export function assertSelectedSnapshotAcquisitions(records, observed, expectedPayload) {
  assert(
    observed.native?.binding && observed.native.operationId,
    "Fault lacks required caller binding",
  );
  const selected = records.natives.filter((row) => row.operationId === observed.native.operationId);
  assert.equal(selected.length, 1, "Selected operation launched another native capture");
  assert.equal(selected[0].pid, observed.pid, "Fault does not belong to the selected native child");
  for (const row of records.attempts) {
    assert.equal(row.identity.payloadSha256, expectedPayload);
    assert.equal(row.identity.commit, observed.identity.commit);
  }
  const counts = snapshotAcquisitionSummary(records, observed);
  assert.equal(counts.unknown, 0, "Unobserved acquisition identity or ordering");
  assert.deepEqual(
    counts.directories,
    [observed.staging],
    "Selected operation reacquired the source",
  );
  return { native: selected[0], counts };
}
