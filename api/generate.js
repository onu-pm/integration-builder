// Generate the integration files from the reviewed spec, in the chosen language.
import { RULES, lastModelUsed, llm, rateLimited, readBody, send } from "./_lib/core.js";

const LANGS = {
  python: { label: "Python", lib: "the requests library", ext: ".py", example: "client.py, auth.py, endpoints.py, pagination.py, errors.py, logging_config.py, mapping.py, main.py" },
  typescript: { label: "Node.js (TypeScript)", lib: "the built-in fetch API (Node 18+)", ext: ".ts", example: "client.ts, auth.ts, endpoints.ts, pagination.ts, errors.ts, logger.ts, mapping.ts, main.ts" },
  java: { label: "Java", lib: "java.net.http.HttpClient and Jackson", ext: ".java", example: "ApiClient.java, Auth.java, Endpoints.java, Pagination.java, ApiErrors.java, Log.java, Mapping.java, Main.java" },
  go: { label: "Go", lib: "net/http and encoding/json", ext: ".go", example: "client.go, auth.go, endpoints.go, pagination.go, errors.go, logging.go, mapping.go, main.go" },
};

export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Use POST" });
  if (rateLimited(req, 30)) return send(res, 429, { error: "You've used this hour's AI runs from this network. Try again in an hour." });
  try {
    const { app = "", result: understanding, language = "python", fields = [], part = 0 } = await readBody(req);
    const wanted = (Array.isArray(fields) ? fields : []).map((f) => String(typeof f === "string" ? f : f?.key || "").trim().slice(0, 60)).filter(Boolean).slice(0, 25);
    if (!understanding || typeof understanding !== "object" || !Array.isArray(understanding.endpoints)) return send(res, 400, { error: "Find the APIs first." });
    const L = LANGS[language] || LANGS.python;
    const appName = String(app).slice(0, 80) || "the app";

    const all = L.example.split(", ");
    const names = part === 1 ? all.slice(0, 4) : part === 2 ? all.slice(4) : all;
    const ids = understanding.endpoints.map((e) => e.id).join(", ");
    const contract = `Shared interface (files are written separately, so use exactly these names, adapted to ${L.label} naming style): client: ApiClient with get(path, params) returning parsed JSON; auth: auth headers built from environment variables (APP_API_KEY by default); endpoints: one function per endpoint id (${ids}) taking the client and its parameters; pagination: fetchAll(client, path, params, maxPages); errors: ApiError, RateLimitError, AuthError; logging: getLogger(name) and redact(text); mapping: toRecord(raw) returning an object with exactly these keys: ${wanted.join(", ")} (null when the API doesn't return one); main: reads env vars, calls the endpoints in order, maps each item with toRecord and prints JSON.`;
    const out = await llm(`${RULES}

Write a clean, runnable ${L.label} client for ${appName} from this spec:
${JSON.stringify(understanding).slice(0, 20_000)}

Use ${L.lib}. Write ONLY these files now (exactly these names): ${names.join(", ")}. The other files of the project are written separately.
${contract}
- client: the only HTTP gateway. GET only, only the API's host, reads rate-limit headers, retries 429 and 5xx with backoff.
- auth: exactly as the spec's auth says (header name, prefix, extra headers).
- pagination: follow the API's paging to the last page, with a max pages limit.
- logging: structured JSON logs that mask tokens and emails (write REDACTED).
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
