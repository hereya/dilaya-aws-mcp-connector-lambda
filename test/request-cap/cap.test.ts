// The monthly request cap — the brake that CUTS.
//
// Two brakes sit on this path and they answer different questions. The per-IP
// guard is about a RUNAWAY: one address looping, throttled for a minute, back
// to normal on its own. This one is about the BILL: an organization consuming
// beyond its plan, for a whole month, whose site stops being served until the
// 1st of the next one.
//
// It was argued before it was built. The case against — a monthly cap that
// bites takes a WORKING site off the air for up to three weeks, and lands on
// the customer whose site succeeds — lost to the case for: unbounded exposure
// is worse than a bounded outage, and it is Jonatan's exposure to carry
// (2026-08-28). These tests hold the properties that make it survivable.

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

import { ORG, capSuiteSetup, load, orgCounterWrites, siteEvent, state } from "./helpers";

describe("monthly request cap", () => {
  const capLines = capSuiteSetup();

  test("counts the org's month in ONE atomic write, not a sum over apps", async () => {
    const a = load();
    await a.handler(siteEvent(`/o/${ORG}/app1/site/x`));
    const w = orgCounterWrites();
    expect(w).toHaveLength(1);
    const month = new Date().toISOString().slice(0, 16).slice(0, 7);
    expect(w[0].input.Key.pk).toBe(`reqcountorg#${ORG}#${month}`);
    expect(w[0].input.UpdateExpression).toContain("ADD");
    // Reads its own result — summing per-app rows would be N reads per request.
    // ALL_NEW rather than UPDATED_NEW so the edge count written by the
    // connector rides back on the same write (t_b8f659db595c).
    expect(w[0].input.ReturnValues).toBe("ALL_NEW");
  });

  test("well under the cap, the request is served", async () => {
    const a = load();
    state.orgCount = 500_000;
    const res = await a.handler(siteEvent(`/o/${ORG}/app1/site/x`));
    expect(res.isAuthorized).toBe(true);
    expect(capLines()).toHaveLength(0);
  });

  // The 5% margin is Jonatan's and it does real work: a month's counter is an
  // approximation (best-effort writes), so cutting at exactly 100% would cut
  // some customers early on a number that is not exact to the request.
  test("AT the cap it still serves — the 5% margin is deliberate", async () => {
    const a = load();
    state.orgCount = 1_000_000;
    expect((await a.handler(siteEvent(`/o/${ORG}/app1/site/x`))).isAuthorized).toBe(true);
    state.orgCount = 1_049_000;
    expect((await a.handler(siteEvent(`/o/${ORG}/app1/site/x`))).isAuthorized).toBe(true);
  });

  test("past the margin, the site is cut and the cut is written down", async () => {
    const a = load();
    state.orgCount = 1_050_001;
    const res = await a.handler(siteEvent(`/o/${ORG}/app1/site/api/x`));
    expect(res.isAuthorized).toBe(false);
    const line = capLines()[0];
    expect(line.org).toBe(ORG);
    expect(line.count).toBe(1_050_001);
    expect(line.cap).toBe(1_000_000);
  });

  // `null` is UNLIMITED — a decision, not a gap. Misreading it capped Dilaya's
  // own admin org for ten minutes on 2026-08-28.
  test("an org with NO cap is never cut, however high the count", async () => {
    const a = load();
    state.orgCap = null;
    state.orgCount = 999_000_000;
    expect((await a.handler(siteEvent(`/o/${ORG}/app1/site/x`))).isAuthorized).toBe(true);
    expect(capLines()).toHaveLength(0);
  });

  test("...but it is still COUNTED, so the figure exists the day it is capped", async () => {
    const a = load();
    state.orgCap = null;
    await a.handler(siteEvent(`/o/${ORG}/app1/site/x`));
    expect(orgCounterWrites()).toHaveLength(1);
  });

  // A lookup we cannot make must never be the reason a site goes dark.
  test("an unreadable cap does not cut", async () => {
    const a = load();
    state.capLookupThrows = true;
    state.orgCount = 999_000_000;
    expect((await a.handler(siteEvent(`/o/${ORG}/app1/site/x`))).isAuthorized).toBe(true);
  });

  test("an unwritable counter does not cut", async () => {
    const a = load();
    state.counterThrows = true;
    expect((await a.handler(siteEvent(`/o/${ORG}/app1/site/x`))).isAuthorized).toBe(true);
  });
});
