import * as path from "path";

/**
 * Key prefix every CloudFront access log lands under, in the one edge-log
 * bucket. Shared by the stack's app-content distribution and by the BYOD
 * per-org distributions the connector creates at runtime — the reader keys its
 * checkpoints on `<prefix><distributionId>.`, so one prefix is enough and a new
 * distribution needs no new configuration anywhere.
 */
export const EDGE_LOG_PREFIX = "cf/";

/**
 * The package's `lib/` directory — where the sibling Lambda sources that this
 * stack ships as assets live (`authorizer/`, `auth-lambda/`, `alarm-relay/`,
 * `cognito-triggers/`, …).
 *
 * The build steps import them by path, and they are NOT next to the step that
 * uses them: a step lives in `lib/stack/` (or a folder below it), so its own
 * `__dirname` points one or two levels too deep. Anchoring on this constant
 * keeps an asset path correct wherever the step is filed.
 */
export const LIB_DIR = path.join(__dirname, "..");
