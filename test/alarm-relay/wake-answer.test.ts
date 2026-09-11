// --- Reading the connector's answer (2026-08-25) -----------------------------
// `LambdaClient.send` does NOT reject when the invoked function throws: the
// failure arrives as `FunctionError` on a 200. The first version of this relay
// ignored that and reported success for a connector that had just died — the
// silent-failure shape the whole feature exists to remove.
describe("alarm-relay wake: reading the connector's answer", () => {
  const sdkPath = "@aws-sdk/client-lambda";

  function withFakeLambda(response: any) {
    const logs = { warn: [] as string[], error: [] as string[] };
    jest.resetModules();
    jest.doMock(
      sdkPath,
      () => ({
        LambdaClient: class {
          async send() {
            if (response instanceof Error) throw response;
            return response;
          }
        },
        InvokeCommand: class {
          constructor(readonly input: unknown) {}
        },
      }),
      { virtual: true },
    );
    jest.spyOn(console, "warn").mockImplementation(((m: any) => {
      logs.warn.push(String(m));
    }) as any);
    jest.spyOn(console, "error").mockImplementation(((m: any) => {
      logs.error.push(String(m));
    }) as any);
    process.env.CONNECTOR_FUNCTION_NAME = "connector-fn";
    const { wakeAgent } = require("../../lib/alarm-relay/wake.js");
    return { wakeAgent, logs };
  }

  const ALARM = {
    AlarmName: "p-stack-SomeAlarm",
    NewStateValue: "ALARM",
    StateChangeTime: "2026-08-25T17:00:00.000+0000",
  };
  const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));

  afterEach(() => {
    jest.restoreAllMocks();
    jest.dontMock(sdkPath);
    delete process.env.CONNECTOR_FUNCTION_NAME;
  });

  it("a clean {ok:true} is a success", async () => {
    const { wakeAgent, logs } = withFakeLambda({ StatusCode: 200, Payload: enc({ ok: true }) });
    expect(await wakeAgent(ALARM)).toBeNull();
    expect(logs.error).toHaveLength(0);
    expect(logs.warn).toHaveLength(0);
  });

  // THE regression this block exists for.
  it("FunctionError on a 200 is a FAILURE, not a success", async () => {
    const { wakeAgent, logs } = withFakeLambda({
      StatusCode: 200,
      FunctionError: "Unhandled",
      Payload: enc({ errorType: "Error", errorMessage: "alarm ingest is not configured" }),
    });
    expect(await wakeAgent(ALARM)).toBeInstanceOf(Error);
    expect(logs.error.join(" ")).toContain("connector threw");
  });

  // A refusal is the connector's guard working. Worth logging — a relay sending
  // rubbish is a bug — but not worth failing the invocation over.
  it("a refusal is logged and does NOT fail the invocation", async () => {
    const { wakeAgent, logs } = withFakeLambda({
      StatusCode: 200,
      Payload: enc({ ok: false, refused: "tenant_selector" }),
    });
    expect(await wakeAgent(ALARM)).toBeNull();
    expect(logs.warn.join(" ")).toContain("refused");
    expect(logs.error).toHaveLength(0);
  });

  it("an unparseable answer is logged rather than swallowed", async () => {
    const { wakeAgent, logs } = withFakeLambda({ StatusCode: 200, Payload: enc("not-an-object") });
    expect(await wakeAgent(ALARM)).toBeNull();
    expect(logs.warn).toHaveLength(1);
  });

  it("a transport failure is still returned as an error", async () => {
    const { wakeAgent, logs } = withFakeLambda(new Error("network down"));
    expect(await wakeAgent(ALARM)).toBeInstanceOf(Error);
    expect(logs.error.join(" ")).toContain("agent wake failed");
  });
});
