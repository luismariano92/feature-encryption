import { createReadStream } from "node:fs";
import http from "node:http";
import https from "node:https";
import type { Readable } from "node:stream";

export interface WebDavOptions {
  url: string;
  username?: string;
  password?: string;
}

/**
 * Minimal WebDAV client: only what a backup needs (MKCOL, PUT, PROPFIND for a connection check).
 * Uses node:http(s) directly so uploads stream from disk instead of being buffered in memory.
 * Remote paths are "/"-separated and relative to the base URL.
 */
export class WebDavClient {
  private readonly base: URL;
  private readonly auth?: string;
  /** Collections already created or confirmed in this client's lifetime (one client per job). */
  private readonly knownDirs = new Set<string>();

  constructor(opts: WebDavOptions) {
    this.base = new URL(opts.url.endsWith("/") ? opts.url : `${opts.url}/`);
    if (opts.username) {
      this.auth = `Basic ${Buffer.from(`${opts.username}:${opts.password ?? ""}`).toString("base64")}`;
    }
  }

  urlFor(remotePath: string, isDir = false): URL {
    const segs = remotePath.split("/").filter(Boolean).map(encodeURIComponent);
    return new URL(segs.join("/") + (isDir && segs.length ? "/" : ""), this.base);
  }

  /** PROPFIND the base URL. Returns the HTTP status (207 means the server is reachable and authorized). */
  async check(): Promise<number> {
    return this.request("PROPFIND", this.base, { headers: { Depth: "0" } });
  }

  /** Creates every missing collection along `dir`, like `mkdir -p`. */
  async ensureDir(dir: string): Promise<void> {
    let current = "";
    for (const seg of dir.split("/").filter(Boolean)) {
      current = current ? `${current}/${seg}` : seg;
      if (this.knownDirs.has(current)) continue;
      const url = this.urlFor(current, true);
      const status = await this.request("MKCOL", url);
      // 201 Created, 405 Method Not Allowed = collection already exists.
      if (status !== 201 && status !== 405) throw new Error(`MKCOL ${url.pathname} failed: HTTP ${status}`);
      this.knownDirs.add(current);
    }
  }

  async putFile(remotePath: string, localPath: string | Readable, size: number): Promise<void> {
    const url = this.urlFor(remotePath);
    const body = typeof localPath === "string" ? createReadStream(localPath) : localPath;
    const status = await this.request("PUT", url, {
      headers: { "Content-Length": size, "Content-Type": "application/octet-stream" },
      body,
    });
    if (status < 200 || status >= 300) throw new Error(`PUT ${url.pathname} failed: HTTP ${status}`);
  }

  private request(
    method: string,
    url: URL,
    opts: { headers?: Record<string, string | number>; body?: Readable } = {},
  ): Promise<number> {
    return new Promise((resolve, reject) => {
      const lib = url.protocol === "https:" ? https : http;
      const headers = { ...(this.auth ? { Authorization: this.auth } : {}), ...opts.headers };
      const req = lib.request(url, { method, headers }, (res) => {
        res.resume(); // drain the body; only the status matters
        res.on("end", () => resolve(res.statusCode ?? 0));
        res.on("error", reject);
      });
      req.on("error", reject);
      if (opts.body) {
        opts.body.on("error", (err) => req.destroy(err));
        opts.body.pipe(req);
      } else {
        req.end();
      }
    });
  }
}
