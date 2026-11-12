// Given an app name, find its official REST API reference page.
// 1) A checked list of popular apps. 2) Otherwise Gemini with Google Search grounding.
// Every candidate URL is opened to make sure it loads before we return it.
import { get, llm, rateLimited, readBody, send } from "./_lib/core.js";
import { KNOWN } from "./_lib/apps.js";

const cache = new Map();

async function loads(url) {
  try {
    const r = await get(url, 7000);
    const title = (r.raw.match(/<title[^>]*>([^<]{1,160})/i) || [])[1] || "";
    return { ok: true, url: r.url, title: title.replace(/\s+/g, " ").trim() };
  } catch (e) {
    // Many docs sites block bots (403/429) but load fine in a browser: keep them, flagged.
    if (/returned (401|403|429)/.test(e.message)) return { ok: true, url, title: "", blockedBots: true };
    return { ok: false, url, why: e.message };
  }
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

    const out = await llm(`Find the official developer documentation for the REST API of the software product "${name}".
Use Google Search. Return the page that is the API reference (lists endpoints), on the vendor's own domain. Prefer the overview or "introduction" page of the reference. Never return blog posts, third-party sites, Postman, RapidAPI, GitHub wikis or Stack Overflow.
If "${name}" is not a real software product with a public API, set found to false.
Reply with ONLY a JSON object, no markdown:
{"found": true, "app": "official product name", "domain": "vendor's main website domain, e.g. example.com", "candidates": ["best API reference URL", "second-best URL", "third"], "api_base_url": "https://... or UNKNOWN"}`, { search: true, maxOutputTokens: 1024, temperature: 0, budgetMs: 25000 });

    if (!out || out.found === false || !Array.isArray(out.candidates) || !out.candidates.length) {
      const body = { app: name, docsUrl: "", source: "ai", verified: false, notFound: true };
      cache.set(key, body);
      return send(res, 200, body);
    }
    const cands = [...new Set(out.candidates.map(String).filter((u) => /^https:\/\/[^\s]+$/.test(u)))]
      .filter((u) => !/postman\.com|rapidapi|stackoverflow|medium\.com|github\.com\/[^/]+\/[^/]+\/wiki|vertexaisearch/i.test(u))
      .slice(0, 3);
    const checks = await Promise.all(cands.map(loads));
    const good = checks.find((c) => c.ok && !c.blockedBots) || checks.find((c) => c.ok);
    const body = good
      ? { app: String(out.app || name).slice(0, 80), docsUrl: good.url, domain: String(out.domain || "").replace(/[^a-z0-9.-]/gi, "").slice(0, 80), source: "ai", verified: !good.blockedBots, title: good.title, alternatives: checks.filter((c) => c.ok && c !== good).map((c) => c.url) }
      : { app: name, docsUrl: "", source: "ai", verified: false, notFound: true, tried: cands };
    cache.set(key, body);
    return send(res, 200, body);
  } catch (e) {
    return send(res, e.status || 500, { error: e.message || "Couldn't search for the docs. Paste the link instead." });
  }
}
