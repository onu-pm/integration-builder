// Generate the integration files from the reviewed spec, in the chosen language.
import { RULES, gemini, rateLimited, readBody, send } from "./_lib/core.js";
import { lastModelUsed } from "./_lib/core.js";

const LANGS = {
  python: { label: "Python", lib: "the requests library", ext: ".py", example: "client.py, auth.py, users.py, usage.py, pagination.py, errors.py, logging_config.py, mapping.py" },
  typescript: { label: "Node.js (TypeScript)", lib: "the built-in fetch API (Node 18+)", ext: ".ts", example: "client.ts, auth.ts, users.ts, usage.ts, pagination.ts, errors.ts, logger.ts, mapping.ts" },
  java: { label: "Java", lib: "java.net.http.HttpClient and Jackson", ext: ".java", example: "ApiClient.java, Auth.java, Users.java, Usage.java, Pagination.java, ApiErrors.java, Log.java, Mapping.java" },
  go: { label: "Go", lib: "net/http and encoding/json", ext: ".go", example: "client.go, auth.go, users.go, usage.go, pagination.go, errors.go, logging.go, mapping.go" },
};

export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Use POST" });
  if (rateLimited(req)) return send(res, 429, { error: "Too many requests from this network. Try again in an hour." });
  try {
    const { app = "", understanding, language = "python", fields = [], part = 0 } = await readBody(req);
    const wanted = (Array.isArray(fields) ? fields : []).slice(0, 30).map((f) => `${String(f.key || "").slice(0, 40)} (${String(f.label || "").slice(0, 60)})`).filter((s) => !s.startsWith(" "));
    if (!understanding || typeof understanding !== "object") return send(res, 400, { error: "Missing the reviewed understanding." });
    const L = LANGS[language] || LANGS.python;
    const appName = String(app).slice(0, 80) || "the app";

    const all = L.example.split(", ");
    const names = part === 1 ? all.slice(0, 4) : part === 2 ? all.slice(4) : all;
    const contract = `Shared interface (all files are written separately, so use exactly these names, adapted to ${L.label} naming style): client: ApiClient with get(path, params) returning parsed JSON; auth: getToken() reading an environment variable; users: listUsers(client); usage: usageByUser(client, users); pagination: fetchAll(client, path, params, maxPages); errors: ApiError, RateLimitError, AuthError, PlanRestrictedError; logging: getLogger(name) with redact(text); mapping: mapUser(rawUser, usage).`;
    const out = await gemini(`${RULES}

Write a production-quality ${L.label} integration for ${appName} from this reviewed spec:
${JSON.stringify(understanding).slice(0, 20_000)}

Use ${L.lib}. Write ONLY these files now (use exactly these names): ${names.join(", ")}. The other files of the project are written separately.
${contract}
Responsibilities:
- client: the only HTTP gateway. GET only, host allow-list, reads rate-limit headers, retries 429 and 5xx with backoff.
- auth: token from an environment variable, or OAuth refresh if the app supports it.
- users / usage: retrieve users and usage exactly as the spec says.
- pagination: follow the app's paging to the last page, support a max pages limit.
- errors: one error type per documented error code.
- logging: structured JSON logs that mask tokens and emails (write REDACTED).
- mapping: map to the CloudEagle user record with exactly these fields: ${wanted.join(", ") || "the standard user record"}. Fields the spec's field_map marks "no" are always null; "plan" fields are null when the API refuses (403). Do not read any other personal data.
Reply with ONLY a JSON object: {"files": {"<file name>": "<file content>", ...}}
Keep each file concise (under 70 lines). No long comments.`, { maxOutputTokens: 12288 });

    const files = out?.files;
    if (!files || typeof files !== "object" || Object.keys(files).length < Math.min(4, names.length) - 1) {
      return send(res, 502, { error: "The AI's answer didn't include the files. Try again." });
    }
    const clean = {};
    for (const [name, content] of Object.entries(files).slice(0, 14)) {
      clean[String(name).replace(/[^\w./-]/g, "").slice(0, 80) || "file" + L.ext] = String(content);
    }
    return send(res, 200, { files: clean, language, model: lastModelUsed });
  } catch (e) {
    return send(res, e.status || 500, { error: e.message || "Something went wrong" });
  }
}
