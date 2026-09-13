// The frontend authorizer's REFUSAL (t_frontend_auth_default, 0.1.73).
//
// Until now this authorizer answered "authorized, no identity" to everything,
// and the customer's handler was the only thing standing between an anonymous
// visitor and the site. One handler never redirected, and its site sat public
// while Claude had told its owner it was protected. With `authEnforce` on the
// app row, the PLATFORM refuses the anonymous request — the edge router's
// redirect is the UX in front of it, this is the guard.

jest.mock("@aws-sdk/client-secrets-manager", () => require("./helpers").secretsManagerMock(), { virtual: true });
jest.mock("@aws-sdk/client-dynamodb", () => require("./helpers").dynamodbMock(), { virtual: true });
jest.mock("@aws-sdk/client-ssm", () => require("./helpers").ssmMock(), { virtual: true });
jest.mock("@aws-sdk/lib-dynamodb", () => require("./helpers").libDynamodbMock(), { virtual: true });

import { ORG, event, load, state, suiteSetup } from "./helpers";

const SITE = `/o/${ORG}/shop/site`;

describe("frontend authorizer — enforce", () => {
  const enforcedLines = suiteSetup();

  test("an app without the flag keeps the legacy answer: authorized, anonymous", async () => {
    const a = load();
    const res = await a.handler(event(`${SITE}/orders`));
    expect(res.isAuthorized).toBe(true);
    expect(res.context.authenticated).toBe("false");
  });

  test("an enforced app REFUSES an anonymous site request, and says so in the log", async () => {
    const a = load();
    state.appRow = { authEnforce: true };
    const res = await a.handler(event(`${SITE}/orders`));
    expect(res.isAuthorized).toBe(false);
    const line = enforcedLines()[0];
    expect(line.org).toBe(ORG);
    expect(line.app).toBe("shop");
    expect(line.reason).toBe("anonymous");
  });

  test("a cookie the pool cannot vouch for is refused too, as an invalid session", async () => {
    const a = load();
    state.appRow = { authEnforce: true };
    const res = await a.handler(event(`${SITE}/orders`, "dilaya_id_token=not.a.jwt"));
    expect(res.isAuthorized).toBe(false);
    expect(enforcedLines()[0].reason).toBe("invalid_session");
  });

  test("declared public prefixes, /static/*, and the auth tree stay open", async () => {
    const a = load();
    state.appRow = { authEnforce: true, publicPaths: JSON.stringify(["/menu", "/api/hooks"]) };
    for (const p of [`${SITE}/menu`, `${SITE}/menu/today`, `${SITE}/api/hooks/stripe`, `${SITE}/static/logo.png`, `/o/${ORG}/shop/auth/login`]) {
      expect((await a.handler(event(p))).isAuthorized).toBe(true);
    }
    expect((await a.handler(event(`${SITE}/menus`))).isAuthorized).toBe(false);
    expect((await a.handler(event(`${SITE}/api/orders`))).isAuthorized).toBe(false);
  });

  test("staging site paths are gated like production", async () => {
    const a = load();
    state.appRow = { authEnforce: true };
    expect((await a.handler(event(`/o/${ORG}/shop/site-stg/orders`))).isAuthorized).toBe(false);
  });

  // A site born private has its flag set BEFORE its pool exists — enable-auth
  // may still be running, or may have failed. Nothing to verify against means
  // nobody gets in, not everybody.
  test("enforced with no pool yet → refused, not open", async () => {
    const a = load();
    state.appRow = { authEnforce: true };
    state.poolId = null;
    expect((await a.handler(event(`${SITE}/`))).isAuthorized).toBe(false);
  });

  test("a Data API blip refuses an enforced app and leaves a handler-guarded one anonymous", async () => {
    const a = load();
    state.dataApiThrows = true;
    expect((await a.handler(event(`${SITE}/x`))).isAuthorized).toBe(true);
    state.appRow = { authEnforce: true };
    expect((await a.handler(event(`${SITE}/x`))).isAuthorized).toBe(false);
  });

  test("a registry blip refuses site paths (enforced or not — we cannot tell) and spares the auth tree", async () => {
    const a = load();
    state.registryThrows = true;
    expect((await a.handler(event(`${SITE}/x`))).isAuthorized).toBe(false);
    expect((await a.handler(event(`/o/${ORG}/shop/auth/login`))).isAuthorized).toBe(true);
  });

  test("a garbled publicPaths attribute closes more, never less", async () => {
    const a = load();
    state.appRow = { authEnforce: true, publicPaths: "{not json" };
    expect((await a.handler(event(`${SITE}/menu`))).isAuthorized).toBe(false);
  });
});

describe("gatedPath — the same reading as the edge router", () => {
  const { gatedPath, siteRelativePath } = load().__test__;
  const enforced = (pub: string[] = []) => ({ enforce: true, publicPaths: pub });

  test("site-relative path", () => {
    expect(siteRelativePath(`${SITE}`)).toBe("/");
    expect(siteRelativePath(`${SITE}/`)).toBe("/");
    expect(siteRelativePath(`${SITE}/a/b`)).toBe("/a/b");
    expect(siteRelativePath(`/o/${ORG}/shop/site-stg/a`)).toBe("/a");
    expect(siteRelativePath(`/o/${ORG}/shop/auth/login`)).toBeNull();
    expect(siteRelativePath(`/o/${ORG}/shop/agent/poll`)).toBeNull();
  });

  test("'/' as a public path is the root page only", () => {
    expect(gatedPath(`${SITE}/`, enforced(["/"]))).toBe(false);
    expect(gatedPath(`${SITE}/anything`, enforced(["/"]))).toBe(true);
  });

  test("a prefix matches itself and its subtree, not its siblings", () => {
    expect(gatedPath(`${SITE}/menu`, enforced(["/menu"]))).toBe(false);
    expect(gatedPath(`${SITE}/menu/x`, enforced(["/menu"]))).toBe(false);
    expect(gatedPath(`${SITE}/menuz`, enforced(["/menu"]))).toBe(true);
  });

  test("nothing is gated on an app that does not enforce", () => {
    expect(gatedPath(`${SITE}/x`, { enforce: false, publicPaths: [] })).toBe(false);
    expect(gatedPath(`${SITE}/x`, null)).toBe(false);
  });
});
