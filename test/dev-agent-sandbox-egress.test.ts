import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { SANDBOX_IMAGE_DIR } from "../lib/stack/dev-agent-sandbox";

// The sandbox's outbound lock (lib/sandbox-image/egress.mjs): the agent's commands run in a
// network namespace with only loopback; their one way out is a proxy to the npm registry.
// egress.mjs is an ES module run by plain node inside the image, so it is exercised here through
// a child node process (no network needed: refusals never dial out). The namespace itself needs
// root + CAP_SYS_ADMIN, so its shape is checked on the source and its behaviour in the image.
const EGRESS = path.join(SANDBOX_IMAGE_DIR, "egress.mjs");
const FORWARDER = path.join(SANDBOX_IMAGE_DIR, "forwarder.mjs");
const SRC = fs.readFileSync(EGRESS, "utf8");

function run(body: string): any {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `import * as e from ${JSON.stringify(EGRESS)};\n${body}`], { encoding: "utf8", timeout: 20_000 });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout);
}

test("only registry.npmjs.org on 443 is an allowed CONNECT target", () => {
  const out = run(`console.log(JSON.stringify([
    "registry.npmjs.org:443", "REGISTRY.npmjs.org.:443", "registry.npmjs.org:80", "www.google.com:443",
    "example.com:443", "registry.npmjs.org.evil.com:443", "169.254.169.254:80", "", "registry.npmjs.org"
  ].map((a) => !!e.allowedTarget(a))));`);
  expect(out).toEqual([true, true, false, false, false, false, false, false, false]);
});

test("agent commands run in the locked namespace, as uid 1001, with every capability dropped", () => {
  expect(SRC).toContain('spawn("unshare", ["--net"');
  expect(SRC).toContain("`--net=/proc/${fwd.pid}/ns/net`");
  for (const flag of ["`--reuid=${AGENT_UID}`", '"--clear-groups"', '"--inh-caps=-all"', '"--bounding-set=-all"', '"--no-new-privs"']) {
    expect(SRC).toContain(flag);
  }
  expect(SRC).not.toMatch(/spawnSync\("nft"/);
});

test("the lock counts as active only when the namespace is another one holding nothing but loopback", () => {
  expect(SRC).toContain('ifs.every((i) => i === "lo")');
  expect(SRC).toContain("theirs === nsOf(process.pid)");
  expect(SRC).toContain('throw new Error("egress lock not active: refusing to run")');
});

test("the agent's commands are pointed at the local proxy (npm included), localhost bypasses it", () => {
  const env = run(`console.log(JSON.stringify(e.AGENT_PROXY_ENV));`);
  for (const k of ["HTTPS_PROXY", "https_proxy", "npm_config_https_proxy", "npm_config_proxy"]) expect(env[k]).toBe("http://127.0.0.1:3128");
  expect(env.NO_PROXY).toContain("localhost");
});

const PROXY_SETUP = `
  import net from "node:net";
  import os from "node:os";
  const sock = os.tmpdir() + "/dly-egress-" + process.pid + "/proxy.sock";
  const srv = e.startEgressProxy(sock);
  await new Promise((r) => srv.on("listening", r));
  const ask = (connect, req) => new Promise((ok) => {
    const s = connect(() => s.write(req));
    let d = ""; s.on("data", (c) => (d += c)); s.on("close", () => ok(d.split("\\r\\n")[0]));
  });`;

test("the proxy answers 403 to a CONNECT elsewhere and to plain HTTP, without dialing out", () => {
  const out = run(`${PROXY_SETUP}
    const viaSock = (cb) => net.connect(sock, cb);
    const a = await ask(viaSock, "CONNECT www.google.com:443 HTTP/1.1\\r\\nHost: www.google.com:443\\r\\n\\r\\n");
    const b = await ask(viaSock, "GET http://example.com/ HTTP/1.1\\r\\nHost: example.com\\r\\n\\r\\n");
    const c = await ask(viaSock, "CONNECT registry.npmjs.org:22 HTTP/1.1\\r\\n\\r\\n");
    srv.close();
    console.log(JSON.stringify([a, b, c]));`);
  expect(out).toEqual(["HTTP/1.1 403 Forbidden", "HTTP/1.1 403 Forbidden", "HTTP/1.1 403 Forbidden"]);
});

test("the forwarder relays its loopback port to the proxy socket", () => {
  const out = run(`${PROXY_SETUP}
    import { spawn } from "node:child_process";
    const port = 40000 + (process.pid % 20000);
    const fw = spawn(process.execPath, [${JSON.stringify(FORWARDER)}, sock, String(port)]);
    await new Promise((r) => fw.stdout.on("data", r));
    const line = await ask((cb) => net.connect(port, "127.0.0.1", cb), "CONNECT example.com:443 HTTP/1.1\\r\\n\\r\\n");
    fw.kill(); srv.close();
    console.log(JSON.stringify(line));`);
  expect(out).toBe("HTTP/1.1 403 Forbidden");
});

test("outside root, the lock reports inactive and refuses to pretend it applied", () => {
  if (process.getuid?.() === 0) return;
  const out = run(`let threw = false; try { await e.startAgentNetns(); } catch { threw = true; }
    console.log(JSON.stringify({ active: e.egressPolicyActive(), threw, cmd: e.agentCommand("true")[0] }));`);
  expect(out).toEqual({ active: false, threw: true, cmd: "bash" });
});
