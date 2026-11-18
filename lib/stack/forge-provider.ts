import type { StackContext } from "./context";

/**
 * Which forge the connector serves the apps' source repos from — the connector's
 * own app param `forgeProvider`, handed to this package by name.
 *
 *   absent, "" or "github" → NOTHING is set: the connector's environment is
 *     byte-identical to before (its own default is GitHub);
 *   "forgejo"             → FORGE_PROVIDER=forgejo on the connector handler
 *     (the connector then registers its Forgejo forge, and only when the pod
 *     also carries forgejoUrl + forgejoAdminTokenParam — otherwise it fails
 *     closed for the source-repo tools; that check is the connector's);
 *   anything else          → the synth FAILS (a typo must not deploy as GitHub).
 *
 * The rollback is the parameter's removal (or "github"): the variable goes away.
 */
export const PARAM = "forgeProvider";
export const FORGE_PROVIDERS = ["github", "forgejo"] as const;

export function applyForgeProvider(ctx: StackContext): void {
  const value = process.env[PARAM];
  if (value === undefined || value === "" || value === "github") return;
  if (value !== "forgejo") {
    throw new Error(`${PARAM}: "${value.slice(0, 40)}" is not a forge — one of: ${FORGE_PROVIDERS.join(", ")} (absent = github)`);
  }
  ctx.fn.addEnvironment("FORGE_PROVIDER", "forgejo");
}
