// OpenAI plugin portal — domain verification for the MCP host (t_chatgpt_dir_dossier).
// The portal fetches https://<mcp host>/.well-known/openai-apps-challenge and
// expects this token VERBATIM (plain text). It is public by design: it proves
// control of the host, it grants nothing. Issued 04/10/2026 for app.dilaya.eu, reissued 05/10/2026 for mcp.dilaya.eu (the plugin host),
// org OpenAI « Novopattern ». Replace it here if the portal ever issues a new one.
export const OPENAI_APPS_CHALLENGE_TOKEN = "muvt8Z71n8V-aomUang6aM_ZvihTAycBEU5sVK-hUHg";

export const OPENAI_APPS_CHALLENGE_PATH = "/.well-known/openai-apps-challenge";
