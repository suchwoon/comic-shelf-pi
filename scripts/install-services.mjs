import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { requireAccountConfiguration } from "./account-config.mjs";

if (process.platform !== "linux") throw new Error("This installer uses Linux systemd user services.");
const root = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const environment = parseEnv(await readFile(join(root, ".env.local"), "utf8"));
requireAccountConfiguration(root, environment);
await access(join(root, ".next", "BUILD_ID"));
const node = join(root, ".runtime", "node", "bin", "node");
await access(node);
const directory = join(homedir(), ".config", "systemd", "user");
await mkdir(directory, { recursive: true });
const quote = value => JSON.stringify(value.replaceAll("%", "%%"));
const unit = (description, command, extra = "") => `[Unit]
Description=${description}
${extra}
[Service]
Type=simple
WorkingDirectory=${root.replaceAll("%", "%%")}
ExecStart=${command.map(quote).join(" ")}
Environment=NODE_ENV=production
Environment=NEXT_TELEMETRY_DISABLED=1
Restart=on-failure
RestartSec=5
TimeoutStopSec=60
UMask=0077
NoNewPrivileges=true

[Install]
WantedBy=default.target
`;
const services = ["comic-shelf.service"];
await writeFile(join(directory, services[0]), unit("Comic Shelf PDF library", [node, join(root, "node_modules", "next", "dist", "bin", "next"), "start", "--hostname", "127.0.0.1", "--port", "3000"]));
if (process.argv.includes("--tunnel")) {
  const configuration = join(root, ".cloudflared", "config.yml");
  await access(configuration);
  const config = JSON.parse(await readFile(configuration, "utf8"));
  await access(config["credentials-file"]);
  services.push("comic-shelf-tunnel.service");
  await writeFile(join(directory, services[1]), unit("Cloudflare Tunnel for Comic Shelf", [join(root, ".runtime", "bin", "cloudflared"), "--no-autoupdate", "--config", configuration, "tunnel", "run"], "After=comic-shelf.service\nWants=comic-shelf.service"));
}
execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
for (const service of services) {
  execFileSync("systemctl", ["--user", "enable", service], { stdio: "inherit" });
  execFileSync("systemctl", ["--user", "restart", service], { stdio: "inherit" });
}
console.log(`Started: ${services.join(", ")}`);
