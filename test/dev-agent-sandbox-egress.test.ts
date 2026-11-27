import { spawnSync } from "child_process";
import * as path from "path";
import { SANDBOX_IMAGE_DIR } from "../lib/stack/dev-agent-sandbox";

// The sandbox's outbound lock (lib/sandbox-image/egress.mjs): the agent user reaches ONLY the npm
// registry. egress.mjs is an ES module run by plain node inside the image, so it is exercised
// here through a child node process (no network needed: refusals never dial out).
const EGRESS = path.join(SANDBOX_IMAGE_DIR, "egress.mjs");

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

test("the ruleset drops everything the agent uid sends except loopback (inet = v4 + v6, so DNS too)", () => {
  const { rules } = run(`console.log(JSON.stringify({ rules: e.RULESET }));`);
  expect(rules).toMatch(/table inet /);
  expect(rules).toMatch(/hook output/);
  expect(rules).toMatch(/meta skuid 1001 oifname "lo" accept/);
  expect(rules).toMatch(/meta skuid 1001 counter drop/);
  expect(rules).toMatch(/meta skuid 1001 udp dport 53 counter drop/);
  expect(rules.indexOf("dport 53")).toBeLessThan(rules.indexOf("oifname \"lo\" accept"));
  expect(rules.indexOf("accept")).toBeLessThan(rules.indexOf("drop"));
});

test("the agent's commands are pointed at the local proxy (npm included), localhost bypasses it", () => {
  const env = run(`console.log(JSON.stringify(e.AGENT_PROXY_ENV));`);
  for (const k of ["HTTPS_PROXY", "https_proxy", "npm_config_https_proxy", "npm_config_proxy"]) expect(env[k]).toBe("http://127.0.0.1:3128");
  expect(env.NO_PROXY).toContain("localhost");
});

test("the proxy answers 403 to a CONNECT elsewhere and to plain HTTP, without dialing out", () => {
  const out = run(`
    import net from "node:net";
    const srv = e.startEgressProxy();
    const ask = (req) => new Promise((ok) => {
      const s = net.connect(e.PROXY_PORT, "127.0.0.1", () => s.write(req));
      let d = ""; s.on("data", (c) => (d += c)); s.on("close", () => ok(d.split("\\r\\n")[0]));
    });
    const a = await ask("CONNECT www.google.com:443 HTTP/1.1\\r\\nHost: www.google.com:443\\r\\n\\r\\n");
    const b = await ask("GET http://example.com/ HTTP/1.1\\r\\nHost: example.com\\r\\n\\r\\n");
    const c = await ask("CONNECT registry.npmjs.org:22 HTTP/1.1\\r\\n\\r\\n");
    srv.close();
    console.log(JSON.stringify([a, b, c]));`);
  expect(out).toEqual(["HTTP/1.1 403 Forbidden", "HTTP/1.1 403 Forbidden", "HTTP/1.1 403 Forbidden"]);
});

test("outside root, the lock reports inactive and refuses to pretend it applied", () => {
  if (process.getuid?.() === 0) return;
  const out = run(`let threw = false; try { e.applyEgressPolicy(); } catch { threw = true; } console.log(JSON.stringify({ active: e.egressPolicyActive(), threw }));`);
  expect(out).toEqual({ active: false, threw: true });
});
