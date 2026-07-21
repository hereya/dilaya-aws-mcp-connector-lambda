// Login-page branding — unit tests over the auth Lambda's pure seams:
// rowByName (read _auth_config by column name, older tables lack the branding
// columns), sanitizeCss (defense-in-depth </style strip), and the login/OTP
// page renderers (title override, logo escaping, custom CSS slot).
// The AWS SDK modules are runtime-provided on Lambda and absent from
// devDependencies — virtual-mock them so the module loads under jest.
jest.mock("@aws-sdk/client-cognito-identity-provider", () => ({ CognitoIdentityProviderClient: class {}, InitiateAuthCommand: class {}, RespondToAuthChallengeCommand: class {} }), { virtual: true });
jest.mock("@aws-sdk/client-s3", () => ({ S3Client: class {}, GetObjectCommand: class {} }), { virtual: true });
jest.mock("@aws-sdk/client-ssm", () => ({ SSMClient: class {}, GetParameterCommand: class {} }), { virtual: true });
jest.mock("@aws-sdk/client-secrets-manager", () => ({ SecretsManagerClient: class {}, GetSecretValueCommand: class {} }), { virtual: true });
jest.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }), { virtual: true });
jest.mock(
  "@aws-sdk/lib-dynamodb",
  () => ({ DynamoDBDocumentClient: { from: () => ({ send: async () => ({}) }) }, GetCommand: class {} }),
  { virtual: true }
);

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __test__ } = require("../lib/auth-lambda/index.js");
const { rowByName, sanitizeCss, loginPage, otpPage } = __test__;

describe("rowByName", () => {
  it("maps the first record by column name", () => {
    const res = {
      columnMetadata: [{ name: "user_pool_client_id" }, { name: "from_email" }, { name: "login_title" }],
      records: [[{ stringValue: "client-1" }, { isNull: true }, { stringValue: "Mon espace" }]],
    };
    expect(rowByName(res)).toEqual({
      user_pool_client_id: "client-1",
      from_email: null,
      login_title: "Mon espace",
    });
  });

  it("returns null when there is no record", () => {
    expect(rowByName({ records: [] })).toBeNull();
    expect(rowByName({})).toBeNull();
  });

  it("older tables: absent branding columns simply yield no keys", () => {
    const res = {
      columnMetadata: [{ name: "user_pool_client_id" }],
      records: [[{ stringValue: "client-1" }]],
    };
    const row = rowByName(res)!;
    expect(row.user_pool_client_id).toBe("client-1");
    expect(row.custom_css).toBeUndefined();
  });
});

describe("sanitizeCss", () => {
  it("strips any </style close tag, case-insensitive", () => {
    expect(sanitizeCss("a{}</style><script>x</script>")).toBe("a{}><script>x</script>");
    expect(sanitizeCss("a{}</STYLE>")).toBe("a{}>");
  });
  it("passes ordinary CSS through and keeps null", () => {
    expect(sanitizeCss(".card{color:red}")).toBe(".card{color:red}");
    expect(sanitizeCss(null)).toBeNull();
  });
});

describe("loginPage branding", () => {
  it("default: i18n title, no logo, no custom style", () => {
    const html = loginPage("/ret", null, null, "fr", "");
    expect(html).toContain("<h1>Connexion</h1>");
    expect(html).toContain("<title>Connexion</title>");
    expect(html).not.toContain("login-logo\" src");
  });

  it("login_title replaces heading + tab title, HTML-escaped", () => {
    const html = loginPage("/ret", null, { loginTitle: "Espace <b>VIP</b>" }, "fr", "");
    expect(html).toContain("<h1>Espace &lt;b&gt;VIP&lt;/b&gt;</h1>");
    expect(html).toContain("<title>Espace &lt;b&gt;VIP&lt;/b&gt;</title>");
    expect(html).not.toContain("<h1>Connexion</h1>");
  });

  it("logo_url renders an escaped img above the heading", () => {
    const html = loginPage("/ret", null, { logoUrl: 'https://x.fr/l.png"onerror="x' }, "en", "");
    expect(html).toContain('src="https://x.fr/l.png&quot;onerror=&quot;x"');
  });

  it("customCss lands in a second style block after the shared one", () => {
    const html = loginPage("/ret", null, { customCss: ".card{border:1px solid red}" }, "en", "");
    const shared = html.indexOf("<style>");
    const custom = html.indexOf("<style>.card{border:1px solid red}</style>");
    expect(custom).toBeGreaterThan(shared);
  });
});

describe("otpPage branding", () => {
  it("keeps the i18n OTP heading but carries logo + css + tab title", () => {
    const html = otpPage("sess", "a@b.fr", "/ret", null, null, {
      loginTitle: "Mon espace",
      logoUrl: "https://x.fr/l.png",
      customCss: "h1{color:blue}",
    }, "fr");
    expect(html).toContain("<h1>Consultez vos emails</h1>");
    expect(html).toContain("<title>Mon espace</title>");
    expect(html).toContain('class="login-logo" src="https://x.fr/l.png"');
    expect(html).toContain("<style>h1{color:blue}</style>");
  });

  it("renders unbranded without a branding object", () => {
    const html = otpPage("sess", "a@b.fr", "/ret", null, null, null, "en");
    expect(html).toContain("<h1>Check your email</h1>");
    expect(html).toContain("<title>Verification code</title>");
  });
});
