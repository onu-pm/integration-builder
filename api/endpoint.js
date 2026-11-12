// Details for one endpoint the AI listed (parameters, body, response), read from its docs page.
import { RULES, fetchDocs, injectionHits, llm, rateLimited, readBody, send } from "./_lib/core.js";

const cache = new Map();

export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Use POST" });
  try {
    const { app = "", base_url = "", endpoint = {}, docsUrl = "" } = await readBody(req);
    const method = String(endpoint.method || "GET").toUpperCase().slice(0, 7), path = String(endpoint.path || "").slice(0, 200);
    if (!path) return send(res, 400, { error: "Missing endpoint." });
    const page = /^https:\/\//.test(endpoint.docs_url || "") ? endpoint.docs_url : docsUrl;
    if (!/^https?:\/\//.test(page || "")) return send(res, 400, { error: "No docs page for this endpoint." });
    const key = `${page}|${method} ${path}`;
    if (cache.has(key)) return send(res, 200, cache.get(key));
    if (rateLimited(req, 120, 60 * 60 * 1000, "detail")) return send(res, 429, { error: "Too many detail lookups from this network. Try again in an hour." });

    const words = path.split(/[/{}_-]+/).filter((w) => w.length > 2).concat(String(endpoint.summary || "").split(/\s+/).filter((w) => w.length > 3)).slice(0, 8);
    const d = await fetchDocs(page, words);
    if (injectionHits(d.text).length) return send(res, 422, { error: "The docs page contains text aimed at the AI, so it wasn't read." });
    const out = await llm(`${RULES.replace("- Read-only: only HTTP GET requests to the app's API. The only allowed POST is an OAuth token refresh to the app's own auth server.\n", "")}
<documentation app="${String(app).slice(0, 80)}">
${d.text.slice(0, 80_000)}
</documentation>
Describe this one endpoint of the ${app} API exactly as documented: ${method} ${path} (${String(endpoint.summary || "").slice(0, 140)}). Base URL: ${String(base_url).slice(0, 200)}.
Reply with ONLY JSON:
{"description": "one or two lines", "params": [{"name": "...", "in": "path | query | header", "required": true, "example": "realistic example, never a real secret", "about": "one line"}], "headers": [{"name": "...", "value": "..."}], "body": {"type": "json", "example": "pretty JSON string of a realistic request body"} or null, "response_example": "pretty JSON string of a typical success response (shortened), or empty", "scopes": ["permission names, or empty"]}
If the docs don't describe something, leave it empty. Never invent parameters.`, { maxOutputTokens: 6144, budgetMs: 30000 });
    const o = out && typeof out === "object" && !Array.isArray(out) ? out : {};
    const str = (v, n) => (typeof v === "string" ? v : v == null ? "" : JSON.stringify(v, null, 2)).slice(0, n);
    const detail = {
      description: str(o.description, 600),
      params: Array.isArray(o.params) ? o.params.filter((p) => p && p.name).slice(0, 25).map((p) => ({ name: String(p.name).slice(0, 60), in: ["path", "query", "header"].includes(p.in) ? p.in : "query", required: !!p.required, example: p.example == null ? "" : String(p.example).slice(0, 200), about: String(p.about || "").slice(0, 200) })) : [],
      headers: Array.isArray(o.headers) ? o.headers.filter((h) => h && h.name).slice(0, 8).map((h) => ({ name: String(h.name).slice(0, 60), value: String(h.value || "").slice(0, 200) })) : [],
      body: o.body && (o.body.example || typeof o.body === "object") && !["GET", "HEAD"].includes(method) ? { type: o.body.type === "form" ? "form" : "json", example: str(o.body.example ?? o.body, 8000) } : null,
      response_example: str(o.response_example, 6000),
      scopes: Array.isArray(o.scopes) ? o.scopes.map(String).slice(0, 6) : [],
    };
    const body = { detail };
    cache.set(key, body);
    return send(res, 200, body);
  } catch (e) {
    return send(res, e.status || 500, { error: e.message || "Couldn't read this endpoint's docs." });
  }
}
