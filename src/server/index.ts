import { stat, readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJob, runBackup, type Job } from "./backup.js";
import { isAllowed, listDirs, listRoots } from "./browse.js";
import { loadConfig } from "./config.js";
import { Scheduler, type JobRegistry } from "./scheduler.js";
import { WebDavClient } from "./webdav.js";

// Same relative location from src/server (tsx) and dist/server (compiled).
const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../public");
const MAX_BODY = 1024 * 1024;
const MAX_JOBS_KEPT = 20;
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

const config = loadConfig();
const jobRegistry: JobRegistry = { active: null, jobs: new Map<string, Job>() };

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, "Request body too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

async function requireAllowedDir(p: string): Promise<string> {
  const abs = path.resolve(p);
  if (!path.isAbsolute(p)) throw new HttpError(400, `Not an absolute path: ${p}`);
  if (!isAllowed(abs, config.browseRoots)) throw new HttpError(403, `Outside the allowed roots: ${abs}`);
  const st = await stat(abs).catch(() => null);
  if (!st?.isDirectory()) throw new HttpError(400, `Not a directory: ${abs}`);
  return abs;
}

function validateScheduleBody(body: Record<string, unknown>): {
  name: string; paths: string[]; time: string;
  recurrence: "once" | "daily" | "weekly";
  daysOfWeek?: number[]; enabled: boolean;
} {
  if (typeof body.name !== "string" || body.name.length === 0 || body.name.length > 200) {
    throw new HttpError(400, "name must be a non-empty string (max 200 chars)");
  }
  if (!Array.isArray(body.paths) || body.paths.length === 0 || !body.paths.every((p) => typeof p === "string")) {
    throw new HttpError(400, "paths must be a non-empty string array");
  }
  if (typeof body.time !== "string" || !/^\d{2}:\d{2}$/.test(body.time)) {
    throw new HttpError(400, "time must be HH:MM format");
  }
  const [h, m] = body.time.split(":").map(Number);
  if (h < 0 || h > 23 || m < 0 || m > 59) {
    throw new HttpError(400, "time has invalid hour or minute");
  }
  if (body.recurrence !== "once" && body.recurrence !== "daily" && body.recurrence !== "weekly") {
    throw new HttpError(400, "recurrence must be once, daily, or weekly");
  }
  let daysOfWeek: number[] | undefined;
  if (body.recurrence === "daily") {
    if (!Array.isArray(body.daysOfWeek) || body.daysOfWeek.length === 0 ||
        !body.daysOfWeek.every((d) => typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 6)) {
      throw new HttpError(400, "daysOfWeek must be a non-empty array of integers 0-6 when recurrence is daily");
    }
    daysOfWeek = body.daysOfWeek as number[];
  } else if (body.daysOfWeek !== undefined) {
    if (Array.isArray(body.daysOfWeek) && body.daysOfWeek.every((d) => typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 6)) {
      daysOfWeek = body.daysOfWeek as number[];
    }
  }
  const enabled = body.enabled !== false;
  return { name: body.name, paths: body.paths as string[], time: body.time, recurrence: body.recurrence, daysOfWeek, enabled };
}

async function triggerBackup(paths: string[]): Promise<Job> {
  const job = createJob(paths);
  jobRegistry.jobs.set(job.id, job);
  for (const id of [...jobRegistry.jobs.keys()].slice(0, Math.max(0, jobRegistry.jobs.size - MAX_JOBS_KEPT))) jobRegistry.jobs.delete(id);
  jobRegistry.active = job;
  const client = new WebDavClient(config.webdav);
  await runBackup(job, { client, remoteRoot: config.webdav.remoteRoot, stateFile: config.stateFile, encryption: config.encryption });
  jobRegistry.active = null;
  return job;
}

const scheduler = new Scheduler({
  schedulesFile: config.schedulesFile,
  jobRegistry,
  runBackupFn: triggerBackup,
});
void scheduler.start();

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  const route = `${req.method} ${url.pathname}`;

  if (route === "GET /api/status") {
    return sendJson(res, 200, {
      configured: Boolean(config.webdav.url),
      webdavUrl: config.webdav.url,
      remoteRoot: config.webdav.remoteRoot,
      activeJobId: jobRegistry.active?.id ?? null,
      encryption: {
        enabled: config.encryption.enabled,
        configured: Boolean(config.encryption.password),
      },
    });
  }

  if (route === "GET /api/check") {
    if (!config.webdav.url) throw new HttpError(400, "WebDAV is not configured");
    try {
      const status = await new WebDavClient(config.webdav).check();
      return sendJson(res, 200, { ok: status === 207 || status === 200, status });
    } catch (err) {
      return sendJson(res, 200, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (route === "GET /api/browse") {
    const p = url.searchParams.get("path");
    if (!p) {
      const dirs = listRoots(config.browseRoots).map((r) => ({ name: r, path: r }));
      return sendJson(res, 200, { path: null, parent: null, dirs });
    }
    const abs = await requireAllowedDir(p);
    const parentPath = path.dirname(abs);
    const parent = parentPath !== abs && isAllowed(parentPath, config.browseRoots) ? parentPath : null;
    return sendJson(res, 200, { path: abs, parent, dirs: await listDirs(abs) });
  }

  if (route === "POST /api/backup") {
    if (!config.webdav.url) throw new HttpError(400, "WebDAV is not configured");
    if (jobRegistry.active) throw new HttpError(409, "A backup is already running");
    const body = (await readJson(req)) as { paths?: unknown };
    if (!Array.isArray(body.paths) || body.paths.length === 0 || !body.paths.every((p) => typeof p === "string")) {
      throw new HttpError(400, "Expected { paths: string[] } with at least one path");
    }
    const sources: string[] = [];
    for (const p of body.paths as string[]) sources.push(await requireAllowedDir(p));

    const job = createJob(sources);
    jobRegistry.jobs.set(job.id, job);
    for (const id of [...jobRegistry.jobs.keys()].slice(0, Math.max(0, jobRegistry.jobs.size - MAX_JOBS_KEPT))) jobRegistry.jobs.delete(id);
    jobRegistry.active = job;
    const client = new WebDavClient(config.webdav);
    void runBackup(job, { client, remoteRoot: config.webdav.remoteRoot, stateFile: config.stateFile, encryption: config.encryption }).finally(() => {
      jobRegistry.active = null;
    });
    return sendJson(res, 202, { jobId: job.id });
  }

  const jobMatch = /^\/api\/jobs\/([\w-]+)$/.exec(url.pathname);
  if (req.method === "GET" && jobMatch) {
    const job = jobRegistry.jobs.get(jobMatch[1]);
    if (!job) throw new HttpError(404, "Unknown job");
    return sendJson(res, 200, job);
  }

  // --- Schedule routes ---

  if (route === "GET /api/schedules") {
    return sendJson(res, 200, scheduler.list());
  }

  const scheduleMatch = /^\/api\/schedules\/([\w-]+)$/.exec(url.pathname);
  const scheduleRunMatch = /^\/api\/schedules\/([\w-]+)\/run$/.exec(url.pathname);

  if (req.method === "POST" && scheduleRunMatch) {
    const s = scheduler.get(scheduleRunMatch[1]);
    if (!s) throw new HttpError(404, "Unknown schedule");
    if (!config.webdav.url) throw new HttpError(400, "WebDAV is not configured");
    if (jobRegistry.active) throw new HttpError(409, "A backup is already running");
    const sources: string[] = [];
    for (const p of s.paths) sources.push(await requireAllowedDir(p));
    const job = createJob(sources);
    jobRegistry.jobs.set(job.id, job);
    jobRegistry.active = job;
    const client = new WebDavClient(config.webdav);
    void runBackup(job, { client, remoteRoot: config.webdav.remoteRoot, stateFile: config.stateFile, encryption: config.encryption }).finally(() => {
      jobRegistry.active = null;
    });
    return sendJson(res, 202, { jobId: job.id });
  }

  if (req.method === "GET" && scheduleMatch) {
    const s = scheduler.get(scheduleMatch[1]);
    if (!s) throw new HttpError(404, "Unknown schedule");
    return sendJson(res, 200, s);
  }

  if (req.method === "POST" && url.pathname === "/api/schedules") {
    const body = await readJson(req) as Record<string, unknown>;
    const { name, paths, time, recurrence, daysOfWeek, enabled } = validateScheduleBody(body);
    for (const p of paths) await requireAllowedDir(p);
    const s = await scheduler.add({ name, paths, time, recurrence, daysOfWeek, enabled });
    return sendJson(res, 201, s);
  }

  if (req.method === "PUT" && scheduleMatch) {
    const body = await readJson(req) as Record<string, unknown>;
    const data = validateScheduleBody(body);
    for (const p of data.paths) await requireAllowedDir(p);
    const s = await scheduler.update(scheduleMatch[1], data);
    if (!s) throw new HttpError(404, "Unknown schedule");
    return sendJson(res, 200, s);
  }

  if (req.method === "DELETE" && scheduleMatch) {
    const removed = await scheduler.remove(scheduleMatch[1]);
    if (!removed) throw new HttpError(404, "Unknown schedule");
    res.writeHead(204);
    return void res.end();
  }

  throw new HttpError(404, "Not found");
}

async function serveStatic(res: http.ServerResponse, pathname: string): Promise<void> {
  const rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(404, "Not found");
  const data = await readFile(file).catch(() => {
    throw new HttpError(404, "Not found");
  });
  res.writeHead(200, { "Content-Type": CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream" });
  res.end(data);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    if (url.pathname.startsWith("/api/")) await handleApi(req, res, url);
    else if (req.method === "GET") await serveStatic(res, url.pathname);
    else throw new HttpError(405, "Method not allowed");
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
    else res.end();
  }
});

server.listen(config.port, config.host, () => {
  console.log(`Backup tool running at http://${config.host}:${config.port}`);
  if (!config.webdav.url) console.warn("WebDAV is not configured: copy backup.config.example.json to backup.config.json.");
  if (config.encryption.enabled && !config.encryption.password) console.warn("Encryption is enabled but no password is set; backups will not be encrypted.");
  if (config.host !== "127.0.0.1" && config.host !== "localhost") {
    console.warn("Warning: the server is reachable from other machines and can read and upload local folders.");
  }
});
