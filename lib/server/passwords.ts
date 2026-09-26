import { randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";
import { ApiError } from "./http";

const OPTIONS = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const state = globalThis as typeof globalThis & { __comicPasswordHashes?: number };
const encode = (salt: Buffer, key: Buffer) => `scrypt$32768$8$3$${salt.toString("base64url")}$${key.toString("base64url")}`;
const DUMMY = encode(Buffer.alloc(16), Buffer.alloc(64));

export function validatePassword(value: unknown): string {
  if (typeof value !== "string" || value.length < 12 || value.length > 128) {
    throw new ApiError(400, "Use a password with 12 to 128 characters. Spaces are preserved.");
  }
  return value;
}

async function derive(password: string, salt: Buffer): Promise<Buffer> {
  if ((state.__comicPasswordHashes || 0) >= 2) throw new ApiError(429, "Sign-in is busy. Please try again shortly.");
  state.__comicPasswordHashes = (state.__comicPasswordHashes || 0) + 1;
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(password, salt, 64, OPTIONS, (error, key) => error ? reject(error) : resolve(key));
    });
  } finally { state.__comicPasswordHashes!--; }
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  return encode(salt, await derive(password, salt));
}

// Used only for the first administrator migration, before accepting requests.
export function hashPasswordSync(password: string) {
  const salt = randomBytes(16);
  return encode(salt, scryptSync(password, salt, 64, OPTIONS));
}

export async function verifyPassword(password: string, encoded: string | null) {
  const match = /^scrypt\$32768\$8\$3\$([\w-]{22})\$([\w-]{86})$/.exec(encoded || DUMMY);
  if (!match) return false;
  const actual = await derive(password, Buffer.from(match[1], "base64url"));
  return timingSafeEqual(actual, Buffer.from(match[2], "base64url")) && encoded !== null;
}
