import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export interface WebDavConfig {
  url: string;
  username: string;
  password: string;
  /** Folder on the WebDAV server (relative to `url`) that all backups go under. */
  remoteRoot: string;
}

export interface NtfyConfig {
  enabled: boolean;
  server: string;
  topic: string;
  token?: string;
}

export interface Config {
  host: string;
  port: number;
  webdav: WebDavConfig;
  /** If non-empty, the UI may only browse and back up directories inside these roots. */
  browseRoots: string[];
  /** Local JSON file recording what has already been uploaded (drives incremental backups). */
  stateFile: string;
  /** Local JSON file storing scheduled backup definitions. */
  schedulesFile: string;
  ntfy: NtfyConfig;
}

interface RawConfig {
  host?: string;
  port?: number;
  webdav?: Partial<WebDavConfig>;
  browseRoots?: string[];
  stateFile?: string;
  schedulesFile?: string;
  ntfy?: Partial<NtfyConfig>;
}

/**
 * Loads `backup.config.json` (or the file named by BACKUP_CONFIG). A missing file is allowed:
 * the server still starts and the UI reports that WebDAV is not configured.
 * WEBDAV_URL / WEBDAV_USERNAME / WEBDAV_PASSWORD / PORT environment variables override the file.
 */
export function loadConfig(file = process.env.BACKUP_CONFIG ?? "backup.config.json"): Config {
  const raw: RawConfig = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const dav = raw.webdav ?? {};
  const ntfyRaw = raw.ntfy ?? {};

  const ntfyServer = process.env.NTFY_SERVER ?? ntfyRaw.server ?? "https://ntfy.sh";
  if (!/^https?:\/\//.test(ntfyServer)) {
    throw new Error(`Invalid ntfy server URL: must start with http:// or https://`);
  }
  const ntfyTopic = process.env.NTFY_TOPIC ?? ntfyRaw.topic ?? "";
  if (ntfyTopic && !/^[a-zA-Z0-9_-]+$/.test(ntfyTopic)) {
    throw new Error(`Invalid ntfy topic: only alphanumeric, hyphens, and underscores are allowed`);
  }

  return {
    host: raw.host ?? "127.0.0.1",
    port: Number(process.env.PORT ?? raw.port ?? 3000),
    webdav: {
      url: process.env.WEBDAV_URL ?? dav.url ?? "",
      username: process.env.WEBDAV_USERNAME ?? dav.username ?? "",
      password: process.env.WEBDAV_PASSWORD ?? dav.password ?? "",
      remoteRoot: dav.remoteRoot ?? "backups",
    },
    browseRoots: (raw.browseRoots ?? []).map((p) => path.resolve(p)),
    stateFile: path.resolve(raw.stateFile ?? ".backup-state.json"),
    schedulesFile: path.resolve(raw.schedulesFile ?? "backup-schedules.json"),
    ntfy: {
      enabled: process.env.NTFY_ENABLED === "true" || (process.env.NTFY_ENABLED === undefined && ntfyRaw.enabled === true),
      server: ntfyServer,
      topic: ntfyTopic,
      token: process.env.NTFY_TOKEN ?? ntfyRaw.token ?? undefined,
    },
  };
}
