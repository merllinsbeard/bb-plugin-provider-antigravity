import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { DEFAULT_ACCOUNT, account, poolPaths } from "../src/pool/account.ts";
import { PROXY_FILE } from "../src/pool/egress.ts";
import { probeAccount } from "../src/pool/probe-account.ts";
import { resolveAgyBinary } from "../src/usage/probe.ts";

const USER = "live-check";
const PASSWORD = "not-a-secret";
const home = os.homedir();
const paths = poolPaths(process.env, home);
const proxyFile = path.join(paths.agyStateDir, PROXY_FILE);
const agy = resolveAgyBinary(process.env, home);
if (agy === null) throw new Error("agy is not installed");
if (existsSync(proxyFile)) throw new Error(`${proxyFile} already exists; this check only runs on a direct default account.`);

const tunnels: string[] = [];
const expectedAuth = `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString("base64")}`;
const proxy = createServer((_req, res) => res.writeHead(405).end());
proxy.on("connect", (req: IncomingMessage, client: Socket, head: Buffer) => {
  if (req.headers["proxy-authorization"] !== expectedAuth) {
    client.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
    return;
  }
  const [host, port] = (req.url ?? "").split(":");
  tunnels.push(req.url ?? "");
  const upstream = connect(Number(port), host!, () => {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    upstream.write(head);
    upstream.pipe(client).pipe(upstream);
  });
  upstream.on("error", () => client.destroy());
  client.on("error", () => upstream.destroy());
});
await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
const proxyPort = (proxy.address() as AddressInfo).port;

function descendants(root: number): Set<number> {
  const parent = new Map<number, number>();
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      parent.set(Number(entry), Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]));
    } catch {}
  }
  const tree = new Set<number>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const [pid, ppid] of parent)
      if (!tree.has(pid) && (ppid === root || tree.has(ppid))) {
        tree.add(pid);
        grew = true;
      }
  }
  return tree;
}

function isPublic(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, "").replace(/^::ffff:/, "");
  if (ip === "::1" || ip.startsWith("127.") || ip.startsWith("10.") || ip.startsWith("192.168.")) return false;
  const [a, b] = ip.split(".").map(Number);
  if (a === 100 && b! >= 64 && b! < 128) return false;
  if (a === 172 && b! >= 16 && b! < 32) return false;
  return !/^f[cd]|^fe80/i.test(ip);
}

type Watched = {
  readonly outcome: Awaited<ReturnType<typeof probeAccount>>;
  readonly agyDirect: Set<string>;
  readonly childDirect: Set<string>;
};

const agyExe = realpathSync(agy);

async function probeWatched(): Promise<Watched> {
  const agyDirect = new Set<string>();
  const childDirect = new Set<string>();
  const watch = setInterval(() => {
    const tree = descendants(process.pid);
    if (tree.size === 0) return;
    const sockets = execFileSync("ss", ["-tnpH"], { encoding: "utf8" });
    for (const line of sockets.split("\n")) {
      const pid = [...line.matchAll(/pid=(\d+)/g)].map((match) => Number(match[1])).find((candidate) => tree.has(candidate));
      if (pid === undefined) continue;
      const peer = line.trim().split(/\s+/)[4] ?? "";
      if (!isPublic(peer.slice(0, peer.lastIndexOf(":")))) continue;
      let exe = "?";
      let command = "?";
      try {
        exe = readlinkSync(`/proc/${pid}/exe`);
        command = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ").trim().slice(0, 120);
      } catch {}
      (exe === agyExe ? agyDirect : childDirect).add(`${peer} pid=${pid} ${command}`);
    }
  }, 50);
  const outcome = await probeAccount(paths, account(DEFAULT_ACCOUNT, paths.agyStateDir), () => agy);
  clearInterval(watch);
  return { outcome, agyDirect, childDirect };
}

let through: Watched;
let closed: Watched;
try {
  writeFileSync(proxyFile, `http://${USER}:${PASSWORD}@127.0.0.1:${proxyPort}\n`, { mode: 0o600 });
  through = await probeWatched();
  writeFileSync(proxyFile, `http://${USER}:${PASSWORD}@127.0.0.1:1\n`, { mode: 0o600 });
  closed = await probeWatched();
} finally {
  rmSync(proxyFile, { force: true });
  proxy.close();
}

const googleTunnels = [...new Set(tunnels)].filter((target) => /\.(googleapis|googleusercontent)\.com:443$/.test(target));
const passed =
  through.outcome.ok &&
  googleTunnels.length > 0 &&
  through.agyDirect.size === 0 &&
  !closed.outcome.ok &&
  closed.agyDirect.size === 0 &&
  !existsSync(proxyFile);
const report = {
  agy,
  throughProxy: {
    quota: through.outcome.ok ? through.outcome.reading.windows.map((window) => window.label) : through.outcome.failure,
    tunnels: [...new Set(tunnels)].sort(),
    agyDirectPublicConnections: [...through.agyDirect],
    mcpChildDirectPublicConnections: [...through.childDirect],
  },
  proxyDown: {
    outcome: closed.outcome.ok ? "quota read (unexpected)" : closed.outcome.failure,
    agyDirectPublicConnections: [...closed.agyDirect],
    mcpChildDirectPublicConnections: [...closed.childDirect],
  },
  proxyFileRemoved: !existsSync(proxyFile),
  passed,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exit(passed ? 0 : 1);
