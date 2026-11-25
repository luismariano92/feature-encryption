import { readFile, rename, writeFile } from "node:fs/promises";
import type { FileEntry } from "./scanner.js";

export interface FileRecord {
  size: number;
  mtimeMs: number;
  encrypted?: boolean;
}

export interface SourceState {
  /** Folder name used on the WebDAV server for this source (see remoteNameFor). */
  remoteName: string;
  /** relPath -> what was last uploaded successfully. */
  files: Record<string, FileRecord>;
  lastRun?: string;
}

export interface BackupState {
  version: 1;
  /** Keyed by the absolute local source directory. */
  sources: Record<string, SourceState>;
}

export async function loadState(file: string): Promise<BackupState> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as BackupState;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, sources: {} };
    throw err;
  }
}

/** Writes via a temp file + rename so a crash never leaves a half-written state file. */
export async function saveState(file: string, state: BackupState): Promise<void> {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2));
  await rename(tmp, file);
}

/** Files that are new, whose size or mtime differ, or whose encryption status changed. */
export function changedFiles(files: FileEntry[], previous: Record<string, FileRecord>, encrypted?: boolean): FileEntry[] {
  return files.filter((f) => {
    const prev = previous[f.relPath];
    if (!prev) return true;
    if (prev.size !== f.size || prev.mtimeMs !== f.mtimeMs) return true;
    return Boolean(prev.encrypted) !== Boolean(encrypted);
  });
}
