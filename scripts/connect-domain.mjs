import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const root = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const hostname = process.argv[2] || "books.catfish.cc";
if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(hostname)) {
  throw new Error("Pass a hostname such as books.example.com.");
}
const settings = parseEnv(await readFile(join(root, ".env.local"), "utf8"));
if (!settings.BOOKS_PASSWORD?.trim()) throw new Error("Set up the library password first.");
if (settings.PUBLIC_ORIGIN !== `https://${hostname}`) {
  throw new Error(`First run: node scripts/setup.mjs --origin=https://${hostname}`);
}
await access(join(root, ".next", "BUILD_ID"));
const binary = join(root, ".runtime", "bin", "cloudflared");
await access(binary);
const certificate = join(homedir(), ".cloudflared", "cert.pem");
try { await access(certificate); }
catch {
  console.log("Open the Cloudflare link below, choose your domain, and authorize. No password or token needs to be pasted here.");
  execFileSync(binary, ["tunnel", "login"], { stdio: "inherit" });
  await access(certificate);
}
const directory = join(root, ".cloudflared");
await mkdir(directory, { recursive: true, mode: 0o700 });
await chmod(directory, 0o700);
const credentials = join(directory, "credentials.json");
const tunnelName = `comic-shelf-${hostname.replaceAll(".", "-")}`;
const run = args => execFileSync(binary, ["tunnel", "--origincert", certificate, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
const tunnels = JSON.parse(run(["list", "--output", "json", "--name", tunnelName])) || [];
// list excludes deleted tunnels by default; an active tunnel's deleted_at can
// still contain Go's nonempty zero-time string.
let tunnel = tunnels.find(candidate => candidate.name === tunnelName);
if (!tunnel) {
  tunnel = JSON.parse(run(["create", "--output", "json", "--credentials-file", credentials, tunnelName]));
}
await access(credentials).catch(() => {
  throw new Error(`Tunnel ${tunnelName} exists, but its local credentials are missing. Restore .cloudflared/credentials.json before continuing.`);
});
await chmod(credentials, 0o600);
const stored = JSON.parse(await readFile(credentials, "utf8"));
if (stored.TunnelID !== tunnel.id) throw new Error("The tunnel credentials do not match the selected tunnel.");
const config = {
  tunnel: tunnel.id,
  "credentials-file": credentials,
  metrics: "127.0.0.1:20241",
  ingress: [
    { hostname, service: "http://127.0.0.1:3000" },
    { service: "http_status:404" },
  ],
};
const configuration = join(directory, "config.yml");
await writeFile(configuration, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
execFileSync(binary, ["--config", configuration, "tunnel", "ingress", "validate"], { stdio: "inherit" });
// Deliberately omit --overwrite-dns: an existing hostname must never be replaced silently.
run(["route", "dns", tunnel.id, hostname]);
execFileSync(process.execPath, [join(root, "scripts", "install-services.mjs"), "--tunnel"], { stdio: "inherit" });
async function waitFor(url) {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      await response.body?.cancel();
      if (response.ok) return;
    } catch { /* The service may still be starting or connecting. */ }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`The service is installed but not ready at ${url}. Check systemctl --user status comic-shelf.service comic-shelf-tunnel.service.`);
}
await waitFor("http://127.0.0.1:3000/api/session");
await waitFor("http://127.0.0.1:20241/ready");
console.log(`Connected https://${hostname}. Sign in with BOOKS_PASSWORD from .env.local.`);
