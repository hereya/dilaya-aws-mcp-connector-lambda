// OpenAI plugin portal — domain verification for the MCP host (t_chatgpt_dir_dossier).
// The portal fetches https://<mcp host>/.well-known/openai-apps-challenge and
// expects this token VERBATIM (plain text). It is public by design: it proves
// control of the host, it grants nothing. Issued 04/10/2026 for app.dilaya.eu,
// org OpenAI « Novopattern ». Replace it here if the portal ever issues a new one.
export const OPENAI_APPS_CHALLENGE_TOKEN = "z0W2GN8NrBnkHtCzPbS28Z6YvddUNzLN3r8j-X2tl6I";

export const OPENAI_APPS_CHALLENGE_PATH = "/.well-known/openai-apps-challenge";
