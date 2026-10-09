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

  // t_dir_401_www_auth (09/10/2026): the chat runtime of ChatGPT probes the
  // plugin host WITHOUT an Authorization header. With that header as identity
  // source the gateway answers its own bare 401 (no WWW-Authenticate) before
  // the authorizer runs, and the client gives up ("reconnect Dilaya"). So the
  // root route has its OWN authorizer — same Lambda, NO identity source (always
  // invoked, like the frontend authorizer), NO cache (caching needs a source).
  // `/mcp` keeps the cached, header-keyed one byte for byte.
  it("serves MCP at the root behind its own always-invoked authorizer — same Lambda as /mcp", () => {
    const t = template(CUSTOM);
    const routes = resources(t, "AWS::ApiGatewayV2::Route");
    const root = routes.find((r) => r.Properties.RouteKey === "POST /");
    const mcp = routes.find((r) => r.Properties.RouteKey === "POST /mcp");
    expect(root).toBeDefined();
    expect(root!.Properties.AuthorizationType).toBe("CUSTOM");
    expect(root!.Properties.Target).toEqual(mcp!.Properties.Target);
    expect(root!.Properties.AuthorizerId).not.toEqual(mcp!.Properties.AuthorizerId);
    const authorizers = t.findResources("AWS::ApiGatewayV2::Authorizer");
    const byRef = (ref: any) => authorizers[ref.Ref].Properties;
    const rootAuth = byRef(root!.Properties.AuthorizerId);
    const mcpAuth = byRef(mcp!.Properties.AuthorizerId);
    expect(rootAuth.AuthorizerUri).toEqual(mcpAuth.AuthorizerUri);
    expect(rootAuth.EnableSimpleResponses).toBe(true);
    expect(rootAuth.IdentitySource).toEqual([]);
    expect(rootAuth.AuthorizerResultTtlInSeconds).toBe(0);
    expect(mcpAuth.IdentitySource).toEqual(["$request.header.Authorization"]);
    expect(mcpAuth.AuthorizerResultTtlInSeconds).toBe(300);
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
