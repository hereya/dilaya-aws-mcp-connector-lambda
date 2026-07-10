// Deploy-time re-stamp of the app-content ORIGIN-LOCK secret on every
// runtime-created BYOD org distribution.
//
// The shared app-content distribution is CloudFormation-managed, so a deploy
// with a new `appContentOriginSecret` updates its origin header declaratively.
// The per-org BYOD distributions are created AT RUNTIME by the connector —
// CloudFormation does not know them — so this Lambda runs DURING the deploy
// (CDK Trigger, re-fired when the secret changes) and converges them: list the
// distributions tagged `dilaya:byod=1`, compare each origin's
// `x-dilaya-origin-verify` header to the current secret, UpdateDistribution
// only when different. Idempotent; FAILS LOUDLY (a failed re-stamp fails the
// deploy — a silent skip would leave every custom domain 403 after a rotation).
//
// Zero-downtime rotation relies on the frontend authorizer's transitional
// acceptance of `appContentOriginSecretPrevious` while CloudFront propagates.
const {
  CloudFrontClient,
  GetDistributionConfigCommand,
  UpdateDistributionCommand,
} = require("@aws-sdk/client-cloudfront");
const {
  ResourceGroupsTaggingAPIClient,
  GetResourcesCommand,
} = require("@aws-sdk/client-resource-groups-tagging-api");

const HEADER = "x-dilaya-origin-verify";

exports.handler = async () => {
  const secret = process.env.ORIGIN_SECRET || "";
  if (!secret) {
    console.log("no origin secret configured — nothing to re-stamp");
    return { restamped: 0 };
  }

  // CloudFront is a global service — its tags live in us-east-1.
  const cf = new CloudFrontClient({ region: "us-east-1" });
  const tagging = new ResourceGroupsTaggingAPIClient({ region: "us-east-1" });

  const arns = [];
  let token;
  do {
    const res = await tagging.send(
      new GetResourcesCommand({
        TagFilters: [{ Key: "dilaya:byod", Values: ["1"] }],
        ResourceTypeFilters: ["cloudfront:distribution"],
        PaginationToken: token,
      })
    );
    for (const r of res.ResourceTagMappingList ?? []) arns.push(r.ResourceARN);
    token = res.PaginationToken || undefined;
  } while (token);
  console.log(`byod distributions found: ${arns.length}`);

  let restamped = 0;
  for (const arn of arns) {
    const id = arn.split("/").pop();
    const cur = await cf.send(new GetDistributionConfigCommand({ Id: id }));
    const config = cur.DistributionConfig;
    const etag = cur.ETag;
    let changed = false;
    for (const origin of config.Origins?.Items ?? []) {
      const items = origin.CustomHeaders?.Items ?? [];
      const existing = items.find(
        (h) => (h.HeaderName || "").toLowerCase() === HEADER
      );
      if (existing) {
        if (existing.HeaderValue !== secret) {
          existing.HeaderValue = secret;
          changed = true;
        }
      } else {
        items.push({ HeaderName: HEADER, HeaderValue: secret });
        changed = true;
      }
      origin.CustomHeaders = { Quantity: items.length, Items: items };
    }
    if (changed) {
      await cf.send(
        new UpdateDistributionCommand({
          Id: id,
          IfMatch: etag,
          DistributionConfig: config,
        })
      );
      restamped += 1;
      console.log(`re-stamped ${id}`);
    } else {
      console.log(`${id} already current`);
    }
  }
  return { restamped, total: arns.length };
};
