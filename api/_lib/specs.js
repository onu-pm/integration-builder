// Read machine-readable API definitions without AI: Postman published docs and OpenAPI/Swagger JSON.
// Output shape (shared with the AI path): { base_url, auth, modules: [{ name, endpoints: [Endpoint] }], source }
// Endpoint: { id, module, method, path, summary, description, params[], headers[], body, response_example, docs_url, detailed }
import { get } from "./core.js";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const strip = (h, n = 700) => String(h || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim().slice(0, n);
const titleCase = (s) => String(s || "").replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();
const slugId = (s, i) => (String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "ep") + "-" + i;

export const postmanIds = (url) => {
  const m = String(url || "").match(/^https:\/\/documenter\.getpostman\.com\/view\/(\d+)\/([A-Za-z0-9]+)/);
  return m ? { owner: m[1], published: m[2] } : null;
};

function groupModules(endpoints) {
  const map = new Map();
  for (const e of endpoints) { const k = e.module || "General"; if (!map.has(k)) map.set(k, []); map.get(k).push(e); }
  return [...map.entries()].map(([name, eps]) => ({ name, endpoints: eps }));
}

// When a collection has no folders, group by the first path segment that differs between endpoints.
function moduleFromPath(paths) {
  const segs = paths.map((p) => p.split("?")[0].split("/").filter((s) => s && !s.startsWith(":") && !s.startsWith("{")));
  let common = 0;
  while (segs.every((s) => s[common] && s[common] === segs[0][common]) && common < 6) common++;
  return (i) => titleCase(segs[i][common] || segs[i][common - 1] || "General");
}

function authFromPostman(a, vars) {
  if (!a || !a.type) return null;
  const pick = (arr, k) => { const list = Array.isArray(arr) ? arr : arr?.basicConfig || []; return (list.find((x) => x.key === k) || {}).value; };
  const body = a[a.type];
  if (a.type === "apikey") {
    const where = pick(body, "in") || "header";
    return { type: where === "query" ? "api_key_query" : "api_key_header", header: pick(body, "key") || "X-API-Key", query_param: pick(body, "key") || "api_key", prefix: "" };
  }
  if (a.type === "bearer") return { type: "bearer", header: "Authorization", prefix: "Bearer " };
  if (a.type === "basic") return { type: "basic" };
  if (a.type === "oauth2") return { type: "oauth2", header: "Authorization", prefix: "Bearer " };
  if (a.type === "noauth") return { type: "none" };
  return null;
}

export async function loadPostman(viewUrl) {
  const ids = postmanIds(viewUrl);
  if (!ids) return null;
  const r = await get(`https://documenter.gw.postman.com/api/collections/${ids.owner}/${ids.published}?segregateAuth=true&versionTag=latest`, 15000, { Accept: "application/json" });
  const col = JSON.parse(r.raw);
  const vars = Object.fromEntries((col.variable || []).map((v) => [v.key, v.value]));
  const sub = (s) => String(s || "").replace(/\{\{([^}]+)\}\}/g, (m, k) => (vars[k] && /^https?:/.test(vars[k]) ? vars[k] : m));
  const flat = [];
  (function walk(items, folder) {
    for (const it of items || []) {
      if (Array.isArray(it.item)) walk(it.item, folder ? `${folder} / ${it.name}` : it.name);
      else if (it.request) flat.push({ folder, it });
    }
  })(col.item, "");
  const raws = flat.map(({ it }) => sub(typeof it.request.url === "string" ? it.request.url : it.request.url?.raw || ""));
  // Base URL: the longest common origin + path prefix of absolute URLs.
  const abs = raws.filter((u) => /^https?:\/\//.test(u)).map((u) => u.split("?")[0]);
  let base = "";
  if (abs.length) {
    const o = new URL(abs[0]).origin;
    if (abs.every((u) => u.startsWith(o))) {
      const parts = abs.map((u) => new URL(u).pathname.split("/"));
      let i = 0; while (parts.every((p) => p[i] !== undefined && p[i] === parts[0][i] && !/^[:{]/.test(p[i])) && i < 4) i++;
      base = o + parts[0].slice(0, Math.max(1, Math.min(i, parts[0].length - 1))).join("/");
    }
  }
  base = base.replace(/\/+$/, "");
  const modOf = moduleFromPath(raws.map((u) => (base && u.startsWith(base) ? u.slice(base.length) : u.replace(/^https?:\/\/[^/]+/, ""))));
  let auth = authFromPostman(col.auth, vars);
  const endpoints = flat.map(({ folder, it }, i) => {
    const req = it.request, method = String(req.method || "GET").toUpperCase();
    const raw = raws[i];
    const [pathPart, qs] = (base && raw.startsWith(base) ? raw.slice(base.length) : raw.replace(/^https?:\/\/[^/]+/, "")).split("?");
    const path = (pathPart || "/").replace(/:([A-Za-z0-9_]+)/g, "{$1}");
    const params = [];
    for (const m of path.matchAll(/\{([^}]+)\}/g)) params.push({ name: m[1], in: "path", required: true, example: "", about: "" });
    for (const pair of (qs || "").split("&").filter(Boolean)) { const [k, v = ""] = pair.split("="); params.push({ name: decodeURIComponent(k), in: "query", required: false, example: decodeURIComponent(v).replace(/\{\{[^}]+\}\}/g, ""), about: "" }); }
    const headers = (req.header || []).filter((h) => h && h.key && !h.disabled).map((h) => ({ name: h.key, value: String(h.value || "").replace(/\{\{[^}]+\}\}/g, "") }));
    const body = req.body?.mode === "raw" && req.body.raw ? { type: req.body.options?.raw?.language === "json" || /^\s*[{[]/.test(req.body.raw) ? "json" : "text", example: String(req.body.raw).slice(0, 8000) }
      : req.body?.mode === "urlencoded" ? { type: "form", example: (req.body.urlencoded || []).map((p) => `${p.key}=${p.value || ""}`).join("&") } : null;
    const ex = (it.response || []).find((x) => x.code >= 200 && x.code < 300) || (it.response || [])[0];
    if (!auth && req.auth) auth = authFromPostman(req.auth, vars);
    return {
      id: slugId(it.name, i), module: folder || modOf(i), method: METHODS.includes(method) ? method : "GET", path, summary: String(it.name || path).slice(0, 140),
      description: strip(req.description), params, headers, body,
      response_example: ex?.body ? String(ex.body).slice(0, 6000) : "", response_status: ex?.code || null,
      docs_url: viewUrl.split("#")[0], detailed: true,
    };
  });
  return { base_url: base || "UNKNOWN", auth: auth || { type: "bearer", header: "Authorization", prefix: "Bearer " }, modules: groupModules(endpoints), source: "postman", title: col.info?.name || "", total: endpoints.length };
}

// OpenAPI 3 / Swagger 2 in JSON.
export function parseOpenApi(spec, docsUrl) {
  if (!spec || typeof spec !== "object" || !spec.paths) return null;
  const base = spec.servers?.[0]?.url || (spec.host ? `${(spec.schemes || ["https"])[0]}://${spec.host}${spec.basePath || ""}` : "UNKNOWN");
  const ref = (o) => { let x = o; for (let n = 0; x && x.$ref && n < 5; n++) { const p = x.$ref.replace(/^#\//, "").split("/"); x = p.reduce((a, k) => a?.[k], spec); } return x || {}; };
  const sample = (schema, depth = 0) => {
    const s = ref(schema); if (depth > 4) return null;
    if (s.example !== undefined) return s.example;
    if (s.type === "object" || s.properties) { const o = {}; for (const [k, v] of Object.entries(s.properties || {}).slice(0, 15)) o[k] = sample(v, depth + 1); return o; }
    if (s.type === "array") return [sample(s.items || {}, depth + 1)];
    return s.enum ? s.enum[0] : s.type === "integer" || s.type === "number" ? 0 : s.type === "boolean" ? false : s.format === "date-time" ? "2026-01-01T00:00:00Z" : "string";
  };
  const endpoints = []; let i = 0;
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const [m, op] of Object.entries(item || {})) {
      const method = m.toUpperCase(); if (!METHODS.includes(method) || !op || typeof op !== "object") continue;
      const params = [...(item.parameters || []), ...(op.parameters || [])].map(ref).filter((p) => p.name && p.in !== "body").map((p) => ({ name: p.name, in: p.in, required: !!p.required, example: p.example ?? p.schema?.example ?? "", about: strip(p.description, 160) }));
      const content = ref(op.requestBody || {}).content || {};
      const bodySchema = content["application/json"]?.schema || (op.parameters || []).map(ref).find((p) => p.in === "body")?.schema;
      const resp = Object.entries(op.responses || {}).find(([c]) => /^2/.test(c));
      const respSchema = resp && (ref(resp[1]).content?.["application/json"]?.schema || ref(resp[1]).schema);
      endpoints.push({
        id: slugId(op.operationId || `${method} ${path}`, i++), module: titleCase((op.tags || [])[0] || path.split("/").filter((s) => s && !s.startsWith("{"))[0] || "General"),
        method, path, summary: String(op.summary || op.operationId || path).slice(0, 140), description: strip(op.description),
        params, headers: [], body: bodySchema ? { type: "json", example: JSON.stringify(sample(bodySchema), null, 2).slice(0, 8000) } : null,
        response_example: respSchema ? JSON.stringify(sample(respSchema), null, 2).slice(0, 6000) : "", docs_url: docsUrl || null, detailed: true,
      });
    }
  }
  const sch = spec.components?.securitySchemes || spec.securityDefinitions || {};
  const first = Object.values(sch)[0];
  const auth = !first ? { type: "bearer", header: "Authorization", prefix: "Bearer " }
    : first.type === "apiKey" ? { type: first.in === "query" ? "api_key_query" : "api_key_header", header: first.name, query_param: first.name, prefix: "" }
    : first.type === "http" && first.scheme === "basic" || first.type === "basic" ? { type: "basic" }
    : first.type === "oauth2" || first.type === "openIdConnect" ? { type: "oauth2", header: "Authorization", prefix: "Bearer " }
    : { type: "bearer", header: "Authorization", prefix: "Bearer " };
  return { base_url: String(base).replace(/\/+$/, ""), auth, modules: groupModules(endpoints), source: "openapi", title: spec.info?.title || "", total: endpoints.length };
}
