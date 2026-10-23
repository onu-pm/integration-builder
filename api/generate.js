// Stage 4: generate the integration files from the reviewed spec.
import { RULES, gemini, rateLimited, readBody, send } from "./_lib/core.js";

const FILES = ["client.py", "auth.py", "users.py", "usage.py", "pagination.py", "errors.py", "logging_config.py", "mapping.py"];

export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Use POST" });
  if (rateLimited(req)) return send(res, 429, { error: "Too many requests from this network. Try again in an hour." });
  try {
    const { app = "", understanding } = await readBody(req);
    if (!understanding || typeof understanding !== "object") return send(res, 400, { error: "Missing the reviewed understanding." });
    const appName = String(app).slice(0, 80) || "the app";

    const out = await gemini(`${RULES}

Write a production-quality Python integration for ${appName} from this reviewed spec:
${JSON.stringify(understanding).slice(0, 20_000)}

Use the requests library. Files and responsibilities:
- client.py: the only HTTP gateway. GET only, host allow-list, reads rate-limit headers, retries 429 and 5xx with backoff.
- auth.py: token from environment variable, or OAuth refresh if the app supports it.
- users.py, usage.py: retrieve users and usage exactly as the spec says.
- pagination.py: follow the app's paging to the last page, support max_pages.
- errors.py: one exception per documented error code.
- logging_config.py: structured JSON logs that mask tokens and emails (REDACTED).
- mapping.py: map to the CloudEagle user record.
Reply with ONLY a JSON object: {"files": {${FILES.map((f) => `"${f}": "..."`).join(", ")}}}
Keep each file concise (under 80 lines).`, { maxOutputTokens: 16384 });

    const files = out?.files;
    if (!files || typeof files !== "object" || !files["client.py"]) {
      return send(res, 502, { error: "The AI's answer didn't include the files. Try again." });
    }
    const clean = {};
    for (const f of FILES) if (files[f] !== undefined) clean[f] = String(files[f]);
    return send(res, 200, { files: clean });
  } catch (e) {
    return send(res, e.status || 500, { error: e.message || "Something went wrong" });
  }
}
