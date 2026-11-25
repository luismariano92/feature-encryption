import http from "node:http";
import https from "node:https";
import type { NtfyConfig } from "./config.js";
import type { Job } from "./backup.js";

function buildMessage(job: Job): { title: string; body: string; priority: string; tags: string } {
  const duration = job.finishedAt && job.startedAt
    ? Math.round((new Date(job.finishedAt).getTime() - new Date(job.startedAt).getTime()) / 1000)
    : 0;
  const durationStr = duration >= 60 ? `${Math.floor(duration / 60)}m ${duration % 60}s` : `${duration}s`;

  const isFailed = job.status === "failed";
  const hasPartialFailures = job.failed.length > 0 && job.status === "done";

  let title: string;
  let priority: string;
  let tags: string;

  if (isFailed) {
    title = "Backup failed";
    priority = "high";
    tags = "x";
  } else if (hasPartialFailures) {
    title = "Backup completed with errors";
    priority = "high";
    tags = "warning";
  } else {
    title = "Backup completed";
    priority = "default";
    tags = "white_check_mark";
  }

  const lines: string[] = [];
  lines.push(`Files: ${job.uploadedFiles}/${job.changedFiles} changed, ${job.totalFiles} total`);
  lines.push(`Transferred: ${formatBytes(job.uploadedBytes)}`);
  lines.push(`Duration: ${durationStr}`);
  if (isFailed && job.error) {
    lines.push(`Error: ${job.error}`);
  }
  if (job.failed.length > 0) {
    lines.push(`Failed files: ${job.failed.length}`);
    for (const f of job.failed.slice(0, 5)) {
      lines.push(`  - ${f.path}: ${f.error}`);
    }
    if (job.failed.length > 5) lines.push(`  ... and ${job.failed.length - 5} more`);
  }

  return { title, body: lines.join("\n"), priority, tags };
}

function formatBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function post(
  serverUrl: string,
  topic: string,
  headers: Record<string, string>,
  body: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${serverUrl}/${topic}`);
    const transport = url.protocol === "https:" ? https : http;
    const req = transport.request(
      url,
      { method: "POST", headers: { ...headers, "Content-Type": "text/plain" } },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.setTimeout(10_000, () => {
      req.destroy(new Error("Notification request timed out"));
    });
    req.on("error", reject);
    req.end(body);
  });
}

export async function sendNtfyNotification(config: NtfyConfig, job: Job): Promise<void> {
  if (!config.enabled || !config.topic) return;
  try {
    const { title, body, priority, tags } = buildMessage(job);
    const headers: Record<string, string> = {
      Title: title,
      Priority: priority,
      Tags: tags,
    };
    if (config.token) {
      headers["Authorization"] = `Bearer ${config.token}`;
    }
    await post(config.server, config.topic, headers, body);
  } catch (err) {
    console.error("Failed to send ntfy notification:", err instanceof Error ? err.message : err);
  }
}

export async function sendTestNotification(
  config: NtfyConfig,
): Promise<{ ok: boolean; error?: string }> {
  if (!config.enabled || !config.topic) {
    return { ok: false, error: "Notifications are not configured" };
  }
  try {
    const headers: Record<string, string> = {
      Title: "Backup tool test",
      Tags: "test_tube",
    };
    if (config.token) {
      headers["Authorization"] = `Bearer ${config.token}`;
    }
    const status = await post(config.server, config.topic, headers, "Backup tool notification test");
    if (status >= 200 && status < 300) return { ok: true };
    return { ok: false, error: `Server responded with HTTP ${status}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
