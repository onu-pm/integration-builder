// Live API tester: sends ONE read-only GET request on the developer's behalf.
// Browsers can't call most APIs directly (CORS), so the request goes through here.
// Nothing about the request is stored or logged: not the URL, not the headers, not the key.
import { rateLimited, readBody, send } from "./_lib/core.js";
import { safeFetch } from "./_lib/safefetch.js";

const DROP = /^(host|cookie|content-length|connection|transfer-encoding|upgrade|proxy-.*|te|trailer|keep-alive|x-forwarded-.*|x-real-ip|forwarded|accept-encoding)$/i;
const SHOW = /^(content-type|content-length|date|link|location|retry-after|www-authenticate|x-ratelimit-.*|ratelimit.*|x-rate-limit-.*|x-request-id|request-id|x-github-.*|x-oauth-scopes|x-accepted-oauth-scopes|x-total-count|x-next-page|x-per-page|x-page|cache-control|etag|vary|server)$/i;

export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Use POST" });
  if (rateLimited(req, 120, 60 * 60 * 1000, "proxy")) return send(res, 429, { error: "Too many test requests from this network. Try again in an hour." });
  try {
    const { method = "GET", url = "", headers = {} } = await readBody(req);
    if (String(method).toUpperCase() !== "GET") return send(res, 400, { error: "The tester only sends GET requests (read-only)." });
    const h = {};
    let n = 0;
    for (const [k, v] of Object.entries(headers && typeof headers === "object" ? headers : {})) {
      const key = String(k).trim(); const val = String(v ?? "");
      if (!key || DROP.test(key) || !/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/.test(key) || /[\r\n]/.test(val) || val.length > 4096) continue;
      if (++n > 20) break;
      h[key] = val;
    }
    if (!Object.keys(h).some((k) => /^user-agent$/i.test(k))) h["User-Agent"] = "Fetch-API-Tester/1.0";
    if (!Object.keys(h).some((k) => /^accept$/i.test(k))) h.Accept = "application/json, */*;q=0.8";

    const started = Date.now();
    const r = await safeFetch(String(url).trim(), { headers: h, timeoutMs: 15000, maxBytes: 1_000_000, maxRedirects: 3, httpsOnly: true });
    const ms = Date.now() - started;
    const shown = {};
    for (const [k, v] of Object.entries(r.headers)) if (SHOW.test(k)) shown[k] = Array.isArray(v) ? v.join(", ") : String(v);
    const type = String(r.headers["content-type"] || "");
    const binary = /image|audio|video|octet-stream|pdf|zip/i.test(type);
    return send(res, 200, {
      status: r.status, statusText: r.statusText, ms, size: r.body.length, truncated: r.truncated,
      finalUrl: r.url !== String(url).trim() ? r.url : undefined,
      headers: shown, contentType: type,
      body: binary ? `[${type || "binary"} response, ${r.body.length} bytes not shown]` : r.body.toString("utf8"),
    });
  } catch (e) {
    return send(res, 200, { error: e.message || "The request failed.", code: e.code || "ERR" });
  }
}
