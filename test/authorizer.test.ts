// Unit tests for the dual-mode claim authorization — the backward-compatible
// core. Signature + exp verification are exercised by the deployment; here we
// test the iss/org binding + context decisions that decide who gets in.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { authorizeClaims } = require("../lib/authorizer");

const CONNECT_ISS = "https://dilaya.eu/oauth/connect";
const BASE_ISS = "https://dilaya.eu";
const A = "org-a";
const B = "org-b";
const RESOURCE = "https://app.dilaya.eu/mcp";

const mtEnv = { oauthServerUrl: CONNECT_ISS, boundOrgId: "", expectedAudience: "" };

describe("multi-tenant connect mode (no bound org)", () => {
  it("authorizes a token whose org_ids set is non-empty and joins it to context", () => {
    const r = authorizeClaims(
      { iss: CONNECT_ISS, sub: "u1", org_ids: [A, B], org_role: "owner" },
      mtEnv
    );
    expect(r.isAuthorized).toBe(true);
    expect(r.context).toEqual({ userId: "u1", orgId: "", orgIds: `${A},${B}`, orgRole: "owner" });
  });

  it("denies when iss does not match the deploy issuer", () => {
    const r = authorizeClaims({ iss: BASE_ISS, sub: "u1", org_ids: [A] }, mtEnv);
    expect(r.isAuthorized).toBe(false);
  });

  it("denies when org_ids is missing or empty", () => {
    expect(authorizeClaims({ iss: CONNECT_ISS, sub: "u1" }, mtEnv).isAuthorized).toBe(false);
    expect(authorizeClaims({ iss: CONNECT_ISS, sub: "u1", org_ids: [] }, mtEnv).isAuthorized).toBe(false);
  });

  it("filters non-string org_ids entries and denies if nothing survives", () => {
    const r = authorizeClaims(
      { iss: CONNECT_ISS, sub: "u1", org_ids: [A, 123, null, ""] },
      mtEnv
    );
    expect(r.context.orgIds).toBe(A);
    expect(authorizeClaims({ iss: CONNECT_ISS, sub: "u1", org_ids: [null, ""] }, mtEnv).isAuthorized).toBe(false);
  });

  it("rejects a legacy per-org token (org_id, no org_ids)", () => {
    const r = authorizeClaims({ iss: CONNECT_ISS, sub: "u1", org_id: A }, mtEnv);
    expect(r.isAuthorized).toBe(false);
  });

  it("enforces the RFC 8707 audience when configured", () => {
    const env = { ...mtEnv, expectedAudience: RESOURCE };
    expect(
      authorizeClaims({ iss: CONNECT_ISS, sub: "u1", org_ids: [A], aud: RESOURCE }, env).isAuthorized
    ).toBe(true);
    expect(
      authorizeClaims({ iss: CONNECT_ISS, sub: "u1", org_ids: [A], aud: "https://evil/mcp" }, env)
        .isAuthorized
    ).toBe(false);
    expect(
      authorizeClaims({ iss: CONNECT_ISS, sub: "u1", org_ids: [A] }, env).isAuthorized
    ).toBe(false); // aud absent when required
  });
});

describe("legacy per-org mode (bound org) stays byte-for-byte", () => {
  const legacyEnv = { oauthServerUrl: BASE_ISS, boundOrgId: A, expectedAudience: "" };

  it("authorizes only the bound org and injects the single orgId", () => {
    const r = authorizeClaims(
      { iss: BASE_ISS, sub: "u1", org_id: A, org_role: "owner" },
      legacyEnv
    );
    expect(r.isAuthorized).toBe(true);
    expect(r.context).toEqual({ userId: "u1", orgId: A, orgRole: "owner" });
    expect(r.context.orgIds).toBeUndefined();
  });

  it("denies a token for a different org", () => {
    expect(
      authorizeClaims({ iss: BASE_ISS, sub: "u1", org_id: B }, legacyEnv).isAuthorized
    ).toBe(false);
  });

  it("denies a connect token (org_ids) presented to a legacy deployment", () => {
    expect(
      authorizeClaims({ iss: BASE_ISS, sub: "u1", org_ids: [A] }, legacyEnv).isAuthorized
    ).toBe(false);
  });

  it("denies on iss mismatch", () => {
    expect(
      authorizeClaims({ iss: CONNECT_ISS, sub: "u1", org_id: A }, legacyEnv).isAuthorized
    ).toBe(false);
  });
});

describe("garbage input is denied, never thrown", () => {
  it.each([null, undefined, "string", 42, []])("denies %p", (payload) => {
    expect(authorizeClaims(payload, mtEnv).isAuthorized).toBe(false);
  });
});
