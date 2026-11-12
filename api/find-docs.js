// Given an app name, find its official REST API reference page.
// 1) A checked list of popular apps. 2) Otherwise Gemini with Google Search grounding.
// Every candidate URL is opened to make sure it loads before we return it.
import { get, llm, rateLimited, readBody, send } from "./_lib/core.js";
import { KNOWN } from "./_lib/apps.js";

const cache = new Map();

async function ddg(q) {
  try {
    const r = await get("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(q), 6000);
    const out = [];
    const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g; let m;
    while ((m = re.exec(r.raw)) && out.length < 8) {
      let url = m[1].replace(/&amp;/g, "&");
      const u = url.match(/[?&]uddg=([^&]+)/); if (u) url = decodeURIComponent(u[1]);
      if (/^https:\/\//.test(url) && !/duckduckgo\.com/.test(url)) out.push({ url, title: m[2].replace(/<[^>]+>/g, "").trim().slice(0, 120) });
    }
    return out;
  } catch { return []; }
}

// Open a candidate and score how much it looks like an API reference (not a marketing page about the API).
async function inspect(url) {
  try {
    const r = await get(url, 7000);
    const raw = r.raw.slice(0, 600_000);
    const title = ((raw.match(/<title[^>]*>([^<]{1,160})/i) || [])[1] || "").replace(/\s+/g, " ").trim();
    const host = new URL(r.url).hostname, path = new URL(r.url).pathname;
    let score = 10;
    if (/^(docs|developers?|dev|api|apidocs|reference)\./i.test(host)) score += 8;
    if (/reference|api-?docs|\/api\b|\/rest\b|developers?/i.test(path)) score += 4;
    if (/readme\.io|readme\.com|redoc|swagger|stoplight|openapi|mintlify|docusaurus|gitbook/i.test(raw.slice(0, 200_000))) score += 6;
    if (/api reference|reference|endpoints?|rest api/i.test(title)) score += 4;
    const verbs = (raw.match(/\b(GET|POST|PUT|PATCH|DELETE)\b\s*(?:<[^>]+>\s*)*\/?[a-z{:]/g) || []).length;
    score += Math.min(verbs, 20) / 2;
    if (/pricing|book a demo|start (your )?free trial|request a demo/i.test(title)) score -= 6;
    // Links from this page to a dedicated docs site (marketing pages usually link to the real reference).
    const docsLinks = [...new Set((raw.match(/https:\/\/(?:docs|developers?|api|apidocs)\.[a-z0-9.-]+[^"'\s<>)]*/gi) || []).map((u) => u.replace(/[.,;]+$/, "")))].slice(0, 4);
    return { ok: true, url: r.url, title, score, docsLinks };
  } catch (e) {
    // Blocked by bot protection (401/403/429): we couldn't read it, so it's only a last resort.
    if (/returned (401|403|429)/.test(e.message)) return { ok: true, url, title: "", score: 1, blockedBots: true, docsLinks: [] };
    return { ok: false, url, why: e.message, score: -1, docsLinks: [] };
  }
}
const rootOf = (h) => h.replace(/^www\./, "").split(".").slice(-2).join(".");
function probes(domain) {
  if (!domain) return [];
  const d = rootOf(domain);
  return [`https://docs.${d}/reference`, `https://docs.${d}/api-reference`, `https://docs.${d}`, `https://developer.${d}`, `https://developers.${d}`, `https://api.${d}/docs`, `https://${d}/docs/api`];
}

export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Use POST" });
  try {
    const { app = "" } = await readBody(req);
    const name = String(app).trim().slice(0, 80);
    if (name.length < 2) return send(res, 400, { error: "Type the app's name first." });
    const key = name.toLowerCase();

    const known = KNOWN.find((k) => k.name.toLowerCase() === key || (k.aka || []).includes(key));
    if (known) return send(res, 200, { app: known.name, docsUrl: known.docs, domain: known.domain, source: "library", verified: true });
    if (cache.has(key)) return send(res, 200, cache.get(key));

    if (rateLimited(req, 40, 60 * 60 * 1000, "find")) return send(res, 429, { error: "Too many searches from this network. Try again in an hour, or paste the docs link." });

    const ask = (extra) => `Find the official developer documentation for the REST API of the software product "${name}".
${extra}
Return the page that is the API reference (lists endpoints), on the vendor's own domain. Prefer the overview or "introduction" page of the reference. Never return blog posts, third-party sites, Postman, RapidAPI, GitHub wikis or Stack Overflow.
If "${name}" is not a real software product with a public API, set found to false.
Reply with ONLY a JSON object, no markdown:
{"found": true, "app": "official product name", "domain": "vendor's main website domain, e.g. example.com", "candidates": ["best API reference URL", "second-best URL", "third"], "api_base_url": "https://... or UNKNOWN"}`;
    let out;
    try {
      out = await llm(ask("Use Google Search."), { search: true, maxOutputTokens: 1024, temperature: 0, budgetMs: 12000 });
    } catch (e) {
      // Search grounding has its own quota. Fall back to web results from DuckDuckGo plus the model's own knowledge.
      const results = await ddg(`${name} REST API reference documentation`);
      out = await llm(ask(results.length ? `These are web search results; pick from them or use what you know:\n${results.map((r) => `- ${r.title} — ${r.url}`).join("\n")}` : "Use what you know about this product's developer site."), { maxOutputTokens: 1024, temperature: 0, budgetMs: 15000 });
    }

    if (!out || out.found === false || !Array.isArray(out.candidates) || !out.candidates.length) {
      const body = { app: name, docsUrl: "", source: "ai", verified: false, notFound: true };
      cache.set(key, body);
      return send(res, 200, body);
    }
    const ok = (u) => /^https:\/\/[^\s]+$/.test(u) && !/postman\.com|rapidapi|stackoverflow|medium\.com|github\.com\/[^/]+\/[^/]+\/wiki|vertexaisearch/i.test(u);
    const aiCands = [...new Set(out.candidates.map(String).filter(ok))].slice(0, 3);
    let domain = String(out.domain || "").replace(/[^a-z0-9.-]/gi, "").slice(0, 80);
    if (!domain && aiCands[0]) domain = rootOf(new URL(aiCands[0]).hostname);
    const first = [...new Set([...aiCands, ...probes(domain)])];
    let checks = await Promise.all(first.map(inspect));
    // Follow links to a dedicated docs site found on the pages we opened.
    const seen = new Set(checks.map((c) => c.url).concat(first));
    const next = [...new Set(checks.flatMap((c) => c.docsLinks))].filter((u) => ok(u) && !seen.has(u) && (!domain || rootOf(new URL(u).hostname) === rootOf(domain))).slice(0, 3);
    if (next.length) checks = checks.concat(await Promise.all(next.map(inspect)));
    // AI's own picks get a small bonus; then the highest score wins.
    for (const c of checks) if (aiCands.includes(c.url)) c.score += 2;
    const good = checks.filter((c) => c.ok).sort((a, b) => b.score - a.score)[0];
    const body = good
      ? { app: String(out.app || name).slice(0, 80), docsUrl: good.url, domain, source: "ai", verified: !good.blockedBots && good.score >= 18, title: good.title, alternatives: checks.filter((c) => c.ok && c !== good && !c.blockedBots).sort((a, b) => b.score - a.score).slice(0, 3).map((c) => c.url) }
      : { app: name, docsUrl: "", source: "ai", verified: false, notFound: true, tried: first };
    cache.set(key, body);
    return send(res, 200, body);
  } catch (e) {
    return send(res, e.status || 500, { error: e.message || "Couldn't search for the docs. Paste the link instead." });
  }
}
