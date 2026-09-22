// What the connector Handler's environment will WEIGH once CloudFormation has
// resolved it (t_env_4kb_headroom). Lambda refuses an environment over 4 KB, and
// nothing measured it before the real deploy: release 0.1.302 died on 4152 bytes.
//
// A synthesized template holds tokens (`Ref`, `Fn::GetAtt`, `Fn::Join`), not
// values, so each token is priced at what the SAME reference resolves to in
// production (measured on the live Handler, 2026-09-22). A reference to a type
// this table does not know throws: pricing it is a decision, not a default.

/** Resolved length of `Ref` on a resource of this type, as seen in prod. */
const REF: Record<string, number> = {
  "AWS::Lambda::Function": 64, // a NAME; prod's trigger names are 62–63
  "AWS::Lambda::LayerVersion": 72, // an ARN ending in :<version> — 70 today
  "AWS::IAM::ManagedPolicy": 110, // an ARN
  "AWS::DynamoDB::Table": 74,
  "AWS::Logs::LogGroup": 77,
  "AWS::S3::Bucket": 63, // S3's own maximum
  "AWS::ApiGatewayV2::Api": 10,
  "AWS::ApiGatewayV2::Authorizer": 6,
  "AWS::ApiGatewayV2::Integration": 7,
  "AWS::CloudFront::Distribution": 14,
  "AWS::CloudFront::CachePolicy": 36,
  "AWS::CloudFront::OriginRequestPolicy": 36,
};

/** Resolved length of `Fn::GetAtt [<resource>, <attr>]`, as seen in prod. */
const GETATT: Record<string, number> = {
  "AWS::IAM::Role.Arn": 95,
  "AWS::CloudFront::KeyValueStore.Arn": 85,
  "AWS::CloudFront::OriginAccessControl.Id": 14,
};

/** Literals a synth cannot know: the hosted-zone lookup answers "DUMMY" offline. */
const LITERAL: Record<string, number> = { HOSTED_ZONE_ID: 21 };

type Resources = Record<string, { Type: string }>;

function valueLength(v: unknown, resources: Resources): number {
  if (typeof v === "string") return v.length;
  const o = v as Record<string, any>;
  if (o.Ref !== undefined) {
    const type = resources[o.Ref]?.Type;
    if (type && REF[type] !== undefined) return REF[type];
    throw new Error(`env-size: no price for Ref on ${type ?? o.Ref}`);
  }
  if (o["Fn::GetAtt"]) {
    const [id, attr] = o["Fn::GetAtt"];
    const key = `${resources[id]?.Type}.${attr}`;
    if (GETATT[key] !== undefined) return GETATT[key];
    throw new Error(`env-size: no price for GetAtt ${key}`);
  }
  if (o["Fn::Join"]) {
    const [sep, parts] = o["Fn::Join"] as [string, unknown[]];
    return parts.reduce<number>((n, p) => n + valueLength(p, resources), 0) + sep.length * (parts.length - 1);
  }
  throw new Error(`env-size: cannot price ${JSON.stringify(v)}`);
}

/**
 * Bytes of `{"KEY":"value",...}` once resolved — the JSON form, which is the
 * larger of the two ways to count (keys+values alone is ~6 bytes/variable less).
 */
export function resolvedEnvBytes(vars: Record<string, unknown>, resources: Resources): number {
  const entries = Object.entries(vars);
  const body = entries.reduce(
    (n, [k, v]) => n + k.length + (LITERAL[k] ?? valueLength(v, resources)) + 6, // "k":"v",
    0
  );
  return body + 2 - (entries.length ? 1 : 0); // braces, no trailing comma
}
