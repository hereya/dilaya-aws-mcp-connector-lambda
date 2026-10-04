import * as cdk from "aws-cdk-lib/core";
import { Template } from "aws-cdk-lib/assertions";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DilayaConnectorLambdaStack } from "../lib/dilaya-aws-mcp-connector-lambda-stack";
import { OPENAI_APPS_CHALLENGE_TOKEN } from "../lib/stack/openai-challenge";

// t_chatgpt_dir_dossier (04/10/2026): OpenAI's plugin portal verifies the MCP
// host by fetching https://app.dilaya.eu/.well-known/openai-apps-challenge and
// expects the token VERBATIM — plain text, no JSON, no envelope.
describe("OpenAI domain-verification challenge", () => {
  let tmpRoot: string;
  const saved = { ...process.env };
  let template: Template;

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "connector-oai-"));
    fs.mkdirSync(path.join(tmpRoot, "dist"), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, "dist", "handler.js"), "exports.handler=async()=>({});");
    process.env.hereyaProjectRootDir = tmpRoot;
    process.env.oauthServerUrl = "https://dilaya.eu/oauth/connect";
    process.env.hereyaProjectEnv = "{}";
    delete process.env.customDomain;
    delete process.env.organizationId;
    const app = new cdk.App();
    const stack = new DilayaConnectorLambdaStack(app, "TestStack", {
      env: { account: "123456789012", region: "eu-west-1" },
    });
    template = Template.fromStack(stack);
  });

  afterAll(() => {
    process.env = saved;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("exposes a public GET route with no authorizer", () => {
    const routes = Object.values(template.findResources("AWS::ApiGatewayV2::Route"));
    const route = routes.find((r) => r.Properties.RouteKey === "GET /.well-known/openai-apps-challenge");
    expect(route).toBeDefined();
    expect(route!.Properties.AuthorizationType ?? "NONE").toBe("NONE");
  });

  it("answers the token verbatim as text/plain, and still serves the PRM", async () => {
    const fns = Object.values(template.findResources("AWS::Lambda::Function"));
    const prm = fns.find((f) => f.Properties.Environment?.Variables?.OPENAI_APPS_CHALLENGE);
    expect(prm).toBeDefined();
    const vars = prm!.Properties.Environment.Variables;
    expect(vars.OPENAI_APPS_CHALLENGE).toBe(OPENAI_APPS_CHALLENGE_TOKEN);

    const mod: { exports: { handler?: (e: unknown) => Promise<any> } } = { exports: {} };
    const env = { ...vars, SERVICE_URL: "https://app.dilaya.eu" };
    new Function("exports", "process", prm!.Properties.Code.ZipFile)(mod.exports, { env });

    const challenge = await mod.exports.handler!({ rawPath: "/.well-known/openai-apps-challenge" });
    expect(challenge.statusCode).toBe(200);
    expect(challenge.headers["Content-Type"]).toMatch(/^text\/plain/);
    expect(challenge.body).toBe(OPENAI_APPS_CHALLENGE_TOKEN);

    const prmRes = await mod.exports.handler!({ rawPath: "/.well-known/oauth-protected-resource" });
    expect(JSON.parse(prmRes.body).resource).toBe("https://app.dilaya.eu/mcp");
  });
});
