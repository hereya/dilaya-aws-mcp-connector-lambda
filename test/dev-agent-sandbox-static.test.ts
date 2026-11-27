import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SANDBOX_IMAGE_DIR } from "../lib/stack/dev-agent-sandbox";

// The render check's page server (lib/sandbox-image/static.mjs): a workspace page is served over
// http so its separate scripts load (file:// blocks them as cross-origin). Plain-node ES module,
// exercised through a child node process on loopback.
const STATIC = path.join(SANDBOX_IMAGE_DIR, "static.mjs");

function run(body: string): any {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `import * as s from ${JSON.stringify(STATIC)};\n${body}`], { encoding: "utf8", timeout: 20_000 });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout);
}

describe("sandbox page server", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sbx-static-"));
  fs.mkdirSync(path.join(root, "bons"));
  fs.writeFileSync(path.join(root, "bons", "index.html"), "<script type=module src=app.js></script>");
  fs.writeFileSync(path.join(root, "bons", "app.js"), "export {}");
  fs.writeFileSync(path.join(root, "bons", "style.css"), "body{}");

  it("gives scripts, styles, json, svg and png their real MIME types", () => {
    const m = run(`console.log(JSON.stringify(["a.js","a.mjs","a.css","a.json","a.svg","a.png","a.html","a.bin"].map(s.mimeOf)))`);
    expect(m).toEqual(["text/javascript; charset=utf-8", "text/javascript; charset=utf-8", "text/css; charset=utf-8",
      "application/json; charset=utf-8", "image/svg+xml", "image/png", "text/html; charset=utf-8", "application/octet-stream"]);
  });

  it("never serves outside the workspace", () => {
    const r = run(`const R=${JSON.stringify(root)}; console.log(JSON.stringify([s.fileFor(R,"/../etc/passwd"), s.fileFor(R,"/%2e%2e/x"), s.fileFor(R,"/bons/")]))`);
    expect(r[0]).toBeNull();
    expect(r[1]).toBeNull();
    expect(r[2]).toBe(path.join(root, "bons", "index.html"));
  });

  it("serves a page and its separate files over loopback", () => {
    const r = run(`const srv = await s.startStatic(${JSON.stringify(root)}); const p = srv.address().port;
const g = async (u) => { const x = await fetch("http://127.0.0.1:"+p+u); return [x.status, x.headers.get("content-type")]; };
const out = [await g("/bons/index.html"), await g("/bons/app.js"), await g("/bons/style.css"), await g("/nope.js"), srv.address().address];
srv.close(); console.log(JSON.stringify(out));`);
    expect(r).toEqual([[200, "text/html; charset=utf-8"], [200, "text/javascript; charset=utf-8"], [200, "text/css; charset=utf-8"], [404, "text/plain"], "127.0.0.1"]);
  });

  it("is started by the control server for a workspace path, and shipped in the image", () => {
    const server = fs.readFileSync(path.join(SANDBOX_IMAGE_DIR, "server.mjs"), "utf8");
    expect(server).toMatch(/serveWorkspace\(agentCommand, WS\)/);
    expect(server).not.toMatch(/"file:\/\/" \+ resolve/);
    expect(fs.readFileSync(path.join(SANDBOX_IMAGE_DIR, "Dockerfile"), "utf8")).toMatch(/COPY [^\n]*static\.mjs/);
  });
});
