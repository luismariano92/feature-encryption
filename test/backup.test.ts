import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createJob, remoteNameFor, runBackup } from "../src/server/backup.js";
import { MAGIC } from "../src/server/crypto.js";
import { loadState } from "../src/server/manifest.js";
import { WebDavClient } from "../src/server/webdav.js";
import { startFakeDav } from "./fake-webdav.js";

let dav: Awaited<ReturnType<typeof startFakeDav>> | undefined;
afterEach(async () => {
  await dav?.close();
  dav = undefined;
});

async function setup(opts?: Parameters<typeof startFakeDav>[0]) {
  dav = await startFakeDav(opts);
  const work = await mkdtemp(path.join(tmpdir(), "backup-tool-"));
  const source = path.join(work, "Docs");
  await mkdir(path.join(source, "sub"), { recursive: true });
  await writeFile(path.join(source, "a.txt"), "alpha");
  await writeFile(path.join(source, "sub", "b.txt"), "beta");
  const stateFile = path.join(work, "state.json");
  const run = async (encryption?: { enabled: boolean; password: string }) => {
    const job = createJob([source]);
    await runBackup(job, { client: new WebDavClient({ url: dav!.url }), remoteRoot: "/backups/", stateFile, encryption });
    return job;
  };
  const remote = (rel: string) => `/dav/backups/${remoteNameFor(source)}/${rel}`;
  return { dav, source, stateFile, run, remote };
}

describe("runBackup", () => {
  it("uploads everything first, then only changed files", async () => {
    const { dav, source, run, remote } = await setup();

    const first = await run();
    expect(first).toMatchObject({ status: "done", totalFiles: 2, changedFiles: 2, uploadedFiles: 2, failed: [] });
    expect(dav.files.get(remote("a.txt"))?.toString()).toBe("alpha");
    expect(dav.files.get(remote("sub/b.txt"))?.toString()).toBe("beta");

    const second = await run();
    expect(second).toMatchObject({ status: "done", totalFiles: 2, changedFiles: 0, uploadedFiles: 0 });

    await writeFile(path.join(source, "a.txt"), "alpha, edited");
    const third = await run();
    expect(third).toMatchObject({ changedFiles: 1, uploadedFiles: 1 });
    expect(dav.files.get(remote("a.txt"))?.toString()).toBe("alpha, edited");
  });

  it("records per-file failures and retries them on the next run", async () => {
    let failB = true;
    const { stateFile, source, run } = await setup({ failPutFor: (p) => failB && p.endsWith("/b.txt") });

    const first = await run();
    expect(first.status).toBe("done");
    expect(first.uploadedFiles).toBe(1);
    expect(first.failed).toHaveLength(1);
    expect(Object.keys((await loadState(stateFile)).sources[path.resolve(source)].files)).toEqual(["a.txt"]);

    failB = false;
    const second = await run();
    expect(second).toMatchObject({ changedFiles: 1, uploadedFiles: 1, failed: [] });
  });

  it("gives same-named sources different remote folders", () => {
    expect(remoteNameFor("/one/Docs")).not.toBe(remoteNameFor("/two/Docs"));
    expect(remoteNameFor("/one/Docs")).toMatch(/^Docs-[0-9a-f]{8}$/);
  });

  it("uploads encrypted files when encryption is enabled", async () => {
    const { dav, run, remote } = await setup();
    await run({ enabled: true, password: "s3cret" });
    const uploaded = dav.files.get(remote("a.txt"))!;
    expect(uploaded.subarray(0, 4).toString()).toBe("BKUP");
  });

  it("re-uploads files when encryption setting changes", async () => {
    const { dav, run, remote } = await setup();

    const first = await run();
    expect(first).toMatchObject({ changedFiles: 2, uploadedFiles: 2 });
    expect(dav.files.get(remote("a.txt"))!.toString()).toBe("alpha");

    const second = await run({ enabled: true, password: "s3cret" });
    expect(second).toMatchObject({ changedFiles: 2, uploadedFiles: 2 });
    expect(dav.files.get(remote("a.txt"))!.subarray(0, 4).toString()).toBe("BKUP");
  });

  it("skips encryption when password is empty", async () => {
    const { dav, run, remote } = await setup();
    await run({ enabled: true, password: "" });
    expect(dav.files.get(remote("a.txt"))!.toString()).toBe("alpha");
  });

  it("encrypted field is set on job", async () => {
    const { run } = await setup();
    const plainJob = await run();
    expect(plainJob.encrypted).toBe(false);

    const encJob = await run({ enabled: true, password: "s3cret" });
    expect(encJob.encrypted).toBe(true);
  });
});
