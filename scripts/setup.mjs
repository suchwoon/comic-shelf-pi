import { randomBytes } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const file = fileURLToPath(new URL("../.env.local", import.meta.url));
let source = await readFile(file, "utf8").catch(error => {
  if (error.code !== "ENOENT") throw error;
  return "";
});
const values = parseEnv(source);
const originArgument = process.argv.find(value => value.startsWith("--origin="))?.slice(9);
let publicOrigin;
if (originArgument) {
  const url = new URL(originArgument);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Use a public HTTPS origin, for example https://books.example.com.");
  }
  publicOrigin = url.origin;
}
function set(key, value) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^(?:export\\s+)?${key}\\s*=.*$`, "m");
  source = pattern.test(source) ? source.replace(pattern, () => line) : `${source.replace(/\s*$/, "")}\n${line}\n`;
}
if (!values.BOOKS_PASSWORD?.trim()) set("BOOKS_PASSWORD", randomBytes(24).toString("base64url"));
if (publicOrigin) set("PUBLIC_ORIGIN", publicOrigin);
if (!values.DATA_DIR) set("DATA_DIR", "./data");
if (!values.MAX_UPLOAD_MB) set("MAX_UPLOAD_MB", "256");
await writeFile(file, source.trimStart(), { mode: 0o600 });
await chmod(file, 0o600);
console.log("Private settings are ready in .env.local. Read BOOKS_PASSWORD there to sign in.");
