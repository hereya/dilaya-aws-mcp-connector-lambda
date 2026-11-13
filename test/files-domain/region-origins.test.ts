import {
  MAX_REGIONS,
  parseFilesRegionOrigins,
  rewriteFunctionCode,
} from "../../lib/stack/files-transfer/region-origins";
import { CA, US, entry } from "./helpers";

// filesRegionOrigins: the parameter is the only thing between a typo and a
// distribution that sends one region's keys to another region's bucket, so
// anything odd fails the synth with the parameter's name in the message.
const HOME = { region: "eu-west-1", prefix: "p-x" };
const parse = (raw: string | undefined, home = HOME) => parseFilesRegionOrigins(raw, home);

describe("filesRegionOrigins parsing", () => {
  it("is an empty list when absent or empty — the feature is off", () => {
    expect(parse(undefined)).toEqual([]);
    expect(parse("")).toEqual([]);
    // Off means off: not even the home prefix is required.
    expect(parseFilesRegionOrigins(undefined, { region: undefined, prefix: undefined })).toEqual([]);
  });

  it("reads region:host:bucket-domain:prefix, comma-separated, in order", () => {
    expect(parse(entry(CA))).toEqual([CA]);
    expect(parse(` ${entry(US)} , ${entry(CA)} `)).toEqual([US, CA]);
  });

  it("keeps the storage prefix verbatim: object keys are case-sensitive", () => {
    expect(parse(entry({ ...CA, prefix: "P-Ca9" }))[0]!.prefix).toBe("P-Ca9");
  });

  it.each([
    ["three fields", "ca-central-1:app-ca.example.eu:b.s3.ca-central-1.amazonaws.com"],
    ["five fields", `${entry(CA)}:extra`],
    ["a region that is not one", entry({ ...CA, region: "canada" })],
    ["an upper-case region", entry({ ...CA, region: "CA-CENTRAL-1" })],
    ["a host with a scheme", entry({ ...CA, host: "https://app-ca.example.eu" })],
    ["a host with a path", entry({ ...CA, host: "app-ca.example.eu/x" })],
    ["a single-label host", entry({ ...CA, host: "localhost" })],
    ["a bucket NAME instead of its regional domain", entry({ ...CA, bucketDomain: "files-ca-test" })],
    ["a global bucket domain", entry({ ...CA, bucketDomain: "files-ca-test.s3.amazonaws.com" })],
    ["an empty prefix", entry({ ...CA, prefix: "" })],
    ["a prefix with a slash", entry({ ...CA, prefix: "a/b" })],
    ["a prefix with a wildcard", entry({ ...CA, prefix: "p-*" })],
    ["a prefix with a question mark", entry({ ...CA, prefix: "p-?" })],
    ["a prefix that could be a reserved path", entry({ ...CA, prefix: "_t" })],
    ["a prefix with a dot", entry({ ...CA, prefix: "p.ca" })],
    ["only separators", " , "],
  ])("refuses %s", (_name, raw) => {
    expect(() => parse(raw)).toThrow(/^filesRegionOrigins: /);
  });

  it("refuses a bucket that is not in the entry's region", () => {
    expect(() => parse(entry({ ...CA, bucketDomain: US.bucketDomain }))).toThrow(/is not in ca-central-1/);
  });

  it("refuses the pod's own region and its own storage prefix", () => {
    expect(() => parse(entry({ ...CA, region: "eu-west-1", bucketDomain: "b-eu.s3.eu-west-1.amazonaws.com" }))).toThrow(/own region/);
    expect(() => parse(entry({ ...CA, prefix: HOME.prefix }))).toThrow(/own storage prefix/);
  });

  it("refuses to run without the pod's own prefix: its keys could then match a region's path", () => {
    expect(() => parse(entry(CA), { region: "eu-west-1", prefix: undefined as unknown as string })).toThrow(/s3Prefix/);
  });

  it("refuses a region, a host or a prefix listed twice", () => {
    expect(() => parse(`${entry(CA)},${entry(CA)}`)).toThrow(/region ca-central-1 listed twice/);
    expect(() => parse(`${entry(CA)},${entry({ ...US, host: CA.host })}`)).toThrow(/host .* listed twice/);
    expect(() => parse(`${entry(CA)},${entry({ ...US, prefix: CA.prefix })}`)).toThrow(/prefix p-ca listed twice/);
  });

  it(`refuses more than ${MAX_REGIONS} regions (behaviors per distribution)`, () => {
    const many = ["us-east-1", "us-east-2", "us-west-1", "us-west-2", "ap-south-1", "ap-southeast-1", "sa-east-1"].map((region, i) =>
      entry({ region, host: `app${i}.example.eu`, bucketDomain: `b${i}x.s3.${region}.amazonaws.com`, prefix: `p-${i}` })
    );
    expect(parse(many.slice(0, MAX_REGIONS).join(","))).toHaveLength(MAX_REGIONS);
    expect(() => parse(many.join(","))).toThrow(/at most 6/);
    expect(2 + 3 * MAX_REGIONS).toBeLessThanOrEqual(25);
  });
});

// The rewrite runs on the byte path of a region's form POST and on its /_t
// lookup. The region router once passed its tests and blew the instruction
// limit on real input; this one cannot depend on its input at all.
describe("files region rewrite function", () => {
  const run = (code: string, request: any) =>
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function(`${code}\nreturn handler;`)()({ request });

  it.each([
    ["/", "/_u/ca-central-1"],
    ["/_t", "/_t/ca-central-1"],
  ] as const)("rewrites the URI to %s and touches nothing else", (target, uri) => {
    const request = { method: "POST", uri, querystring: { a: { value: "1" } }, headers: { "content-type": { value: "text/plain" } }, cookies: {} };
    const out = run(rewriteFunctionCode(target), request);
    expect(out).toEqual({ ...request, uri: target });
  });

  it("gives the same answer whatever the request carries — nothing is read from it", () => {
    const code = rewriteFunctionCode("/");
    const huge = { method: "POST", uri: "/" + "x".repeat(8000), querystring: {}, headers: { authorization: { value: "y".repeat(8000) } } };
    expect(run(code, huge).uri).toBe("/");
    expect(run(code, { uri: "" }).uri).toBe("/");
  });

  it("is a single constant assignment: under 100 bytes, no branch, no loop, no call", () => {
    for (const target of ["/", "/_t"] as const) {
      const code = rewriteFunctionCode(target);
      expect(Buffer.byteLength(code, "utf8")).toBeLessThan(100);
      const body = code.slice(code.indexOf("{") + 1, code.lastIndexOf("}"));
      expect(body).toBe(`var r=event.request;r.uri=${JSON.stringify(target)};return r;`);
      expect(body).not.toMatch(/\b(if|for|while|do|switch|try)\b|\?|&&|\|\||\(/);
    }
  });
});
