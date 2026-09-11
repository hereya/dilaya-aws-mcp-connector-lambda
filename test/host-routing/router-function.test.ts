import {
  buildAppContentTemplate,
  fnCodeToString,
  useAppContentEnv,
} from "./helpers";

describe("app-content host-routing (appContentDomain set)", () => {
  useAppContentEnv();

  const build = buildAppContentTemplate;

  it("creates the KVS-backed router FUNCTION (JS 2.0) with the await hoisted out of call arguments", () => {
    const t = build();
    t.resourceCountIs("AWS::CloudFront::Function", 1);
    t.resourceCountIs("AWS::CloudFront::KeyValueStore", 1);
    const fns = t.findResources("AWS::CloudFront::Function");
    const [cfFn] = Object.values(fns) as any[];
    expect(cfFn.Properties.Name).toBe("app-app-apphost-router");
    expect(cfFn.Properties.FunctionConfig.Runtime).toBe("cloudfront-js-2.0");
    // The KVS is associated to the function (this is what binds cf.kvs()).
    expect(
      cfFn.Properties.FunctionConfig.KeyValueStoreAssociations
    ).toBeDefined();
    const code = fnCodeToString(cfFn.Properties.FunctionCode);
    // Routing table is DATA (KVS lookup) — never a baked map in the code.
    expect(code).toContain("cf.kvs()");
    expect(code).not.toContain("var HOSTMAP");
    // JS 2.0 rejects `await` inside a call ARGUMENT (prod 503, 2026-07-19):
    // the kvs.get await must be hoisted into its own statement.
    expect(code).toContain("var raw = await kvs.get(host);");
    expect(code).not.toMatch(/JSON\.parse\(await/);
    // Tags the viewer host for the origin.
    expect(code).toContain("request.headers['x-dilaya-app-host']");
    // Rewrites to the existing per-app site/auth routes (siteSeg = '/site',
    // or '/site-stg' for staging hosts).
    expect(code).toContain("'/o/' + e.o + '/' + e.a + siteSeg");
    // /static/* rewrites into the tenant's key prefix in the assets bucket
    // (`a` = the app folder name, '--stg'-suffixed on staging hosts).
    expect(code).toContain("'/_appstatic/' + e.o + '/' + a");
  });

  it("staging branch: KVS value flag `e:'s'` suffixes the S3 folders with --stg and routes dynamic paths to /site-stg; /auth stays shared", () => {
    const t = build();
    const fns = t.findResources("AWS::CloudFront::Function");
    const [cfFn] = Object.values(fns) as any[];
    const code = fnCodeToString(cfFn.Properties.FunctionCode);
    // One switch drives both the S3 folder suffix and the dynamic route segment.
    expect(code).toContain("if (e.e === 's') { a = e.a + '--stg'; siteSeg = '/site-stg'; }");
    // Defaults keep production hosts byte-identical in behavior.
    expect(code).toContain("var a = e.a;");
    expect(code).toContain("var siteSeg = '/site';");
    // The staging switch sits AFTER the redirect branch (a redirecting host
    // never serves) and BEFORE the /static rewrite (which consumes `a`).
    const switchAt = code.indexOf("if (e.e === 's')");
    expect(switchAt).toBeGreaterThan(code.indexOf("if (e.r)"));
    expect(switchAt).toBeLessThan(code.indexOf("'/_appstatic/'"));
    // Auth prefix stays env-less: one login flow serves both hosts.
    expect(code).toContain("? '/o/' + e.o + '/' + e.a\n");
  });

  it("static-SECTIONS branch (hybrid): prefix-listed paths swap to the S3 origin (OAC sigv4) with per-section SPA fallback; /api + /auth always dynamic", () => {
    const t = build();
    const fns = t.findResources("AWS::CloudFront::Function");
    const [cfFn] = Object.values(fns) as any[];
    const code = fnCodeToString(cfFn.Properties.FunctionCode);
    // Gated on the KVS value's `p` prefix list; /api/* and /auth/* are
    // excluded BEFORE prefix matching so a hybrid app keeps its Lambda API
    // and its login flow no matter what prefixes are declared.
    expect(code).toContain("if (e.p && e.p.length && uri !== '/api' && uri.indexOf('/api/') !== 0");
    expect(code).toContain("uri !== '/auth' && uri.indexOf('/auth/') !== 0");
    // Longest matching prefix wins; '/' matches everything (whole-site static).
    expect(code).toContain("pf === '/' || uri === pf || uri.indexOf(pf + '/') === 0");
    expect(code).toContain("pf.length > m.length");
    // Site files live under /_appsite/<org>/<app>/ in the static bucket
    // (app folder '--stg'-suffixed on staging hosts), and an extensionless
    // URI falls back to the SECTION's index.html.
    expect(code).toContain("'/_appsite/' + e.o + '/' + a");
    expect(code).toContain("(m === '/' ? '' : m) + '/index.html'");
    // Origin switch to S3 with OAC sigv4 signing, custom headers reset (the
    // API-GW origin-verify secret must never leak to S3).
    expect(code).toContain("cf.updateRequestOrigin(");
    expect(code).toContain('"signingProtocol": "sigv4"');
    expect(code).toContain('"originType": "s3"');
    expect(code).toContain('"customHeaders": {}');
    // The S3 domain is the deployment's static bucket (a CFN token at synth —
    // the flattened code carries the bucket's RegionalDomainName GetAtt).
    expect(code).toContain("RegionalDomainName");
  });

  it("canonical-redirect branch: KVS value flag `r` 301s to the target host preserving path + query, edge-cached 1h", () => {
    const t = build();
    const fns = t.findResources("AWS::CloudFront::Function");
    const [cfFn] = Object.values(fns) as any[];
    const code = fnCodeToString(cfFn.Properties.FunctionCode);
    // The redirect check runs right after the KVS parse — BEFORE the /static
    // and static-sections branches, so a redirecting host never serves content
    // in any mode.
    expect(code.indexOf("if (e.r)")).toBeGreaterThan(-1);
    expect(code.indexOf("if (e.r)")).toBeLessThan(code.indexOf("'/_appstatic/'"));
    // 301 to https://<r><path>?<query> (query rebuilt incl. multi-value keys).
    expect(code).toContain("var loc = 'https://' + e.r + request.uri;");
    expect(code).toContain("qs[k].multiValue");
    expect(code).toContain("statusCode: 301");
    expect(code).toContain("'cache-control': { value: 'public, max-age=3600' }");
  });
});
