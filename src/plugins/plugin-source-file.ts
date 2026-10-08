import { createHash, type Hash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { copyFileDescriptorSync, copyRootFileSync } from "@openclaw/fs-safe/advanced";
import { FsSafeError } from "@openclaw/fs-safe/errors";
import { openRootFileSync } from "../infra/boundary-file-read.js";
import {
  collectErrorGraphCandidates,
  extractErrorCode,
  formatErrorMessage,
  readErrorCauses,
} from "../infra/errors.js";
import { isGitRuntimeStagingName } from "../infra/update-runtime-staging.js";

// Git rollback trees retain links relative to their final location. Only explicit
// dependency selection may own them; incidental plugin walks must leave them alone.
export const isPluginSourceEntry = (name: string): boolean =>
  name !== "node_modules" && name !== ".git" && !isGitRuntimeStagingName(name);

// Capture and native module hooks are synchronous; no read retains this scratch buffer.
const scratch = Buffer.allocUnsafe(64 * 1024);

// fs-safe's guarded clone re-resolves both trees around every step, a fixed ~2 ms per file.
// Below one transfer chunk that cost outweighs the bytes a clone saves, so small sources copy
// straight from OpenClaw's boundary-admitted pin into an exclusive file in the private capture.
const CLONE_MIN_BYTES = scratch.length;

export const pluginSourceStatIdentity = (
  stat: fs.BigIntStats,
  identity: Pick<fs.BigIntStats, "dev" | "ino"> = stat,
): string =>
  `${identity.dev}:${identity.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;

export const pluginSourceIdentityChangedOnlyByCtime = (
  previous: string,
  current: string,
): boolean =>
  previous.slice(0, previous.lastIndexOf(":")) === current.slice(0, current.lastIndexOf(":"));

function withPluginSourceFile<T>(source: string, boundary: string, read: (fd: number) => T): T {
  const opened = openRootFileSync({
    absolutePath: source,
    rootPath: boundary,
    boundaryLabel: "plugin build source",
    rejectHardlinks: false,
  });
  if (!opened.ok) {
    throw new Error(`Cannot capture plugin source ${source}`, { cause: opened.error });
  }
  try {
    return read(opened.fd);
  } finally {
    fs.closeSync(opened.fd);
  }
}

export function pluginSourceFileIdentity(source: string, boundary: string): string {
  return withPluginSourceFile(source, boundary, (fd) =>
    pluginSourceStatIdentity(fs.fstatSync(fd, { bigint: true })),
  );
}

export function isPluginNativeExecutable(source: string, boundary: string): boolean {
  return withPluginSourceFile(source, boundary, (fd) => {
    if (fs.readSync(fd, scratch, 0, 4, 0) !== 4) {
      return false;
    }
    const magic = scratch.readUInt32BE(0);
    return (
      scratch.readUInt16BE(0) === 0x4d5a ||
      [0x7f454c46, 0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(
        magic,
      )
    );
  });
}

export function copyPluginSourceFile(
  source: string,
  boundary: string,
  target: string,
  options: { hashCopiedContent?: boolean; preserveSourceMode?: boolean } = {},
) {
  return withPluginSourceFile(source, boundary, (fd) => {
    const admitted = fs.fstatSync(fd, { bigint: true });
    const mode = options.preserveSourceMode
      ? Number(admitted.mode & 0o777n)
      : 0o600 | Number(admitted.mode & 0o100n);
    try {
      if (admitted.size < CLONE_MIN_BYTES) {
        return copyPinnedPluginSourceFile(fd, admitted, target, mode, options.hashCopiedContent);
      }
      // Keep our pin alive; fs-safe binds its own admitted open to this exact inode.
      using copied = copyRootFileSync({
        source: { rootPath: boundary, absolutePath: source },
        destination: { rootPath: path.dirname(target), absolutePath: target },
        expectedSourceIdentity: { dev: admitted.dev, ino: admitted.ino },
        clone: "auto",
        maxBytes: Number(admitted.size),
        mode,
        sourceHardlinks: "allow",
      });
      // The initial hash belongs to the copied descriptor; receipts still recheck its path.
      return options.hashCopiedContent
        ? {
            ...hashPluginSourceDescriptor(copied.fd),
            sourceIdentity: pluginSourceStatIdentity(admitted, copied.sourceIdentity),
          }
        : undefined;
    } catch (error) {
      // fs-safe wraps native failures; retain the disk-full code and detail that
      // plugin-load diagnostics use to explain how to recover.
      if (
        error instanceof FsSafeError &&
        collectErrorGraphCandidates(error, readErrorCauses).some(
          (cause) => extractErrorCode(cause) === "ENOSPC",
        )
      ) {
        throw Object.assign(new Error(formatErrorMessage(error), { cause: error }), {
          code: "ENOSPC",
        });
      }
      if (error instanceof FsSafeError && error.code === "too-large") {
        throw new Error(
          "Plugin source changed while preparing its reload; retry after the edit finishes.",
          { cause: error },
        );
      }
      throw error;
    }
  });
}

// The pin already passed root admission. Bytes come from that descriptor, so path swaps
// cannot redirect them; later receipt and source verification recheck both pathnames.
function copyPinnedPluginSourceFile(
  fd: number,
  admitted: fs.BigIntStats,
  target: string,
  mode: number,
  hashCopiedContent?: boolean,
) {
  // Exclusive creation never follows or replaces an existing entry in the private capture.
  const output = fs.openSync(target, "wx", 0o600);
  let copied: { contentHash: string; sizeBytes: number; sourceIdentity: string } | undefined;
  try {
    const content = hashCopiedContent ? createHash("sha256") : undefined;
    const sizeBytes = copyFileDescriptorSync(fd, output, {
      maxBytes: Number(admitted.size),
      onChunk: (chunk) => {
        content?.update(chunk);
      },
    });
    if (sizeBytes !== Number(admitted.size)) {
      throw new Error(
        "Plugin source changed while preparing its reload; retry after the edit finishes.",
      );
    }
    fs.fchmodSync(output, mode);
    copied = content && {
      contentHash: content.digest("hex"),
      sizeBytes,
      sourceIdentity: pluginSourceStatIdentity(admitted),
    };
  } catch (error) {
    // Windows cannot unlink a file that is still open.
    fs.closeSync(output);
    fs.rmSync(target, { force: true });
    throw error;
  }
  fs.closeSync(output);
  return copied;
}

export function linkPluginSourceFile(source: string, boundary: string, target: string): void {
  withPluginSourceFile(source, boundary, (fd) => {
    const admitted = fs.fstatSync(fd, { bigint: true });
    fs.linkSync(source, target);
    const linked = fs.statSync(target, { bigint: true });
    if (linked.dev !== admitted.dev || linked.ino !== admitted.ino) {
      throw new Error("Native plugin artifact changed during admission");
    }
  });
}

export function hashPluginSourceFile(
  source: string,
  boundary: string,
  receipt?: Hash,
  prepared?: { contentHash: string; sizeBytes: number },
) {
  return withPluginSourceFile(source, boundary, (fd) =>
    hashPluginSourceDescriptor(fd, receipt, prepared),
  );
}

function hashPluginSourceDescriptor(
  fd: number,
  receipt?: Hash,
  prepared?: { contentHash: string; sizeBytes: number },
) {
  const content = prepared ? undefined : createHash("sha256");
  const sizeBytes = prepared?.sizeBytes ?? fs.fstatSync(fd).size;
  receipt?.update(String(sizeBytes)).update("\0");
  let position = 0;
  for (;;) {
    const length = fs.readSync(
      fd,
      scratch,
      0,
      Math.min(scratch.length, sizeBytes - position + 1),
      position,
    );
    position += length;
    if (length === 0 || position > sizeBytes) {
      break;
    }
    const chunk = scratch.subarray(0, length);
    content?.update(chunk);
    receipt?.update(chunk);
  }
  if (position !== sizeBytes) {
    throw new Error(
      "Plugin source changed while preparing its reload; retry after the edit finishes.",
    );
  }
  return prepared ?? { contentHash: content!.digest("hex"), sizeBytes };
}
