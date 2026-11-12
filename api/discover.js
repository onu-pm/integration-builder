// Read the API docs and find the read-only endpoints that return the fields the developer asked for.
import { RULES, calendlyReference, fetchDocs, injectionHits, lastModelUsed, llm, rateLimited, readBody, send } from "./_lib/core.js";

const SHAPE = `{
 "base_url": "https://... (UNKNOWN if not stated)",
 "auth": {"type": "bearer | api_key_header | api_key_query | basic | oauth2 | none", "header": "header name, e.g. Authorization", "prefix": "e.g. 'Bearer ' or '' ", "query_param": "name or null", "token_name": "what the docs call it, e.g. Personal Access Token", "get_key_steps": ["short step to get a key from a free or trial account", "..."], "key_page_url": "https://... page where the key is created, or null", "free_tier": "one line on free/trial access, or UNKNOWN", "extra_headers": [{"name": "e.g. Notion-Version", "value": "e.g. 2022-06-28", "why": "required by the API"}]},
 "endpoints": [{"id": "short-id", "module": "docs section it belongs to, e.g. Users", "method": "GET", "path": "/v1/things/{id}", "summary": "what it returns, one line", "params": [{"name": "...", "in": "query | path", "required": true, "example": "realistic example value", "about": "one line"}], "fields": [{"field": "requested field key", "json_path": "data[].email"}], "scopes": ["exact scope/permission names, or UNKNOWN"], "docs_url": "https://... page for this endpoint, or null"}],
 "field_map": [{"field": "requested field key", "endpoint": "endpoint id or null", "json_path": "where it is in the response, or null", "status": "found | plan | missing", "note": "plan restriction or why it's missing, or null"}],
 "pagination": "how paging works, one line",
 "rate_limits": "one line",
 "unknowns": ["things the docs don't state"]
}`;

function normalise(x) {
  if (Array.isArray(x)) x = x.find((v) => v && typeof v === "object" && !Array.isArray(v)) || null;
  if (!x || typeof x !== "object") return null;
  if (!Array.isArray(x.endpoints)) {
    const inner = Object.values(x).find((v) => v && typeof v === "object" && !Array.isArray(v) && Array.isArray(v.endpoints));
    if (inner) x = inner;
  }
  if (!Array.isArray(x.endpoints)) {
    const alt = x.apis || x.endpoint_list || x.requests || (x.endpoint && [].concat(x.endpoint));
    if (Array.isArray(alt)) x.endpoints = alt;
    else if (x.endpoints && typeof x.endpoints === "object") x.endpoints = Object.entries(x.endpoints).map(([id, e]) => ({ id, ...e }));
  }
  return Array.isArray(x.endpoints) ? x : null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Use POST" });
  if (rateLimited(req, 30)) return send(res, 429, { error: "You've used this hour's AI runs from this network. Try again in an hour." });
  try {
    const { app = "", docsUrl = "", docsText = "", fields = [] } = await readBody(req);
    const wanted = (Array.isArray(fields) ? fields : []).map((f) => String(typeof f === "string" ? f : f?.key || "").trim().slice(0, 60)).filter(Boolean).slice(0, 25);
    const appName = String(app).trim().slice(0, 80) || "the app";
    const isCalendly = appName.toLowerCase() === "calendly";

    let docs = "", source = "", pages = 0;
    if (docsText && String(docsText).trim().length >= 200) {
      docs = String(docsText).slice(0, 200_000); source = "pasted";
    } else if (docsUrl) {
      try { const d = await fetchDocs(String(docsUrl), wanted); docs = d.text; pages = d.pages; source = d.via === "rendered" ? "rendered" : d.via === "openapi" ? "openapi" : "fetched"; }
      catch (e) { docs = ""; source = "fetch_failed:" + e.message; }
      if (docs.length < 1500) {
        if (isCalendly) { docs = calendlyReference(); source = "reference"; }
        else if (source.startsWith("fetch_failed:")) return send(res, 422, { error: `Couldn't open the docs link (${source.slice(13)}). Paste the API reference text instead.`, needPaste: true });
        else return send(res, 422, { error: "The docs page had almost no readable text (it may need a login). Paste the API reference text instead.", needPaste: true });
      }
    } else {
      return send(res, 400, { error: "Add the docs link or paste the documentation text." });
    }
    if (isCalendly && source !== "reference") docs += "\n\n=== CHECKED CALENDLY REFERENCE ===\n" + calendlyReference();

    const hits = injectionHits(docs);
    if (hits.length) return send(res, 422, { error: "Stopped: the documentation contains text aimed at the AI (possible prompt injection). Paste a clean copy of the reference instead.", injection: hits });

    const prompt = `${RULES}

<documentation app="${appName}">
${docs.slice(0, 150_000)}
</documentation>

${wanted.length ? `A developer needs these fields from ${appName}: ${JSON.stringify(wanted)}.
Find the read-only (GET) endpoints in the documentation that return them. Use as few endpoints as possible, and include any endpoint that must be called first to get an ID another endpoint needs (for example "get current user" to get an organization ID). At most 6 endpoints.`
 : `A developer is starting an integration with ${appName} and hasn't picked fields yet.
Show them what the API offers, organised like the docs: set "module" on each endpoint to the docs section it belongs to (e.g. Users, Organizations, Events). Cover each main module with its key read-only (GET) endpoints, usually "list" and "get one". Start with any "get current user/account" endpoint. Up to 6 modules and at most 14 endpoints in total. For each, list up to 8 of the most useful fields it returns in "fields" (use the API's own field names as "field").`}
Paths must be exactly as documented, relative to base_url, with path parameters in {braces}. Give realistic example values for parameters (never real secrets).
For auth, describe how a developer gets a key on a free or trial account, in 2 to 4 short steps.
Reply with ONLY a JSON object of exactly this shape (short strings, no markdown):
${SHAPE}
${wanted.length ? "field_map must have one entry per requested field, in the same order." : "field_map must be an empty list."} status: "found" = an endpoint returns it, "plan" = only on some plans, "missing" = the API doesn't offer it (never invent an endpoint).`;

    // The model sometimes wraps the object (in a list, or under one key) or renames "endpoints". Normalise, and ask once more if it's still unusable.
    let u = null; const t0 = Date.now();
    for (let attempt = 0; attempt < 2 && !u; attempt++) {
      if (attempt && Date.now() - t0 > 25000) break; // no time left for a second try inside Vercel's 60s
      try { u = normalise(await llm(attempt ? prompt + "\nIMPORTANT: reply with one JSON object whose top-level keys are exactly those in the shape above." : prompt, { maxOutputTokens: 12288, budgetMs: attempt ? 20000 : 35000 })); }
      catch (e) { if (attempt || e.status === 429 || e.status === 503) throw e; }
      if (!u) console.error("discover: unusable AI answer shape, retrying");
    }
    if (!u) return send(res, 502, { error: "The AI couldn't map these fields to endpoints just now. Try again, or paste the docs section for these fields." });
    const str = (v, n = 300) => (v == null ? null : String(v).slice(0, n));
    u.base_url = str(u.base_url, 200) || "UNKNOWN";
    u.auth = u.auth && typeof u.auth === "object" ? u.auth : { type: "bearer" };
    u.auth.get_key_steps = Array.isArray(u.auth.get_key_steps) ? u.auth.get_key_steps.slice(0, 5).map((s) => str(s)) : [];
    u.auth.extra_headers = Array.isArray(u.auth.extra_headers) ? u.auth.extra_headers.filter((h) => h && h.name).slice(0, 4) : [];
    u.endpoints = u.endpoints.filter((e) => e && e.path && String(e.method || "GET").toUpperCase() === "GET").slice(0, wanted.length ? 6 : 14).map((e, i) => ({
      id: str(e.id, 40) || "ep" + (i + 1), module: str(e.module, 40) || "", method: "GET", path: str(e.path, 200), summary: str(e.summary, 200) || "",
      params: Array.isArray(e.params) ? e.params.filter((p) => p && p.name).slice(0, 10) : [],
      fields: Array.isArray(e.fields) ? e.fields.filter((f) => f && f.field).slice(0, 25) : [],
      scopes: Array.isArray(e.scopes) ? e.scopes.map((s) => str(s, 80)).filter(Boolean).slice(0, 6) : [],
      docs_url: /^https:\/\//.test(e.docs_url || "") ? str(e.docs_url, 300) : null,
    }));
    u.field_map = Array.isArray(u.field_map) ? u.field_map.filter((f) => f && f.field) : [];
    if (!wanted.length) u.field_map = [];
    for (const w of wanted) if (!u.field_map.some((f) => f.field === w)) u.field_map.push({ field: w, endpoint: null, json_path: null, status: "missing", note: "Not found in the docs we read" });
    u.unknowns = Array.isArray(u.unknowns) ? u.unknowns.slice(0, 6) : [];
    if (!u.endpoints.length) return send(res, 200, { result: u, source, pages, docsChars: docs.length, model: lastModelUsed, noEndpoints: true });
    return send(res, 200, { result: u, source, pages, docsChars: docs.length, model: lastModelUsed });
  } catch (e) {
    return send(res, e.status || 500, { error: e.message || "Something went wrong" });
  }
}
