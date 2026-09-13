// The two pages the apphost router answers with when a site is STOPPED (value
// flag `x` in the host's KVS entry — see router-function.ts). They are spliced
// into the CloudFront Function source as JS SINGLE-QUOTED string literals, so
// NO APOSTROPHES anywhere in either body: a plain ' would terminate the literal
// and take every tenant site down with a syntax error (2026-08-29).
// Typographic U+2019 only.
//
// Two pages, because the two causes have different ways out, and telling a
// customer over their allowance that their subscription is paused would send
// them to a payment page that has nothing to fix.

const STYLE =
  "<style>body{font:16px/1.6 system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;" +
  "color:#1c1917;background:#faf9f7}main{max-width:32rem;padding:2rem;text-align:center}h1{font-size:1.25rem;" +
  "margin:0 0 .75rem}p{margin:0 0 .5rem;color:#57534e}</style>";

const HEAD = '<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">';

/** x = 2 — the org is fine but PAST ITS MONTHLY REQUEST ALLOWANCE. */
export const STOP_PAGE_ALLOWANCE =
  HEAD +
  "<title>Plafond mensuel atteint</title>" +
  STYLE +
  "<main><h1>Ce site a atteint son plafond mensuel</h1>" +
  "<p>Son espace a consommé le trafic inclus dans son forfait pour ce mois-ci. Rien ne se perd : le site revient " +
  "au début du mois prochain, ou dès que son propriétaire augmente son forfait.</p>" +
  "<p lang=en>This site has reached its monthly traffic allowance. Nothing is lost — it returns at the start of " +
  "next month, or as soon as its owner raises their plan.</p></main>";

/** x = 1 — the ORGANIZATION IS PAUSED (trial over, payment missing, or an operator's decision). */
export const STOP_PAGE_PAUSED =
  HEAD +
  "<title>Site en pause</title>" +
  STYLE +
  "<main><h1>Ce site est momentanément en pause</h1>" +
  "<p>Son espace est suspendu. Rien ne se perd : le site revient dès que son propriétaire réactive son espace.</p>" +
  "<p lang=en>This site is paused. Nothing is lost — it returns as soon as its owner reactivates their space.</p>" +
  "</main>";

/**
 * Strip the comment lines out of the function source before it ships.
 * CloudFront Functions are capped at 10 KB of code and the explanatory comments
 * in router-function.ts are worth ~4 KB of that budget; they document the
 * source, not the edge. Only whole-line `//` comments go (code lines are kept
 * byte-identical, which is what the substring tests pin).
 */
export function stripCommentLines(code: string): string {
  return code
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

/** The CloudFront Functions code-size limit (JS 2.0 runtime), in bytes. */
export const CLOUDFRONT_FUNCTION_MAX_BYTES = 10 * 1024;
