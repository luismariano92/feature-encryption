import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AUTH_TAG_SIZE,
  HEADER_SIZE,
  IV_SIZE,
  MAGIC,
  OVERHEAD,
  SALT_SIZE,
  VERSION,
  encryptFile,
} from "../src/server/crypto.js";

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function decrypt(encrypted: Buffer, password: string): Buffer {
  const salt = encrypted.subarray(MAGIC.length + 1, MAGIC.length + 1 + SALT_SIZE);
  const iv = encrypted.subarray(MAGIC.length + 1 + SALT_SIZE, HEADER_SIZE);
  const authTag = encrypted.subarray(encrypted.length - AUTH_TAG_SIZE);
  const ciphertext = encrypted.subarray(HEADER_SIZE, encrypted.length - AUTH_TAG_SIZE);
  const key = pbkdf2Sync(password, salt, 100_000, 32, "sha512");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

describe("encryptFile", () => {
  let tmpDir: string;

  async function makeTmp(name: string, content: string): Promise<{ filePath: string; size: number }> {
    if (!tmpDir) tmpDir = await mkdtemp(path.join(tmpdir(), "crypto-test-"));
    const filePath = path.join(tmpDir, name);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content);
    return { filePath, size: Buffer.byteLength(content) };
  }

  it("output starts with BKUP magic header", async () => {
    const { filePath, size } = await makeTmp("magic.txt", "hello");
    const { stream } = encryptFile(filePath, size, "pass");
    const buf = await collect(stream);
    expect(buf.subarray(0, 4).toString()).toBe("BKUP");
  });

  it("encrypted output size equals originalSize + OVERHEAD", async () => {
    const { filePath, size } = await makeTmp("size.txt", "hello world");
    const { stream, size: reportedSize } = encryptFile(filePath, size, "pass");
    const buf = await collect(stream);
    expect(reportedSize).toBe(size + OVERHEAD);
    expect(buf.length).toBe(size + OVERHEAD);
  });

  it("round-trip: encrypt then decrypt matches original", async () => {
    const content = "The quick brown fox jumps over the lazy dog";
    const { filePath, size } = await makeTmp("round.txt", content);
    const { stream } = encryptFile(filePath, size, "secret");
    const encrypted = await collect(stream);
    const decrypted = decrypt(encrypted, "secret");
    expect(decrypted.toString()).toBe(content);
  });

  it("different files produce different salts/IVs", async () => {
    const { filePath: f1, size: s1 } = await makeTmp("a.txt", "aaa");
    const { filePath: f2, size: s2 } = await makeTmp("b.txt", "aaa");
    const buf1 = await collect(encryptFile(f1, s1, "pass").stream);
    const buf2 = await collect(encryptFile(f2, s2, "pass").stream);
    const salt1 = buf1.subarray(MAGIC.length + 1, MAGIC.length + 1 + SALT_SIZE);
    const salt2 = buf2.subarray(MAGIC.length + 1, MAGIC.length + 1 + SALT_SIZE);
    const iv1 = buf1.subarray(MAGIC.length + 1 + SALT_SIZE, HEADER_SIZE);
    const iv2 = buf2.subarray(MAGIC.length + 1 + SALT_SIZE, HEADER_SIZE);
    expect(Buffer.compare(salt1, salt2) !== 0 || Buffer.compare(iv1, iv2) !== 0).toBe(true);
  });

  it("wrong password fails decryption", async () => {
    const { filePath, size } = await makeTmp("wrong.txt", "secret data");
    const { stream } = encryptFile(filePath, size, "correct");
    const encrypted = await collect(stream);
    expect(() => decrypt(encrypted, "wrong")).toThrow();
  });

  it("empty file encryption produces exactly OVERHEAD bytes", async () => {
    const { filePath, size } = await makeTmp("empty.txt", "");
    const { stream, size: reportedSize } = encryptFile(filePath, size, "pass");
    const buf = await collect(stream);
    expect(reportedSize).toBe(OVERHEAD);
    expect(buf.length).toBe(OVERHEAD);
  });

  it("version byte is 0x01", async () => {
    const { filePath, size } = await makeTmp("ver.txt", "v");
    const { stream } = encryptFile(filePath, size, "pass");
    const buf = await collect(stream);
    expect(buf[MAGIC.length]).toBe(VERSION);
  });
});
