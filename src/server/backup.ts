import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { encryptFile } from "./crypto.js";
import { changedFiles, loadState, saveState } from "./manifest.js";
import { scanDirectory } from "./scanner.js";
import type { WebDavClient } from "./webdav.js";

export interface Job {
  id: string;
  status: "running" | "done" | "failed";
  sources: string[];
  startedAt: string;
  finishedAt?: string;
  /** Source directory currently being processed. */
  current?: string;
  totalFiles: number;
  changedFiles: number;
  uploadedFiles: number;
  uploadedBytes: number;
  /** Per-file problems; the job keeps going past them. */
  failed: { path: string; error: string }[];
  encrypted: boolean;
  /** Set only when the whole job aborted. */
  error?: string;
}

export function createJob(sources: string[]): Job {
  return {
    id: randomUUID(),
    status: "running",
    sources,
    startedAt: new Date().toISOString(),
    totalFiles: 0,
    changedFiles: 0,
    uploadedFiles: 0,
    uploadedBytes: 0,
    encrypted: false,
    failed: [],
  };
}

/**
 * Remote folder name for a local source: readable basename plus a short hash of the absolute path,
 * so two sources with the same basename (e.g. two "Documents" folders) never collide.
 */
export function remoteNameFor(source: string): string {
  const abs = path.resolve(source);
  const base = path.basename(abs).replace(/[^A-Za-z0-9._-]/g, "_") || "root";
  const key = process.platform === "win32" ? abs.toLowerCase() : abs;
  return `${base}-${createHash("sha1").update(key).digest("hex").slice(0, 8)}`;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Incremental backup: scan each source, upload only files changed since the last successful upload
 * (according to the local state file), and record each success. Mutates `job` as it goes so the
 * HTTP layer can report live progress. Remote deletions are never performed.
 */
export async function runBackup(
  job: Job,
  opts: { client: WebDavClient; remoteRoot: string; stateFile: string; encryption?: { enabled: boolean; password: string } },
): Promise<void> {
  const encrypt = opts.encryption?.enabled && opts.encryption.password ? opts.encryption : null;
  job.encrypted = Boolean(encrypt);
  const state = await loadState(opts.stateFile);
  try {
    for (const source of job.sources) {
      const abs = path.resolve(source);
      job.current = abs;
      const entry = (state.sources[abs] ??= { remoteName: remoteNameFor(abs), files: {} });
      const remoteBase = [...opts.remoteRoot.split("/"), entry.remoteName].filter(Boolean).join("/");

      const { files, skipped } = await scanDirectory(abs);
      for (const p of skipped) job.failed.push({ path: p, error: "Could not read; skipped" });
      const changed = changedFiles(files, entry.files, Boolean(encrypt));
      job.totalFiles += files.length;
      job.changedFiles += changed.length;

      await opts.client.ensureDir(remoteBase);
      for (const f of changed) {
        const remotePath = `${remoteBase}/${f.relPath}`;
        try {
          await opts.client.ensureDir(path.posix.dirname(remotePath));
          if (encrypt) {
            const { stream, size } = encryptFile(f.absPath, f.size, encrypt.password);
            await opts.client.putFile(remotePath, stream, size);
            entry.files[f.relPath] = { size: f.size, mtimeMs: f.mtimeMs, encrypted: true };
          } else {
            await opts.client.putFile(remotePath, f.absPath, f.size);
            entry.files[f.relPath] = { size: f.size, mtimeMs: f.mtimeMs };
          }
          job.uploadedFiles++;
          job.uploadedBytes += f.size;
        } catch (err) {
          job.failed.push({ path: f.absPath, error: message(err) });
        }
      }
      entry.lastRun = new Date().toISOString();
      await saveState(opts.stateFile, state);
    }
    job.status = "done";
  } catch (err) {
    job.status = "failed";
    job.error = message(err);
    await saveState(opts.stateFile, state).catch(() => {});
  } finally {
    job.current = undefined;
    job.finishedAt = new Date().toISOString();
  }
}
