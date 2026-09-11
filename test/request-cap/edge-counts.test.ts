// --- edge-served traffic (t_b8f659db595c) --------------------------------
//
// This authorizer only ever runs for requests that reach the ORIGIN. A cache
// hit and every path of a static-mode site are answered by CloudFront alone —
// measured in prod on 2026-08-28, `GET /` on a static tenant host returned
// 200 with zero invocations here. The connector folds the CloudFront access
// log into `edge_requests` on the same item; these tests hold the arithmetic
// that makes the two numbers safe to combine.

jest.mock("@aws-sdk/client-secrets-manager", () => require("./helpers").secretsManagerMock(), {
  virtual: true,
});
jest.mock("@aws-sdk/client-dynamodb", () => require("./helpers").dynamodbMock(), {
  virtual: true,
});
jest.mock("@aws-sdk/client-ssm", () => require("./helpers").ssmMock(), { virtual: true });
jest.mock("@aws-sdk/lib-dynamodb", () => require("./helpers").libDynamodbMock(), {
  virtual: true,
});

import { ORG, capSuiteSetup, load, siteEvent, state } from "./helpers";

describe("monthly request cap", () => {
  const capLines = capSuiteSetup();

  test("a static org past the cap is cut on the EDGE count alone", async () => {
    const a = load();
    state.orgCount = 12; // almost nothing reaches the origin: the site is static
    state.edgeCount = 1_050_001;
    expect((await a.handler(siteEvent(`/o/${ORG}/app1/site/api/x`))).isAuthorized).toBe(false);
    expect(capLines()[0].count).toBe(1_050_001);
  });

  // Adding the two would count every dynamic request twice — the log records
  // the SAME request the authorizer just counted — and would cut every
  // dynamic customer at half its allowance.
  test("the two counts are MAXed, never summed", async () => {
    const a = load();
    state.orgCount = 600_000;
    state.edgeCount = 600_000;
    expect((await a.handler(siteEvent(`/o/${ORG}/app1/site/x`))).isAuthorized).toBe(true);
    expect(capLines()).toHaveLength(0);
  });

  // Logs arrive minutes behind, so early in a month (and for the whole of the
  // first month after this ships) the edge figure trails the live one. It must
  // never drag the count DOWN.
  test("a lagging edge count never lowers the live one", async () => {
    const a = load();
    state.orgCount = 1_050_001;
    state.edgeCount = 3;
    expect((await a.handler(siteEvent(`/o/${ORG}/app1/site/api/x`))).isAuthorized).toBe(false);
    expect(capLines()[0].count).toBe(1_050_001);
  });

  test("an item with no edge count at all behaves exactly as before", async () => {
    const a = load();
    state.orgCount = 1_050_001;
    state.edgeCount = undefined;
    expect((await a.handler(siteEvent(`/o/${ORG}/app1/site/api/x`))).isAuthorized).toBe(false);
    expect(capLines()[0].count).toBe(1_050_001);
  });
});
