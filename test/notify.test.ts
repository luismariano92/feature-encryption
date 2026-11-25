import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { Job } from "../src/server/backup.js";
import type { NtfyConfig } from "../src/server/config.js";
import { sendNtfyNotification, sendTestNotification } from "../src/server/notify.js";

interface CapturedRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

async function startFakeNtfy(opts: { statusCode?: number } = {}) {
  const requests: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      requests.push({
        method: req.method ?? "",
        path: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      res.statusCode = opts.statusCode ?? 200;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: "test-id",
    status: "done",
    sources: ["/tmp/docs"],
    startedAt: new Date(Date.now() - 5000).toISOString(),
    finishedAt: new Date().toISOString(),
    totalFiles: 10,
    changedFiles: 3,
    uploadedFiles: 3,
    uploadedBytes: 1024,
    failed: [],
    ...overrides,
  };
}

function makeConfig(server: { url: string }, overrides: Partial<NtfyConfig> = {}): NtfyConfig {
  return {
    enabled: true,
    server: server.url,
    topic: "test-topic",
    ...overrides,
  };
}

let ntfy: Awaited<ReturnType<typeof startFakeNtfy>> | undefined;
afterEach(async () => {
  await ntfy?.close();
  ntfy = undefined;
});

describe("sendNtfyNotification", () => {
  it("sends notification on successful job", async () => {
    ntfy = await startFakeNtfy();
    const config = makeConfig(ntfy);
    const job = makeJob();

    await sendNtfyNotification(config, job);

    expect(ntfy.requests).toHaveLength(1);
    const req = ntfy.requests[0];
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/test-topic");
    expect(req.headers["title"]).toBe("Backup completed");
    expect(req.headers["priority"]).toBe("default");
    expect(req.headers["tags"]).toBe("white_check_mark");
    expect(req.body).toContain("3/3 changed");
    expect(req.body).toContain("10 total");
  });

  it("sends notification on failed job with high priority", async () => {
    ntfy = await startFakeNtfy();
    const config = makeConfig(ntfy);
    const job = makeJob({ status: "failed", error: "Connection lost" });

    await sendNtfyNotification(config, job);

    expect(ntfy.requests).toHaveLength(1);
    const req = ntfy.requests[0];
    expect(req.headers["title"]).toBe("Backup failed");
    expect(req.headers["priority"]).toBe("high");
    expect(req.headers["tags"]).toBe("x");
    expect(req.body).toContain("Connection lost");
  });

  it("sends notification on partial failure", async () => {
    ntfy = await startFakeNtfy();
    const config = makeConfig(ntfy);
    const job = makeJob({
      status: "done",
      uploadedFiles: 2,
      failed: [
        { path: "/tmp/docs/bad.txt", error: "Permission denied" },
      ],
    });

    await sendNtfyNotification(config, job);

    expect(ntfy.requests).toHaveLength(1);
    const req = ntfy.requests[0];
    expect(req.headers["title"]).toBe("Backup completed with errors");
    expect(req.headers["priority"]).toBe("high");
    expect(req.headers["tags"]).toBe("warning");
    expect(req.body).toContain("Failed files: 1");
  });

  it("includes Authorization header when token is configured", async () => {
    ntfy = await startFakeNtfy();
    const config = makeConfig(ntfy, { token: "tk_secret123" });
    const job = makeJob();

    await sendNtfyNotification(config, job);

    expect(ntfy.requests).toHaveLength(1);
    expect(ntfy.requests[0].headers["authorization"]).toBe("Bearer tk_secret123");
  });

  it("omits Authorization header when token is empty", async () => {
    ntfy = await startFakeNtfy();
    const config = makeConfig(ntfy, { token: undefined });
    const job = makeJob();

    await sendNtfyNotification(config, job);

    expect(ntfy.requests).toHaveLength(1);
    expect(ntfy.requests[0].headers["authorization"]).toBeUndefined();
  });

  it("does nothing when enabled is false", async () => {
    ntfy = await startFakeNtfy();
    const config = makeConfig(ntfy, { enabled: false });
    const job = makeJob();

    await sendNtfyNotification(config, job);

    expect(ntfy.requests).toHaveLength(0);
  });

  it("does nothing when topic is empty", async () => {
    ntfy = await startFakeNtfy();
    const config = makeConfig(ntfy, { topic: "" });
    const job = makeJob();

    await sendNtfyNotification(config, job);

    expect(ntfy.requests).toHaveLength(0);
  });

  it("swallows errors from server 500 response", async () => {
    ntfy = await startFakeNtfy({ statusCode: 500 });
    const config = makeConfig(ntfy);
    const job = makeJob();

    await expect(sendNtfyNotification(config, job)).resolves.toBeUndefined();
    expect(ntfy.requests).toHaveLength(1);
  });
});

describe("sendTestNotification", () => {
  it("sends correct test notification content", async () => {
    ntfy = await startFakeNtfy();
    const config = makeConfig(ntfy);

    const result = await sendTestNotification(config);

    expect(result).toEqual({ ok: true });
    expect(ntfy.requests).toHaveLength(1);
    const req = ntfy.requests[0];
    expect(req.path).toBe("/test-topic");
    expect(req.headers["title"]).toBe("Backup tool test");
    expect(req.body).toBe("Backup tool notification test");
  });

  it("returns error when not configured", async () => {
    const config: NtfyConfig = { enabled: false, server: "http://localhost", topic: "" };
    const result = await sendTestNotification(config);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not configured");
  });

  it("returns error on server failure", async () => {
    ntfy = await startFakeNtfy({ statusCode: 500 });
    const config = makeConfig(ntfy);

    const result = await sendTestNotification(config);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("500");
  });
});
