// A tiny static HTTP server over the workspace, for the render check of a workspace page.
// A page loaded over file:// cannot load its own separate scripts (Chrome treats every file:// URL
// as a distinct origin, so `<script type="module" src="app.js">` is blocked as cross-origin), so a
// workspace path is served over http://127.0.0.1:<ephemeral> instead. Run as the agent INSIDE its
// network namespace (only loopback): the browser, in the same namespace, reaches it; nothing else
// can. Dependency-free. `node static.mjs <root>` prints `PORT <n>` once listening.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const MIME = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff", ".txt": "text/plain; charset=utf-8",
};
export const mimeOf = (p) => MIME[path.extname(p).toLowerCase()] || "application/octet-stream";

/** Resolve a URL path under root; null when it escapes it. */
export function fileFor(root, urlPath) {
  let p;
  try { p = decodeURIComponent(String(urlPath).split("?")[0].split("#")[0]); } catch { return null; }
  const abs = path.resolve(root, "." + (p.startsWith("/") ? p : "/" + p));
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  try { if (fs.statSync(abs).isDirectory()) return path.join(abs, "index.html"); } catch {}
  return abs;
}

export function startStatic(root) {
  const base = path.resolve(root);
  const server = http.createServer((req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); return res.end(); }
    const f = fileFor(base, req.url || "/");
    if (!f) { res.writeHead(403); return res.end(); }
    fs.readFile(f, (err, buf) => {
      if (err) { res.writeHead(404, { "content-type": "text/plain" }); return res.end("not found"); }
      res.writeHead(200, { "content-type": mimeOf(f), "cache-control": "no-store" });
      res.end(req.method === "HEAD" ? undefined : buf);
    });
  });
  return new Promise((done, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", () => done(server)); });
}

/** From the control server: start this script through `agentCommand` (inside the namespace, as the
 *  agent) and resolve its port; `stop()` kills it. Rejects if it does not report a port in 10 s. */
export function serveWorkspace(agentCommand, root, timeoutMs = 10_000) {
  const self = fileURLToPath(import.meta.url);
  const [file, args] = agentCommand(`exec node ${JSON.stringify(self)} ${JSON.stringify(root)}`);
  const child = spawn(file, args, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const stop = () => { try { process.kill(-child.pid, "SIGKILL"); } catch {} };
  return new Promise((done, fail) => {
    let buf = "";
    const timer = setTimeout(() => { stop(); fail(new Error("the page server did not start")); }, timeoutMs);
    child.stdout.on("data", (d) => {
      buf += d;
      const m = /PORT (\d+)/.exec(buf);
      if (m) { clearTimeout(timer); done({ port: Number(m[1]), stop }); }
    });
    child.on("exit", (code) => { clearTimeout(timer); fail(new Error(`the page server exited (${code})`)); });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const s = await startStatic(process.argv[2] || process.cwd());
  console.log(`PORT ${s.address().port}`);
}
