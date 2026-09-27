import { access, readFile } from "node:fs/promises";
import { randomBytes, scrypt } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { parseEnv, promisify } from "node:util";

const root = fileURLToPath(new URL("..", import.meta.url));
const values = parseEnv(await readFile(resolve(root, ".env.local"), "utf8"));
const password = values.BOOKS_PASSWORD;
if (typeof password !== "string" || password.length < 8 || password.length > 128) {
  throw new Error("Set BOOKS_PASSWORD in .env.local to a password with 8 to 128 characters before recovery.");
}
const database = resolve(root, values.DATA_DIR || "data", "library.sqlite");
await access(database);
const db = new DatabaseSync(database);
try {
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  const user = db.prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE AND role = 'admin'")
    .get((values.ADMIN_USERNAME || "admin").trim());
  if (!user) throw new Error("Existing administrator account not found.");
  const salt = randomBytes(16);
  // Same versioned format and cost as lib/server/passwords.ts; Node built-ins
  // keep local recovery available in production images without dev packages.
  const key = await promisify(scrypt)(password, salt, 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 });
  const hash = `scrypt$32768$8$3$${salt.toString("base64url")}$${key.toString("base64url")}`;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE users SET passwordHash = ? WHERE id = ? AND role = 'admin'").run(hash, user.id);
    db.prepare("DELETE FROM sessions WHERE userId = ?").run(user.id);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  console.log("Administrator password updated. Existing administrator sessions have been signed out.");
} finally { db.close(); }
