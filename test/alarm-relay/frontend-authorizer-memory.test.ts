import { BOTH, setupTemplateHarness } from "./helpers";
import { FRONTEND_AUTHORIZER_MEMORY_MB } from "../../lib/stack/frontend-authorizer";

// The frontend authorizer answers every request of every tenant site. Its
// memory setting is really a CPU setting: the first invocation of a sandbox
// does several TLS handshakes and first SDK calls, and on the smallest CPU
// share that first answer took seconds. Pinned so that a tidy-up does not
// quietly put the slow first answer back.
describe("frontend authorizer memory", () => {
  const { template } = setupTemplateHarness();

  test("runs with 1024 MB", () => {
    expect(FRONTEND_AUTHORIZER_MEMORY_MB).toBe(1024);
    const fns = template(BOTH).findResources("AWS::Lambda::Function");
    const hits = Object.entries(fns).filter(([id]) => id.startsWith("FrontendAuthorizerHandler"));
    // A renamed construct would otherwise make this pass vacuously.
    expect(hits.length).toBeGreaterThanOrEqual(1);
    for (const [, fn] of hits) expect(fn.Properties.MemorySize).toBe(1024);
  });
});
