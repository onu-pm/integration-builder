// Given an app name, find its official REST API reference page.
// Postman docs (documenter.getpostman.com) are preferred when the vendor links to them or search finds them.
// 1) A checked list of popular apps. 2) Otherwise Gemini with Google Search grounding, then checks of the usual docs places.
// We don't scrape search engines' result pages.
// Every candidate URL is opened to make sure it loads before we return it.
import { get, llm, rateLimited, readBody, send } from "./_lib/core.js";
import { KNOWN } from "./_lib/apps.js";

const cache = new Map();

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
    const postmanLinks = [...new Set((raw.match(/https:\/\/documenter\.getpostman\.com\/view\/[A-Za-z0-9_\-\/%.]+/gi) || []).map((u) => u.replace(/[.,;]+$/, "")))].slice(0, 3);
    return { ok: true, url: r.url, title, score, docsLinks, postmanLinks };
  } catch (e) {
    // Blocked by bot protection (401/403/429): we couldn't read it, so it's only a last resort.
    if (/returned (401|403|429)/.test(e.message)) return { ok: true, url, title: "", score: 1, blockedBots: true, docsLinks: [], postmanLinks: [] };
    return { ok: false, url, why: e.message, score: -1, docsLinks: [], postmanLinks: [] };
  }
}
const postmanFrom = (checks) => checks.flatMap((c) => c.postmanLinks || [])[0] || null;
const rootOf = (h) => h.replace(/^www\./, "").split(".").slice(-2).join(".");
function probes(domain) {
  if (!domain) return [];
  const d = rootOf(domain);
  return [`https://${d}`, `https://${d}/api`, `https://${d}/developers`, `https://docs.${d}/reference`, `https://docs.${d}/api-reference`, `https://docs.${d}`, `https://developer.${d}`, `https://developers.${d}`, `https://api.${d}/docs`, `https://${d}/docs/api`];
}

export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Use POST" });
  try {
    const { app = "" } = await readBody(req);
    const name = String(app).trim().slice(0, 80);
    if (name.length < 2) return send(res, 400, { error: "Type the app's name first." });
    const key = name.toLowerCase();

    const known = KNOWN.find((k) => k.name.toLowerCase() === key || (k.aka || []).includes(key));
    if (known) {
      const pm = postmanFrom(await Promise.all([known.docs, `https://${known.domain}`].map(inspect)));
      if (pm) return send(res, 200, { app: known.name, docsUrl: pm, domain: known.domain, source: "postman", linkedBy: "vendor", verified: true, alternatives: [known.docs] });
      return send(res, 200, { app: known.name, docsUrl: known.docs, domain: known.domain, source: "library", verified: true });
    }
    if (cache.has(key)) return send(res, 200, cache.get(key));

    if (rateLimited(req, 40, 60 * 60 * 1000, "find")) return send(res, 429, { error: "Too many searches from this network. Try again in an hour, or paste the docs link." });

    const ask = (extra) => `Find the official developer documentation for the REST API of the software product "${name}".
${extra}
If the vendor publishes its API documentation on Postman (a documenter.getpostman.com/view/... link), put that link FIRST. Otherwise return the page that is the API reference (lists endpoints), on the vendor's own domain; prefer the overview or "introduction" page. Never return blog posts, RapidAPI, GitHub wikis or Stack Overflow.
If "${name}" is not a real software product with a public API, set found to false.
Reply with ONLY a JSON object, no markdown:
{"found": true, "app": "official product name", "domain": "vendor's main website domain, e.g. example.com", "candidates": ["best API reference URL", "second-best URL", "third"], "api_base_url": "https://... or UNKNOWN"}`;
    let out;
    try {
      out = await llm(ask(`Use Google Search. First search: site:documenter.getpostman.com ${name}. Then search for the official API reference.`), { search: true, maxOutputTokens: 1024, temperature: 0, budgetMs: 12000 });
    } catch (e) {
      // Search grounding has its own quota. Fall back to the model's own knowledge, then check the usual places ourselves.
      out = await llm(ask("Use what you know about this product's developer site."), { maxOutputTokens: 1024, temperature: 0, budgetMs: 15000 }).catch(() => ({}));
    }

    // Even when the model doesn't know the product, still check the usual docs places on likely domains.
    out = out && typeof out === "object" ? out : {};
    if (!Array.isArray(out.candidates)) out.candidates = [];
    const isPm = (u) => /^https:\/\/documenter\.getpostman\.com\/view\//i.test(u);
    const ok = (u) => /^https:\/\/[^\s]+$/.test(u) && (isPm(u) || !/postman\.com|rapidapi|stackoverflow|medium\.com|github\.com\/[^/]+\/[^/]+\/wiki|vertexaisearch/i.test(u));
    const aiCands = [...new Set(out.candidates.map(String).filter(ok))].slice(0, 3);
    let domain = String(out.domain || "").replace(/[^a-z0-9.-]/gi, "").slice(0, 80);
    if (!domain && aiCands[0]) domain = rootOf(new URL(aiCands[0]).hostname);
    const slug = name.toLowerCase().replace(/[^a-z0-9]/g, "");
    const guesses = domain ? [domain] : [`${slug}.com`, `${slug}.io`, `${slug}.ai`];
    const first = [...new Set([...aiCands, ...guesses.flatMap((d) => probes(d).slice(0, domain ? 10 : 5))])];
    let checks = await Promise.all(first.map(inspect));
    // Follow links to a dedicated docs site found on the pages we opened.
    const seen = new Set(checks.map((c) => c.url).concat(first));
    const next = [...new Set(checks.flatMap((c) => c.docsLinks))].filter((u) => ok(u) && !seen.has(u) && (!domain || rootOf(new URL(u).hostname) === rootOf(domain))).slice(0, 3);
    if (next.length) checks = checks.concat(await Promise.all(next.map(inspect)));
    // Postman docs come first: linked from the vendor's own pages (trusted), or found by search with the app's name in it.
    const vendorPm = postmanFrom(checks.filter((c) => c.ok && !isPm(c.url) && (!domain || rootOf(new URL(c.url).hostname) === rootOf(domain))));
    const slugRe = new RegExp(slug.split("").join("[^a-z0-9]?"), "i");
    const searchPm = checks.find((c) => c.ok && !c.blockedBots && isPm(c.url) && (slugRe.test(c.url) || slugRe.test(c.title)));
    const pmUrl = vendorPm || searchPm?.url;
    if (pmUrl) {
      const official = checks.filter((c) => c.ok && !c.blockedBots && !isPm(c.url) && c.score >= 14).sort((a, b) => b.score - a.score).map((c) => c.url);
      const body = { app: String(out.app || name).slice(0, 80), docsUrl: pmUrl, domain: domain || slug + ".com", source: "postman", linkedBy: vendorPm ? "vendor" : "search", verified: !!vendorPm, alternatives: [...new Set(official)].slice(0, 3) };
      cache.set(key, body);
      return send(res, 200, body);
    }
    // AI's own picks get a small bonus; then the highest score wins.
    for (const c of checks) if (aiCands.includes(c.url)) c.score += 2;
    const good = checks.filter((c) => c.ok && (domain || aiCands.includes(c.url) || c.score >= 18)).sort((a, b) => b.score - a.score)[0];
    const body = good
      ? { app: String(out.app || name).slice(0, 80), docsUrl: good.url, domain: domain || rootOf(new URL(good.url).hostname), source: "ai", verified: !good.blockedBots && good.score >= 18, title: good.title, alternatives: [...new Set(checks.filter((c) => c.ok && !c.blockedBots && c.score >= 14).sort((a, b) => b.score - a.score).map((c) => c.url.replace(/\/$/, "")))].filter((u) => u !== good.url.replace(/\/$/, "")).slice(0, 3) }
      : { app: name, docsUrl: "", source: "ai", verified: false, notFound: true, tried: first };
    cache.set(key, body);
    return send(res, 200, body);
  } catch (e) {
    return send(res, e.status || 500, { error: e.message || "Couldn't search for the docs. Paste the link instead." });
  }
}
