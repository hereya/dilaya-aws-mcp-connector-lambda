import { useStackFixture, metricFilterFor } from "./core-alarms/helpers";

// t_skills_plugin_path (05/10/2026): the plugin host. `mcp.<zone>` is a second
// custom domain on the SAME API, serving MCP at its root, so the directories
// get a URL without `/mcp` — while `<customDomain>/mcp` keeps serving everyone
// already connected, byte for byte.
const CUSTOM = {
  customDomain: "app.dilaya.eu",
  wildcardCertificateArn: "arn:aws:acm:eu-west-1:123456789012:certificate/x",
};

function resources(t: any, type: string): any[] {
  return Object.values(t.findResources(type));
}

function prmFn(t: any): any {
  return resources(t, "AWS::Lambda::Function").find(
    (f) => f.Properties.Environment?.Variables?.OPENAI_APPS_CHALLENGE
  );
}

async function prmResource(t: any, domainName: string): Promise<string> {
  const fn = prmFn(t);
  const env = { ...fn.Properties.Environment.Variables, SERVICE_URL: "https://app.dilaya.eu" };
  const mod: { exports: { handler?: (e: unknown) => Promise<any> } } = { exports: {} };
  new Function("exports", "process", fn.Properties.Code.ZipFile)(mod.exports, { env });
  const res = await mod.exports.handler!({
    rawPath: "/.well-known/oauth-protected-resource",
    requestContext: { domainName },
  });
  return JSON.parse(res.body).resource;
}

describe("the plugin host mcp.<zone>", () => {
  const template = useStackFixture("connector-mcp-host-", "McpHostStack");

  it("maps a second custom domain on the same API, with its own DNS record", () => {
    const t = template(CUSTOM);
    const names = resources(t, "AWS::ApiGatewayV2::DomainName").map((d) => d.Properties.DomainName);
    expect(names.sort()).toEqual(["app.dilaya.eu", "mcp.dilaya.eu"]);
    expect(resources(t, "AWS::ApiGatewayV2::ApiMapping")).toHaveLength(2);
    const records = resources(t, "AWS::Route53::RecordSet").map((r) => r.Properties.Name);
    expect(records).toContain("mcp.dilaya.eu.");
  });

  it("serves MCP at the root behind the same authorizer as /mcp", () => {
    const t = template(CUSTOM);
    const routes = resources(t, "AWS::ApiGatewayV2::Route");
    const root = routes.find((r) => r.Properties.RouteKey === "POST /");
    const mcp = routes.find((r) => r.Properties.RouteKey === "POST /mcp");
    expect(root).toBeDefined();
    expect(root!.Properties.AuthorizationType).toBe("CUSTOM");
    expect(root!.Properties.AuthorizerId).toEqual(mcp!.Properties.AuthorizerId);
    expect(root!.Properties.Target).toEqual(mcp!.Properties.Target);
  });

  it("accepts a token bound to either resource, and tells the connector its host", () => {
    const t = template(CUSTOM);
    const fns = resources(t, "AWS::Lambda::Function");
    const authorizer = fns.find((f) => f.Properties.Environment?.Variables?.EXPECTED_AUDIENCE);
    expect(authorizer!.Properties.Environment.Variables.EXPECTED_AUDIENCE).toBe(
      "https://app.dilaya.eu/mcp,https://mcp.dilaya.eu,https://mcp.dilaya.eu/"
    );
    const handler = fns.find((f) => f.Properties.Environment?.Variables?.COGNITO_TRIGGER_LAMBDA_ARNS);
    expect(handler!.Properties.Environment.Variables.MCP_DOMAIN).toBe("mcp.dilaya.eu");
  });

  it("answers each host its own protected-resource metadata", async () => {
    const t = template(CUSTOM);
    expect(await prmResource(t, "mcp.dilaya.eu")).toBe("https://mcp.dilaya.eu");
    expect(await prmResource(t, "app.dilaya.eu")).toBe("https://app.dilaya.eu/mcp");
  });

  it("counts a refusal on the root like one on /mcp", () => {
    const t = template(CUSTOM);
    const pattern = metricFilterFor(t, "McpRefused").FilterPattern;
    expect(pattern).toContain('$.path = "/mcp" || $.path = "/"');
  });

  it("is off with mcpDomain='' — and without a custom domain at all", () => {
    for (const env of [{ ...CUSTOM, mcpDomain: "" }, {}]) {
      const t = template(env);
      const keys = resources(t, "AWS::ApiGatewayV2::Route").map((r) => r.Properties.RouteKey);
      expect(keys).not.toContain("POST /");
      const names = resources(t, "AWS::ApiGatewayV2::DomainName").map((d) => d.Properties.DomainName);
      expect(names).not.toContain("mcp.dilaya.eu");
    }
  });
});
