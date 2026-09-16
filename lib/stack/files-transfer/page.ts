import { createHash } from "crypto";
import { PAGE_SCRIPT } from "./page-script";

// The human transfer page (t_dad9f0e09ffb): one self-contained document, no
// external resource of any kind. Its script and style are pinned by hash in the
// CSP, so nothing but these exact bytes can run on the files host — the page
// shares an origin with every presigned file URL.

export const TRANSFER_PATH = "/_transfer";

const STYLE =
  "body{font:16px/1.6 system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;" +
  "color:#1c1917;background:#faf9f7}main{width:min(34rem,100% - 2rem);padding:2rem 0}" +
  "h1{font-size:1.25rem;margin:0 0 .75rem;overflow-wrap:anywhere}p{margin:0 0 .5rem;overflow-wrap:anywhere}" +
  ".muted{color:#57534e;font-size:.9rem}.err{color:#b91c1c}.ok{color:#15803d}" +
  "input,button,progress{display:block;width:100%;margin:.75rem 0;font:inherit}" +
  "button,.btn{padding:.7rem 1rem;border:0;border-radius:.5rem;background:#1c1917;color:#fff;cursor:pointer;" +
  "text-align:center;text-decoration:none;display:block;margin:1rem 0}button:disabled{opacity:.4;cursor:default}";

const sha256 = (s: string) => `'sha256-${createHash("sha256").update(s, "utf8").digest("base64")}'`;

export const TRANSFER_PAGE_HTML =
  '<!doctype html><html><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">' +
  "<meta name=robots content=noindex><title>Dilaya</title><style>" +
  STYLE +
  "</style></head><body><main id=m></main><script>" +
  PAGE_SCRIPT +
  "</script></body></html>";

// connect-src 'self' is where the upload goes; navigating to the download link
// is a navigation, which no fetch directive governs.
export const TRANSFER_PAGE_CSP =
  "default-src 'none'; " +
  `script-src ${sha256(PAGE_SCRIPT)}; style-src ${sha256(STYLE)}; ` +
  "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/**
 * Viewer-request function for the `/_transfer*` behavior: answers the page
 * itself and never forwards to the bucket. The HTML and the CSP travel as JSON
 * string literals, so no character in them can break the function's syntax.
 */
export function transferFunctionCode(): string {
  return [
    `var HTML=${JSON.stringify(TRANSFER_PAGE_HTML)};`,
    `var CSP=${JSON.stringify(TRANSFER_PAGE_CSP)};`,
    "function handler(event){",
    "var r=event.request;",
    `if(r.uri!==${JSON.stringify(TRANSFER_PATH)}&&r.uri!==${JSON.stringify(TRANSFER_PATH + "/")}){`,
    "return{statusCode:404,statusDescription:'Not Found',headers:{'content-type':{value:'text/plain; charset=utf-8'},'cache-control':{value:'no-store'}},body:'Not found'};}",
    "return{statusCode:200,statusDescription:'OK',headers:{",
    "'content-type':{value:'text/html; charset=utf-8'},",
    "'content-security-policy':{value:CSP},",
    "'cache-control':{value:'no-store'},",
    "'referrer-policy':{value:'no-referrer'},",
    "'x-content-type-options':{value:'nosniff'},",
    "'x-frame-options':{value:'DENY'},",
    "'x-robots-tag':{value:'noindex'},",
    "'strict-transport-security':{value:'max-age=31536000'}",
    "},body:HTML};}",
  ].join("\n");
}
