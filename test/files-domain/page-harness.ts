// A minimal browser for the transfer page's script: scripted answers per URL,
// every fetch and every XHR recorded. Enough DOM for the script to render and
// for a test to pick a file and click "send".

/** What a POST to a URL answers: a status (2xx carries `material`), or a network failure. */
export type Answer = number | "network";

export interface PageRun {
  /** URLs fetched, in order, with the body each one carried. */
  fetched: Array<{ url: string; method: string; body: string }>;
  /** `open()` calls of the upload XHR. */
  posted: Array<{ method: string; url: string }>;
  /** Text of what the page shows now. */
  texts: () => string[];
  node: (tag: string) => any;
  /** Pick a 10-byte file and click the button. */
  upload: () => void;
  settle: () => Promise<void>;
}

export const EXPIRED = "Ce lien a expiré. Demandez un nouveau lien à l’assistant.";
export const NETWORK = "Erreur réseau. Vérifiez la connexion puis réessayez.";
export const ID = "AbCdEfGhIjKlMnOpQrStUv";

export const uploadMaterial = (region: string, prefix: string) => ({
  v: 1,
  op: "upload",
  path: "docs/a.txt",
  exp: Date.now() + 60_000,
  max: 1000,
  type: "text/plain",
  overwrite: false,
  fields: { key: `${prefix}/org/app/docs/a.txt`, "X-Amz-Credential": `AKIAEXAMPLE/20260101/${region}/s3/aws4_request` },
});
export const downloadMaterial = (prefix: string) => ({
  v: 1,
  op: "download",
  path: "docs/a.pdf",
  exp: Date.now() + 60_000,
  url: `/${prefix}/org/app/docs/a.pdf?X-Amz-Signature=1`,
});
export const inline = (material: unknown) => Buffer.from(JSON.stringify(material)).toString("base64url");

export function runPage(script: string, hash: string, answers: Record<string, Answer> = {}, material: unknown = null): PageRun {
  const fetched: PageRun["fetched"] = [];
  const posted: PageRun["posted"] = [];
  let nodes: any[] = [];
  const main = {
    appendChild: (n: any) => nodes.push(n),
    get textContent() { return ""; },
    set textContent(_v: string) { nodes = []; },
  };
  const document = {
    getElementById: () => main,
    createElement: (tag: string) => ({ tag, setAttribute(k: string, v: string) { (this as any)[k] = v; } }),
  };
  const fetch = (url: string, init: any) => {
    fetched.push({ url, method: init.method, body: init.body });
    const a = answers[url];
    if (a === undefined) throw new Error(`unexpected fetch ${url}`);
    if (a === "network") return Promise.reject(new TypeError("Failed to fetch"));
    return Promise.resolve({ status: a, ok: a >= 200 && a < 300, json: () => Promise.resolve(material) });
  };
  class XHR {
    upload: any = {};
    open(method: string, url: string) { posted.push({ method, url }); }
    send() {}
  }
  class FD { append() {} }
  const sandbox = {
    document, fetch, XMLHttpRequest: XHR, FormData: FD, Date, decodeURIComponent,
    location: { hash: "#" + hash }, navigator: { language: "fr" },
    atob: (b: string) => Buffer.from(b, "base64").toString("binary"), escape: globalThis.escape,
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(...Object.keys(sandbox), script)(...Object.values(sandbox));
  const node = (tag: string) => nodes.find((n) => n.tag === tag);
  return {
    fetched,
    posted,
    node,
    texts: () => nodes.map((n) => n.textContent),
    upload: () => {
      const input = node("input");
      input.files = [{ size: 10 }];
      input.onchange();
      node("button").onclick();
    },
    settle: async () => {
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    },
  };
}
