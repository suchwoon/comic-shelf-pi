import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function requireAccountConfiguration(root, settings) {
  if (settings.BOOKS_PASSWORD?.trim()) return;
  const path = resolve(root, settings.DATA_DIR || "data", "library.sqlite");
  if (existsSync(path)) {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const hasUsers = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
      if (hasUsers && db.prepare("SELECT 1 FROM users WHERE role = 'admin' AND disabled = 0 LIMIT 1").get()) return;
    } finally { db.close(); }
  }
  throw new Error("Run scripts/setup.mjs to configure the first administrator before installing services.");
}
