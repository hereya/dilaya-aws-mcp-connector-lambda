import { useStackFixture } from "./core-alarms/helpers";

// t_rca_p1_router B2 (26/10/2026). The per-app name prefix (`<label>-app-`,
// env APP_LAMBDA_NAME_PREFIX) also names ACCOUNT-GLOBAL IAM roles the connector
// creates at runtime (`<prefix>role-shared`, `<prefix>role-<o8>-<a8>`) and the
// orphan-role sweep deletes by it. The ca-central-1 pod shares the account AND
// the public customDomain with Ireland: on the same prefix, its first
// deploy-backend would PutRolePolicy over the EU shared role (Data API ids of
// the CA region) and cut every EU app backend. A secondary pod therefore takes
// its prefix from the host it OWNS; a primary pod keeps the public one.
const PUBLIC = {
  customDomain: "app.dilaya.eu",
  wildcardCertificateArn: "arn:aws:acm:eu-west-1:123456789012:certificate/x",
};
const fnWith = (t: any, key: string) =>
  Object.values(t.findResources("AWS::Lambda::Function")).find(
    (f: any) => f.Properties.Environment?.Variables?.[key] !== undefined
  ) as any;
const prefixOf = (t: any) => fnWith(t, "APP_LAMBDA_NAME_PREFIX").Properties.Environment.Variables.APP_LAMBDA_NAME_PREFIX;

describe("regional pods: the per-app name prefix is distinct per pod", () => {
  const template = useStackFixture("connector-pod-prefix-", "PodPrefixStack");

  it("a secondary pod derives it from its originDomain — nothing named app-app-* is left", () => {
    const t = template({ ...PUBLIC, originDomain: "app-ca.dilaya.eu", skipGlobalResources: "true" });
    expect(prefixOf(t)).toBe("app-ca-app-");
    const json = JSON.stringify(t.toJSON());
    expect(json).toContain("function:app-ca-app-*");
    expect(json).toContain("/aws/lambda/app-ca-app-*");
    expect(json).not.toContain("app-app-");
  });

  it("a primary pod keeps the public label, with or without an origin host of its own", () => {
    expect(prefixOf(template(PUBLIC))).toBe("app-app-");
    expect(prefixOf(template({ ...PUBLIC, originDomain: "app-eu.dilaya.eu" }))).toBe("app-app-");
  });

  it("refuses a secondary origin whose first label is the public one (same prefix again)", () => {
    expect(() =>
      template({ ...PUBLIC, originDomain: "app.ca.dilaya.eu", skipGlobalResources: "true" })
    ).toThrow(/collide with the primary's IAM roles/);
  });
});
