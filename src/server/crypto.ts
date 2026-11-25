import { createReadStream } from "node:fs";
import { createCipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { PassThrough, type Readable } from "node:stream";

export const MAGIC = Buffer.from("BKUP");
export const VERSION = 0x01;
export const SALT_SIZE = 16;
export const IV_SIZE = 12;
export const AUTH_TAG_SIZE = 16;
export const HEADER_SIZE = MAGIC.length + 1 + SALT_SIZE + IV_SIZE; // 33
export const OVERHEAD = HEADER_SIZE + AUTH_TAG_SIZE; // 49

export function encryptFile(
  filePath: string,
  fileSize: number,
  password: string,
): { stream: Readable; size: number } {
  const salt = randomBytes(SALT_SIZE);
  const iv = randomBytes(IV_SIZE);
  const key = pbkdf2Sync(password, salt, 100_000, 32, "sha512");
  const cipher = createCipheriv("aes-256-gcm", key, iv);

  const header = Buffer.alloc(HEADER_SIZE);
  MAGIC.copy(header, 0);
  header[MAGIC.length] = VERSION;
  salt.copy(header, MAGIC.length + 1);
  iv.copy(header, MAGIC.length + 1 + SALT_SIZE);

  const out = new PassThrough();
  out.push(header);

  const fileStream = createReadStream(filePath);
  fileStream.on("error", (err) => out.destroy(err));
  fileStream.pipe(cipher);
  cipher.on("data", (chunk: Buffer) => out.push(chunk));
  cipher.on("end", () => {
    out.push(cipher.getAuthTag());
    out.push(null);
  });
  cipher.on("error", (err) => out.destroy(err));

  return { stream: out, size: fileSize + OVERHEAD };
}
