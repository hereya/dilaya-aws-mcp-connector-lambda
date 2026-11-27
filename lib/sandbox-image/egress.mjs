// Outbound network policy of the sandbox (inside the MicroVM). The agent's commands run as the
// unprivileged `agent` user (uid 1001) and may reach ONLY the official npm registry — no web
// search, no arbitrary HTTP, no DNS. Two locks, both owned by root (the control server):
//
//   1. nftables, owner match: every packet a uid-1001 socket sends is DROPPED unless it goes to
//      the loopback interface (the local proxy below, a dev server the agent started, ...).
//      That covers TCP, UDP and IPv6 alike (`inet` family). DNS (port 53) is dropped even on the
//      loopback, so a local resolver cannot be used as a tunnel either.
//   2. a tiny HTTP CONNECT proxy on 127.0.0.1:3128 (run by root, so its own sockets are not
//      matched) that opens a tunnel ONLY to an allow-listed host on port 443 and answers 403
//      to anything else. npm is pointed at it through npm_config_https_proxy / HTTPS_PROXY.
//
// Why uid 1001 cannot get around it: changing the ruleset needs CAP_NET_ADMIN, which a non-root
// process does not have (root's password is locked and the image carries no sudo); raw sockets
// need CAP_NET_RAW (same); a new user + network namespace only gives it a namespace with no
// route out. The proxy resolves names itself, so the agent needs no DNS of its own.
//
// Fail CLOSED: if the ruleset cannot be applied, `applyEgressPolicy` throws and the server never
// reports ready — the image build fails (and the deploy rolls back) rather than ship it open.
import net from "node:net";
import { spawnSync } from "node:child_process";

export const PROXY_PORT = 3128;
export const PROXY_URL = `http://127.0.0.1:${PROXY_PORT}`;
/** npm's registry serves both the package metadata and the tarballs (…/-/<name>-<ver>.tgz). */
export const ALLOWED_HOSTS = new Set(["registry.npmjs.org"]);
const AGENT_UID = 1001;
const TABLE = "dilaya_sandbox_egress";

export const RULESET = `table inet ${TABLE} {
  chain output {
    type filter hook output priority 0; policy accept;
    meta skuid ${AGENT_UID} udp dport 53 counter drop
    meta skuid ${AGENT_UID} tcp dport 53 counter drop
    meta skuid ${AGENT_UID} oifname "lo" accept
    meta skuid ${AGENT_UID} counter drop
  }
}
`;

/** Environment for a command run as the agent: npm (and any proxy-aware tool) goes through the proxy. */
export const AGENT_PROXY_ENV = {
  HTTPS_PROXY: PROXY_URL, HTTP_PROXY: PROXY_URL, https_proxy: PROXY_URL, http_proxy: PROXY_URL,
  npm_config_https_proxy: PROXY_URL, npm_config_proxy: PROXY_URL,
  NO_PROXY: "localhost,127.0.0.1,::1", no_proxy: "localhost,127.0.0.1,::1",
};

/** Is the ruleset in place? (cheap: one `nft list table`). */
export function egressPolicyActive() {
  if (process.getuid?.() !== 0) return false;
  return spawnSync("nft", ["list", "table", "inet", TABLE], { stdio: "ignore" }).status === 0;
}

/** Install the ruleset once (idempotent). Throws when it cannot be applied. */
export function applyEgressPolicy() {
  if (process.getuid?.() !== 0) throw new Error("egress policy needs root");
  if (egressPolicyActive()) return;
  const r = spawnSync("nft", ["-f", "-"], { input: RULESET, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`nft failed: ${String(r.stderr || r.error?.message || "").slice(0, 300)}`);
  if (!egressPolicyActive()) throw new Error("egress ruleset missing after apply");
}

/** `CONNECT host:port` → the allow-listed host on 443 only (exported for tests). */
export function allowedTarget(authority) {
  const m = /^([a-z0-9.-]+):(\d{1,5})$/i.exec(String(authority ?? "").trim());
  if (!m) return null;
  const host = m[1].toLowerCase().replace(/\.$/, "");
  return ALLOWED_HOSTS.has(host) && m[2] === "443" ? { host, port: 443 } : null;
}

export function startEgressProxy() {
  const server = net.createServer((client) => {
    client.setTimeout(30_000, () => client.destroy());
    let head = Buffer.alloc(0);
    const onData = (chunk) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) { if (head.length > 8192) client.destroy(); return; }
      client.off("data", onData);
      const [method, authority] = head.subarray(0, end).toString("latin1").split("\r\n")[0].split(" ");
      const target = method === "CONNECT" ? allowedTarget(authority) : null;
      if (!target) {
        client.end("HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\n\r\nOnly the npm registry (registry.npmjs.org) is reachable from this sandbox.\n");
        return;
      }
      const upstream = net.connect(target.port, target.host, () => {
        client.write("HTTP/1.1 200 Connection established\r\n\r\n");
        const rest = head.subarray(end + 4);
        if (rest.length) upstream.write(rest);
        client.setTimeout(0);
        upstream.pipe(client); client.pipe(upstream);
      });
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
    };
    client.on("data", onData);
    client.on("error", () => {});
  });
  server.listen(PROXY_PORT, "127.0.0.1");
  return server;
}
