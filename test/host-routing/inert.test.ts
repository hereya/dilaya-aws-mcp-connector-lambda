import { buildInertTemplate, useInertEnv } from "./helpers";

describe("app-content host-routing inert without appContentDomain", () => {
  useInertEnv();

  const build = buildInertTemplate;

  it("creates no CloudFront function/distribution and no APP_CONTENT_* env", () => {
    const t = build();
    t.resourceCountIs("AWS::CloudFront::Function", 0);
    t.resourceCountIs("AWS::CloudFront::Distribution", 0);
    const json = JSON.stringify(t.toJSON());
    expect(json).not.toContain("APP_CONTENT_DOMAIN");
    expect(json).not.toContain("apphost-router");
    expect(json).not.toContain("x-dilaya-app-host");
  });
});
