import { BOTH, setupTemplateHarness } from "./helpers";

// Node 24 (0.1.114) raised the resident size of every small Lambda. Measured
// from the REPORT lines on 2026-10-25, on the 128 MB defaults:
//   AlarmRelay        122 MB  (100–109 MB over 39 runs on Node 22)
//   AuthLambdaHandler 118 MB  (avg 117 over 146 runs)
//   Verify/CreateAuthChallenge triggers 105 / 101 MB
// An OOM in the relay is the worst kind: the alert never reaches Telegram and
// nothing else says so, because the relay IS the alert path. An OOM in the
// auth Lambda or a Cognito trigger is a failed sign-in on a customer frontend.
// Kept at 256 MB, not trimmed back: at a few hundred invocations a day at most,
// the doubled GB-seconds cost is noise.
describe("Lambda memory headroom on Node 24", () => {
  const { template } = setupTemplateHarness();

  const MUST_HAVE_256 = [
    "AlarmRelay",
    "AuthLambdaHandler",
    "PreSignUpTrigger",
    "CreateAuthChallengeTrigger",
    "DefineAuthChallengeTrigger",
    "VerifyAuthChallengeTrigger",
  ];

  test.each(MUST_HAVE_256)("%s runs with at least 256 MB", (prefix) => {
    const fns = template(BOTH).findResources("AWS::Lambda::Function");
    const hits = Object.entries(fns).filter(([id]) => id.startsWith(prefix));
    // A renamed construct would otherwise make this pass vacuously.
    expect(hits.length).toBeGreaterThanOrEqual(1);
    for (const [, fn] of hits) {
      expect(fn.Properties.MemorySize).toBeGreaterThanOrEqual(256);
    }
  });
});
