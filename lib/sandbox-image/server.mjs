// The sandbox control server (inside the MicroVM). Port 8080: a small JSON API over the
// workspace — files, search, exec, render check — reached ONLY through the MicroVM's
// authenticated endpoint (Lambda's proxy checks the X-aws-proxy-auth token before forwarding).
// Port 9000: lifecycle hooks (/aws/lambda-microvms/runtime/v1/*). No dependency but Playwright.
// Contract mirrored by the connector's adapter (src/sandbox/aws-microvm.ts): POST /v1/<op>
// with a JSON body → 200 {result} or 4xx/5xx {error:{code,message}}.
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const WS = process.env.WORKSPACE || "/workspace";
// Commands run as the unprivileged `agent` user when the server is root (always, in the VM).
const UID = 1001;
const AS_AGENT = process.getuid?.() === 0 ? { uid: UID, gid: UID } : {};
const OUT_MAX = 8000;
const FILE_MAX = 400_000;
const HITS_MAX = 100;
const SKIP = new Set(["node_modules", ".git", "dist", ".cache"]);
let ready = false;

class Fail extends Error { constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; } }

function resolve(rel, allowRoot = false) {
  const s = String(rel ?? "").trim().replace(/^\.\/+/, "");
  if (!s && allowRoot) return WS;
  if (!s || s.startsWith("/") || s.includes("\0") || s.split("/").includes("..")) throw new Fail("INVALID_PATH", `invalid path: ${JSON.stringify(rel).slice(0, 80)}`);
  const abs = path.resolve(WS, s);
  if (abs !== WS && !abs.startsWith(WS + "/")) throw new Fail("INVALID_PATH", "path escapes the workspace");
  return abs;
}
const rel = (abs) => path.relative(WS, abs);
const tail = (t) => (t.length <= OUT_MAX ? { text: t, truncated: false } : { text: `[… ${t.length - OUT_MAX} characters cut]\n${t.slice(-OUT_MAX)}`, truncated: true });

async function walk(dir, out = []) {
  let ents;
  try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch (e) { if (e.code === "ENOENT") throw new Fail("NOT_FOUND", `no such directory: ${rel(dir)}`, 404); throw e; }
  for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP.has(e.name)) await walk(p, out); }
    else if (e.isFile()) out.push(p);
    if (out.length > 5000) break;
  }
  return out;
}

async function readText(abs) {
  try {
    const st = await fs.stat(abs);
    if (st.size > FILE_MAX * 4) throw new Fail("TOO_LARGE", `file too large: ${rel(abs)}`);
    return await fs.readFile(abs, "utf8");
  } catch (e) { if (e.code === "ENOENT") throw new Fail("NOT_FOUND", `no such file: ${rel(abs)}`, 404); throw e; }
}

async function writeText(abs, content) {
  if (String(content).length > FILE_MAX) throw new Fail("TOO_LARGE", `content too large (max ${FILE_MAX} characters)`);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, String(content));
  await fs.chown(abs, UID, UID).catch(() => {});
}

function exec({ cmd, timeoutMs, cwd }) {
  const t = Math.min(Math.max(Number(timeoutMs) || 120_000, 1000), 300_000);
  const dir = cwd ? resolve(cwd) : WS;
  return new Promise((done) => {
    const started = Date.now();
    const child = spawn("bash", ["-lc", String(cmd)], { cwd: dir, ...AS_AGENT, env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/home/agent", CI: "1", PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH }, detached: true });
    let out = "", err = "", timedOut = false;
    child.stdout.on("data", (d) => { out = (out + d).slice(-OUT_MAX * 4); });
    child.stderr.on("data", (d) => { err = (err + d).slice(-OUT_MAX * 4); });
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, "SIGKILL"); } catch {} }, t);
    child.on("close", (code) => {
      clearTimeout(timer);
      const o = tail(out), e = tail(err);
      done({ exitCode: code ?? -1, stdout: o.text, stderr: e.text, durationMs: Date.now() - started, truncated: o.truncated || e.truncated, timedOut });
    });
  });
}

async function renderCheck({ url, path: p }) {
  const { chromium } = await import("playwright");
  const target = url ? String(url) : "file://" + resolve(p || "index.html");
  if (url && !/^https?:\/\//.test(target)) throw new Fail("INVALID_PATH", "url must be http(s)");
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 300)); });
    page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 300)));
    const res = await page.goto(target, { waitUntil: "load", timeout: 30_000 });
    await page.waitForTimeout(500);
    const status = res ? res.status() : 200;
    return { ok: status < 400 && errors.length === 0, consoleErrors: errors.slice(0, 20) };
  } finally { await browser.close(); }
}

const OPS = {
  async list({ dir }) {
    const files = await walk(resolve(dir, true));
    return Promise.all(files.slice(0, 2000).map(async (f) => ({ path: rel(f), size: (await fs.stat(f)).size })));
  },
  async read({ path: p, from, to }) {
    const c = await readText(resolve(p));
    if (!from) return c.slice(0, FILE_MAX);
    const lines = c.split("\n");
    return lines.slice(Math.max(1, from) - 1, Math.min(lines.length, to ?? lines.length)).join("\n");
  },
  async write({ path: p, content }) { await writeText(resolve(p), content); return null; },
  async edit({ path: p, oldText, newText }) {
    const abs = resolve(p);
    const c = await readText(abs);
    const n = oldText ? c.split(String(oldText)).length - 1 : 0;
    if (n === 0) throw new Fail("NO_MATCH", `the text to replace was not found in ${p}`);
    if (n > 1) throw new Fail("AMBIGUOUS_MATCH", `the text to replace occurs ${n} times in ${p}: include more context so it is unique`);
    const i = c.indexOf(oldText);
    await writeText(abs, c.slice(0, i) + String(newText ?? "") + c.slice(i + oldText.length));
    return null;
  },
  async delete({ path: p }) {
    try { await fs.rm(resolve(p)); } catch (e) { if (e.code === "ENOENT") throw new Fail("NOT_FOUND", `no such file: ${p}`, 404); throw e; }
    return null;
  },
  async search({ query, regex, dir }) {
    const re = regex ? new RegExp(String(query)) : null;
    const hits = [];
    for (const f of await walk(resolve(dir, true))) {
      const st = await fs.stat(f);
      if (st.size > FILE_MAX) continue;
      const lines = (await fs.readFile(f, "utf8")).split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (re ? re.test(lines[i]) : lines[i].includes(String(query))) hits.push({ path: rel(f), line: i + 1, text: lines[i].slice(0, 300) });
        if (hits.length >= HITS_MAX) return hits;
      }
    }
    return hits;
  },
  exec,
  "render-check": renderCheck,
};

function body(req) {
  return new Promise((ok, ko) => {
    let n = 0; const chunks = [];
    req.on("data", (c) => { n += c.length; if (n > 2_000_000) { ko(new Fail("TOO_LARGE", "request too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { ok(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch { ko(new Fail("INVALID_INPUT", "invalid JSON")); } });
  });
}
const send = (res, status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };

http.createServer(async (req, res) => {
  const op = req.method === "POST" && req.url?.startsWith("/v1/") ? req.url.slice(4) : null;
  if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: ready });
  if (!op || !Object.hasOwn(OPS, op)) return send(res, 404, { error: { code: "NOT_FOUND", message: "unknown operation" } });
  try { send(res, 200, { result: await OPS[op](await body(req)) }); }
  catch (e) { send(res, e instanceof Fail ? e.status : 500, { error: { code: e instanceof Fail ? e.code : "INTERNAL", message: String(e.message).slice(0, 300) } }); }
}).listen(8080, "0.0.0.0");

// Lifecycle hooks (port 9000, separate server so /suspend answers even when the API is busy).
const HOOK = "/aws/lambda-microvms/runtime/v1/";
http.createServer(async (req, res) => {
  const hook = req.url?.startsWith(HOOK) ? req.url.slice(HOOK.length) : "";
  if (hook === "ready") return send(res, ready ? 200 : 503, { ready });
  if (hook === "validate") {
    try { const r = await exec({ cmd: "node --version && npm --version && git --version", timeoutMs: 20_000 }); return send(res, r.exitCode === 0 ? 200 : 500, { ok: r.exitCode === 0 }); }
    catch { return send(res, 500, { ok: false }); }
  }
  // run / resume / suspend / terminate: nothing to drain — the workspace lives on the VM's disk,
  // which the snapshot keeps across suspend/resume.
  send(res, 200, { ok: true });
}).listen(9000, "0.0.0.0");

await fs.mkdir(WS, { recursive: true });
await fs.chown(WS, UID, UID).catch(() => {});
ready = true;
