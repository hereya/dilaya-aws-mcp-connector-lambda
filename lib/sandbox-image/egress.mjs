// Outbound network policy of the sandbox (inside the MicroVM). The agent's commands run as the
// unprivileged `agent` user (uid 1001) and may reach ONLY the official npm registry — no web
// search, no arbitrary HTTP, no DNS.
//
// No netfilter: the MicroVM kernel answers "Operation not supported" to nf_tables (0.1.161 failed
// on it), so the lock is a NETWORK NAMESPACE instead — a structural one, nothing to filter:
//
//   1. At boot, root starts `forwarder.mjs` in a NEW network namespace (`unshare --net`) whose only
//      interface is loopback. Every agent command (and the render-check browser) is run INSIDE
//      that namespace (`nsenter --net=/proc/<forwarder>/ns/net`), then dropped to uid 1001 with
//      every capability removed (`setpriv`). There is no route out of it: no web, no DNS, no IP.
//   2. Inside it, the forwarder listens on 127.0.0.1:3128 and relays each connection to a UNIX
//      socket (0700 dir, root) served OUTSIDE by the allow-list CONNECT proxy below, which opens a
//      tunnel ONLY to registry.npmjs.org:443 and answers 403 to anything else. npm is pointed at
//      127.0.0.1:3128 through npm_config_https_proxy / HTTPS_PROXY; the proxy resolves names
//      itself, so the agent needs no DNS.
//
// Why uid 1001 cannot get around it: leaving a network namespace (setns) needs CAP_SYS_ADMIN over
// the target namespace's owner — the initial user namespace — which it never has (capabilities
// cleared, no_new_privs, root's password locked, no sudo); a user namespace of its own only owns
// namespaces it creates, none of which has a route out. The proxy's UNIX socket is root-only.
//
// Fail CLOSED: if the namespace cannot be created, or is found with any interface but loopback,
// `startAgentNetns` throws and the server never reports ready; `agentCommand` refuses to run a
// command when the lock is not active.
import net from "node:net";
import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";

export const PROXY_PORT = 3128;
export const PROXY_URL = `http://127.0.0.1:${PROXY_PORT}`;
export const PROXY_DIR = "/run/dilaya-egress";
export const PROXY_SOCK = `${PROXY_DIR}/proxy.sock`;
/** npm's registry serves both the package metadata and the tarballs (…/-/<name>-<ver>.tgz). */
export const ALLOWED_HOSTS = new Set(["registry.npmjs.org"]);
export const AGENT_UID = 1001;
const FORWARDER = new URL("./forwarder.mjs", import.meta.url).pathname;
let fwd = null; // { pid } of the forwarder, i.e. the agent namespace's holder

/** Environment for a command run as the agent: npm (and any proxy-aware tool) goes through the proxy. */
export const AGENT_PROXY_ENV = {
  HTTPS_PROXY: PROXY_URL, HTTP_PROXY: PROXY_URL, https_proxy: PROXY_URL, http_proxy: PROXY_URL,
  npm_config_https_proxy: PROXY_URL, npm_config_proxy: PROXY_URL,
  NO_PROXY: "localhost,127.0.0.1,::1", no_proxy: "localhost,127.0.0.1,::1",
};

const nsOf = (pid) => { try { return fs.readlinkSync(`/proc/${pid}/ns/net`); } catch { return null; } };
/** Interfaces of a process's network namespace (from /proc/<pid>/net/dev). */
export function interfacesOf(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/net/dev`, "utf8").split("\n").slice(2)
      .map((l) => l.split(":")[0].trim()).filter(Boolean);
  } catch { return null; }
}

/** Is the lock in place? The forwarder is alive, in ANOTHER namespace, whose only interface is lo. */
export function egressPolicyActive() {
  if (process.getuid?.() !== 0 || !fwd) return false;
  try { process.kill(fwd.pid, 0); } catch { return false; }
  const theirs = nsOf(fwd.pid);
  if (!theirs || theirs === nsOf(process.pid)) return false;
  const ifs = interfacesOf(fwd.pid);
  return Array.isArray(ifs) && ifs.length > 0 && ifs.every((i) => i === "lo");
}

/** Start the forwarder in a fresh network namespace (idempotent). Throws when it cannot be done. */
export function startAgentNetns(timeoutMs = 10_000) {
  if (process.getuid?.() !== 0) return Promise.reject(new Error("egress lock needs root"));
  if (egressPolicyActive()) return Promise.resolve();
  return new Promise((ok, ko) => {
    const child = spawn("unshare", ["--net", "--", "sh", "-c", `ip link set lo up && exec node ${FORWARDER} ${PROXY_SOCK} ${PROXY_PORT}`],
      { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); ko(new Error(`forwarder not ready: ${err.slice(0, 300)}`)); }, timeoutMs);
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => { clearTimeout(timer); ko(e); });
    child.on("exit", (code) => { clearTimeout(timer); if (fwd?.pid === child.pid) fwd = null; ko(new Error(`forwarder exited (${code}): ${err.slice(0, 300)}`)); });
    child.stdout.on("data", (d) => {
      if (!String(d).includes("ready")) return;
      clearTimeout(timer);
      fwd = { pid: child.pid };
      if (egressPolicyActive()) ok();
      else { child.kill("SIGKILL"); fwd = null; ko(new Error(`agent namespace not isolated: ${JSON.stringify(interfacesOf(child.pid))}`)); }
    });
  });
}

/** [file, args] to run `cmd` as the agent inside the locked namespace. Refuses when the lock is off. */
export function agentCommand(cmd) {
  if (process.getuid?.() !== 0) return ["bash", ["-lc", String(cmd)]]; // local tests outside the VM
  if (!egressPolicyActive()) throw new Error("egress lock not active: refusing to run");
  return ["nsenter", [`--net=/proc/${fwd.pid}/ns/net`, "--", "setpriv", `--reuid=${AGENT_UID}`, `--regid=${AGENT_UID}`,
    "--clear-groups", "--inh-caps=-all", "--bounding-set=-all", "--no-new-privs", "bash", "-lc", String(cmd)]];
}

/** A wrapper executable that starts `real` (the browser) inside the locked namespace. */
export function nsWrapper(real) {
  if (process.getuid?.() !== 0) return real;
  if (!egressPolicyActive()) throw new Error("egress lock not active: refusing to run");
  const p = `${PROXY_DIR}/in-netns-${fwd.pid}.sh`;
  fs.writeFileSync(p, `#!/bin/sh\nexec nsenter --net=/proc/${fwd.pid}/ns/net -- ${JSON.stringify(real)} "$@"\n`, { mode: 0o700 });
  return p;
}

/** `CONNECT host:port` → the allow-listed host on 443 only (exported for tests). */
export function allowedTarget(authority) {
  const m = /^([a-z0-9.-]+):(\d{1,5})$/i.exec(String(authority ?? "").trim());
  if (!m) return null;
  const host = m[1].toLowerCase().replace(/\.$/, "");
  return ALLOWED_HOSTS.has(host) && m[2] === "443" ? { host, port: 443 } : null;
}

/** The allow-list CONNECT proxy, outside the namespace, on a root-only UNIX socket. */
export function startEgressProxy(sock = PROXY_SOCK) {
  fs.mkdirSync(sock.slice(0, sock.lastIndexOf("/")), { recursive: true, mode: 0o700 });
  try { fs.unlinkSync(sock); } catch {}
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
  server.listen(sock, () => { try { fs.chmodSync(sock, 0o600); } catch {} });
  return server;
}

/** One-shot kernel probes, logged at boot so a failed attempt still says what the VM supports. */
export function diagnostics() {
  const sh = (cmd) => {
    const r = spawnSync("sh", ["-c", cmd], { encoding: "utf8", timeout: 5000 });
    return r.status === 0 ? "ok" : `fail(${r.status ?? r.error?.code}): ${String(r.stderr || "").trim().slice(0, 120)}`;
  };
  const asAgent = `setpriv --reuid=${AGENT_UID} --regid=${AGENT_UID} --clear-groups`;
  return {
    kernel: sh("uname -r") === "ok" ? spawnSync("uname", ["-r"], { encoding: "utf8" }).stdout.trim() : "unknown",
    ipTablesNames: fs.existsSync("/proc/net/ip_tables_names"),
    iptablesLegacy: sh("iptables-legacy -L -n"),
    iptablesNft: sh("iptables-nft -L -n"),
    unshareNet: sh("unshare --net true"),
    userNsAsAgent: sh(`${asAgent} unshare --user --map-root-user true`),
    capEff: (fs.readFileSync("/proc/self/status", "utf8").match(/^CapEff:\s*(\S+)/m) || [])[1] || null,
  };
}
