import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

// 23/09/2026: lib/frontend-authorizer/front-door.js was git-ignored by the
// blanket `*.js` rule while index.js required it. Published, the authorizer
// would have crashed on load — every tenant site down. Any file a hand-written
// Lambda asset requires by relative path must be one git actually ships.
const ASSET_DIRS = ["authorizer", "frontend-authorizer", "auth-lambda", "alarm-relay", "byod-origin-restamp", "cognito-triggers"];
const ROOT = path.join(__dirname, "..");

function jsFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : jsFiles(p);
    return e.name.endsWith(".js") ? [p] : [];
  });
}

function ignored(rel: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "-q", "--no-index", rel], { cwd: ROOT });
    return true;
  } catch {
    return false;
  }
}

describe("hand-written Lambda assets ship everything they require", () => {
  for (const d of ASSET_DIRS) {
    for (const file of jsFiles(path.join(ROOT, "lib", d))) {
      const rel = path.relative(ROOT, file);
      if (ignored(rel)) continue; // not shipped itself, so not a requirer
      const src = fs.readFileSync(file, "utf8");
      for (const m of src.matchAll(/require\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g)) {
        it(`${rel} → ${m[1]}`, () => {
          let target = path.resolve(path.dirname(file), m[1]);
          if (!fs.existsSync(target) && fs.existsSync(`${target}.js`)) target = `${target}.js`;
          if (fs.existsSync(target) && fs.statSync(target).isDirectory()) target = path.join(target, "index.js");
          expect(fs.existsSync(target)).toBe(true);
          expect(ignored(path.relative(ROOT, target))).toBe(false);
        });
      }
    }
  }
});
