// Build the full API reference for an app: every endpoint (all methods), grouped by module.
// Order of sources: Postman published docs → OpenAPI/Swagger JSON → AI reading the docs pages.
import { RULES, calendlyReference, fetchDocs, get, injectionHits, lastModelUsed, llm, rateLimited, readBody, send } from "./_lib/core.js";
import { loadPostman, parseOpenApi, postmanIds } from "./_lib/specs.js";
import { grantsFor } from "./_lib/grant.js";

const cache = new Map();
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

const AUTH_SHAPE = `{"type": "bearer | api_key_header | api_key_query | basic | oauth2 | none", "header": "header name or null", "prefix": "e.g. 'Bearer ' or ''", "query_param": "name or null", "token_name": "what the docs call the key", "get_key_steps": ["short steps to get a key from a free, trial, sandbox or test account"], "key_page_url": "https://... or null", "free_tier": "one line on sandbox/trial access, or UNKNOWN", "extra_headers": [{"name": "...", "value": "...", "why": "..."}]}`;

async function authHelp(app, text, eps) {
  const list = (eps || []).slice(0, 200).map((e) => `${e.id} | ${e.method} ${e.path} | ${e.summary}`).join("\n");
  try {
    const out = await llm(`${RULES}
<documentation app="${app}">
${text.slice(0, 60_000)}
</documentation>
How does a developer authenticate with the ${app} API, and how do they get a key or token from a sandbox, test, trial or free account? Is there a separate sandbox/test base URL?
${list ? `These endpoints have no module grouping. Group them into 3 to 10 modules named like API docs sections (e.g. Tests, Candidates, Invites, Organization):\n${list}\n` : ""}
Reply with ONLY JSON: {"auth": ${AUTH_SHAPE}, "sandbox_base_url": "https://... or null"${list ? `, "modules": {"<endpoint id>": "Module name"}` : ""}}`, { maxOutputTokens: list ? 6144 : 2048, budgetMs: 20000 });
    return out && typeof out === "object" ? out : {};
  } catch { return {}; }
}

function linksIn(raw, base) {
  const out = { postman: null, spec: null };
  const pm = raw.match(/https:\/\/documenter\.getpostman\.com\/view\/\d+\/[A-Za-z0-9]+/);
  if (pm) out.postman = pm[0];
  const sp = raw.match(/["'(]((?:https?:\/\/[^"'()\s]+)?\/[^"'()\s]*(?:openapi|swagger)[^"'()\s]*\.json)["')]/i);
  if (sp) { try { out.spec = new URL(sp[1], base).href; } catch {} }
  return out;
}

function normalise(x) {
  if (Array.isArray(x)) x = x.find((v) => v && typeof v === "object" && !Array.isArray(v)) || null;
  if (!x || typeof x !== "object") return null;
  if (!Array.isArray(x.modules)) { const inner = Object.values(x).find((v) => v && typeof v === "object" && Array.isArray(v.modules)); if (inner) x = inner; }
  if (!Array.isArray(x.modules) && Array.isArray(x.endpoints)) x.modules = [{ name: "General", endpoints: x.endpoints }];
  return Array.isArray(x.modules) ? x : null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Use POST" });
  try {
    const { app = "", docsUrl = "", docsText = "" } = await readBody(req);
    const appName = String(app).trim().slice(0, 80) || "the app";
    const url = String(docsUrl || "").trim();
    const key = (url || "text:" + String(docsText).length) + "|" + appName.toLowerCase();
    if (!docsText && cache.has(key)) return send(res, 200, cache.get(key));
    if (rateLimited(req, 30)) return send(res, 429, { error: "You've used this hour's AI runs from this network. Try again in an hour." });

    let R = null, docsForAuth = "", note = "";
    // 1) Postman published docs: exact and complete.
    if (postmanIds(url)) {
      try { R = await loadPostman(url); } catch (e) { note = "Couldn't read the Postman collection (" + e.message + "); read the page instead."; }
    }
    let docs = "", source = "", pages = 0;
    if (!R) {
      if (docsText && String(docsText).trim().length >= 200) { docs = String(docsText).slice(0, 200_000); source = "pasted"; }
      else if (url) {
        const [main, raw] = await Promise.allSettled([fetchDocs(url, []), get(url, 8000)]);
        if (raw.status === "fulfilled") {
          const l = linksIn(raw.value.raw, raw.value.url);
          if (l.postman) { try { R = await loadPostman(l.postman); R.linked = l.postman; } catch {} }
          if (!R && l.spec) { try { const s = await get(l.spec, 10000, { Accept: "application/json" }); R = parseOpenApi(JSON.parse(s.raw), url); if (R) R.linked = l.spec; } catch {} }
        }
        if (!R && main.status === "fulfilled") {
          const d = main.value; docs = d.text; pages = d.pages; source = d.via;
          if (d.via === "openapi") { try { R = parseOpenApi(JSON.parse(d.text), url); } catch {} }
        }
        if (!R && docs.length < 1500) {
          if (appName.toLowerCase() === "calendly") { docs = calendlyReference(); source = "reference"; }
          else return send(res, 422, { error: `Couldn't read enough of the docs at that link${main.status === "rejected" ? ` (${main.reason?.message})` : ""}. Pick another docs page or paste the API reference text.`, needPaste: true });
        }
      } else return send(res, 400, { error: "Pick a docs page first." });
    }
    if (R) {
      docsForAuth = JSON.stringify({ title: R.title, base_url: R.base_url, auth: R.auth, sample: R.modules.slice(0, 3).map((m) => m.endpoints.slice(0, 2).map((e) => [e.method, e.path, e.description])) });
      const help = await authHelp(appName, (R.description ? R.description + "\n" : "") + docsForAuth + "\n" + (docs || ""), R.grouped === "path" ? R.modules.flatMap((m) => m.endpoints) : null);
      if (R.grouped === "path" && help.modules && typeof help.modules === "object") {
        const map = new Map();
        for (const e of R.modules.flatMap((m) => m.endpoints)) { const name = String(help.modules[e.id] || e.module).slice(0, 60); e.module = name; if (!map.has(name)) map.set(name, []); map.get(name).push(e); }
        R.modules = [...map.entries()].map(([name, endpoints]) => ({ name, endpoints }));
      }
      const keep = (v) => v && v !== "UNKNOWN";
      R.auth = { ...(help.auth || {}), ...R.auth, token_name: help.auth?.token_name || null, get_key_steps: (help.auth?.get_key_steps || []).filter(keep), key_page_url: /^https:/.test(help.auth?.key_page_url || "") ? help.auth.key_page_url : null, free_tier: help.auth?.free_tier || "UNKNOWN", extra_headers: (help.auth?.extra_headers || []).filter((h) => h && h.name && !/^(authorization|x-api-key|content-type|accept)$/i.test(h.name)) };
      delete R.description;
      R.sandbox_base_url = /^https:\/\//.test(help.sandbox_base_url || "") ? help.sandbox_base_url : null;
      R.complete = true;
    } else {
      // 3) AI reads the docs and lists every endpoint it can see.
      if (appName.toLowerCase() === "calendly" && source !== "reference") docs += "\n\n=== CHECKED CALENDLY REFERENCE ===\n" + calendlyReference();
      const hits = injectionHits(docs);
      if (hits.length) return send(res, 422, { error: "Stopped: the documentation contains text aimed at the AI (possible prompt injection). Paste a clean copy of the reference instead.", injection: hits });
      const prompt = `${RULES.replace("- Read-only: only HTTP GET requests to the app's API. The only allowed POST is an OAuth token refresh to the app's own auth server.\n", "")}

<documentation app="${appName}">
${docs.slice(0, 150_000)}
</documentation>

List EVERY API endpoint you can find in this documentation, with all methods (GET, POST, PUT, PATCH, DELETE), grouped by module the way the docs group them (sidebar sections such as Users, Organizations, Events). Paths exactly as documented, relative to base_url, path parameters in {braces}. Do not invent endpoints. Up to 150 endpoints.
Reply with ONLY a JSON object:
{"base_url": "https://... or UNKNOWN", "sandbox_base_url": "https://... or null", "auth": ${AUTH_SHAPE}, "modules": [{"name": "module name", "endpoints": [{"method": "GET", "path": "/v1/things/{id}", "summary": "short name, like the docs' title", "docs_url": "https://... page for this endpoint, or null"}]}], "complete": true, "note": "if the docs you saw don't show every endpoint, say which parts are missing; else null"}`;
      let u = null; const t0 = Date.now();
      for (let attempt = 0; attempt < 2 && !u; attempt++) {
        if (attempt && Date.now() - t0 > 22000) break;
        try { u = normalise(await llm(prompt + (attempt ? "\nIMPORTANT: reply with one JSON object with exactly the keys shown." : ""), { maxOutputTokens: 16384, budgetMs: attempt ? 18000 : 32000 })); }
        catch (e) { if (attempt || e.status === 429 || e.status === 503) throw e; }
      }
      if (!u) return send(res, 502, { error: "The AI couldn't list the endpoints just now. Try again, or pick another docs page." });
      let i = 0;
      const modules = u.modules.filter((m) => m && Array.isArray(m.endpoints)).map((m) => ({
        name: String(m.name || "General").slice(0, 60),
        endpoints: m.endpoints.filter((e) => e && e.path).slice(0, 80).map((e) => ({
          id: (String(e.summary || e.path).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40) || "ep") + "-" + i++,
          module: String(m.name || "General").slice(0, 60), method: METHODS.includes(String(e.method || "").toUpperCase()) ? String(e.method).toUpperCase() : "GET",
          path: String(e.path).slice(0, 200), summary: String(e.summary || e.path).slice(0, 140), description: "", params: [], headers: [], body: null, response_example: "",
          docs_url: /^https:\/\//.test(e.docs_url || "") ? String(e.docs_url).slice(0, 300) : null, detailed: false,
        })),
      })).filter((m) => m.endpoints.length);
      const a = u.auth && typeof u.auth === "object" ? u.auth : { type: "bearer" };
      a.get_key_steps = Array.isArray(a.get_key_steps) ? a.get_key_steps.slice(0, 5) : [];
      a.extra_headers = Array.isArray(a.extra_headers) ? a.extra_headers.filter((h) => h && h.name).slice(0, 4) : [];
      R = { base_url: String(u.base_url || "UNKNOWN").replace(/\/+$/, ""), sandbox_base_url: /^https:\/\//.test(u.sandbox_base_url || "") ? u.sandbox_base_url : null, auth: a, modules, source: "ai", complete: u.complete !== false, note: u.note || null, total: modules.reduce((n, m) => n + m.endpoints.length, 0) };
    }
    if (!R.total) return send(res, 200, { result: R, empty: true });
    const body = { result: { ...R, note: R.note || note || null }, grants: grantsFor([R.base_url, R.sandbox_base_url].filter((x) => /^https:/.test(x || ""))), source: R.source, pages, model: lastModelUsed };
    if (!docsText) cache.set(key, body);
    return send(res, 200, body);
  } catch (e) {
    return send(res, e.status || 500, { error: e.message || "Something went wrong" });
  }
}
