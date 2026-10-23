// Stage 1-2: read the API docs (fetch the link server-side or use pasted text),
// scan for prompt injection, then ask the model for a structured spec.
import { RULES, calendlyReference, fetchDocs, gemini, injectionHits, rateLimited, readBody, send } from "./_lib/core.js";
import { lastModelUsed } from "./_lib/core.js";

const SHAPE = `{"base_url": "...", "auth": "methods in one line", "auth_warning": "required role, or null", "users_steps": ["METHOD /path → what it gives", "..."], "usage": ["signal — METHOD /path (plan restriction if any)", "..."], "usage_note": "one line, or null", "pagination": "one line", "rate_limits": ["...", "..."], "mapping": [["app field", "CloudEagle field"], ...], "field_map": [{"field": "<key from the requested list>", "source": "where it comes from, e.g. METHOD /path → json.path", "status": "yes | plan | no", "note": "plan restriction or why it's missing, or null"}], "scopes": [{"name": "exact permission/scope name from the docs, or UNKNOWN", "why": "which field needs it"}], "more_apis": [{"id": "short-id", "api": "GET /path", "label": "short name", "gives": "what it returns", "why": "how it helps track licences or usage", "scope": "exact permission name, or UNKNOWN", "block": false}], "unknowns": ["things the docs don't state"], "missing_users": false}`;

export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Use POST" });
  if (rateLimited(req)) return send(res, 429, { error: "Too many requests from this network. Try again in an hour." });
  try {
    const { app = "", docsUrl = "", docsText = "", fields = [] } = await readBody(req);
    const wanted = (Array.isArray(fields) ? fields : []).slice(0, 30).map((f) => ({ key: String(f.key || "").slice(0, 40), label: String(f.label || "").slice(0, 60) })).filter((f) => f.key);
    const appName = String(app).slice(0, 80) || "the app";
    const isCalendly = appName.trim().toLowerCase() === "calendly";

    let docs = "", source = "", pages = 0;
    if (docsText && docsText.trim().length >= 200) {
      docs = String(docsText).slice(0, 200_000); source = "pasted";
    } else if (docsUrl) {
      try { const d = await fetchDocs(docsUrl); docs = d.text; pages = d.pages; source = d.via === "rendered" ? "rendered" : d.via === "openapi" ? "openapi" : "fetched"; } catch (e) { docs = ""; source = "fetch_failed:" + e.message; }
      if (docs.length < 1500) {
        if (isCalendly) { docs = calendlyReference(); source = "captured"; }
        else if (source.startsWith("fetch_failed:")) return send(res, 422, { error: `Couldn't read the docs link (${source.slice(13)}). Paste the API reference text instead.` });
        else return send(res, 422, { error: "We opened the docs but found almost no text (it may need a login). Paste the API reference text instead." });
      }
    } else if (isCalendly) {
      docs = calendlyReference(); source = "captured";
    } else {
      return send(res, 400, { error: "Add a docs link or paste the documentation text." });
    }

    // For Calendly, also add the checked reference (scopes, extra endpoints) so the demo is always complete.
    if (isCalendly && source !== "captured") docs += "\n\n=== CHECKED CALENDLY REFERENCE ===\n" + calendlyReference();
    const hitsFound = injectionHits(docs);
    if (hitsFound.length) return send(res, 422, { error: "Stopped: the documentation contains text aimed at the AI (possible prompt injection).", injection: hitsFound });

    const understanding = await gemini(`${RULES}

<documentation app="${appName}">
${docs.slice(0, 150_000)}
</documentation>

Extract how to retrieve users and usage data for ${appName} so CloudEagle can track licences.
Reply with ONLY a JSON object of exactly this shape (short strings, no markdown):
${SHAPE}
The company asked for these fields (key: label): ${JSON.stringify(wanted)}
In field_map, give one entry per requested field, in the same order. status "yes" = the API returns it, "plan" = only on some plans, "no" = the API doesn't offer it (never invent an endpoint).
In scopes, list only the read-only permissions needed for the requested fields that are available. Use the exact names from the docs; if the docs don't name scopes, use "UNKNOWN".
In more_apis, list up to 5 OTHER read-only endpoints in the docs (not already used above) that would help track licences, seats or usage. Set block to true for any endpoint that exposes personal data of people outside the company, and say why.
Set missing_users to true only if the documentation has no way to list users.`, { maxOutputTokens: 4096 });

    const u = understanding || {};
    if (!u.base_url || !Array.isArray(u.users_steps) || !Array.isArray(u.mapping)) {
      return send(res, 502, { error: "The AI's answer was missing required fields. Try again." });
    }
    u.usage = Array.isArray(u.usage) ? u.usage : [];
    u.rate_limits = Array.isArray(u.rate_limits) ? u.rate_limits : [];
    u.unknowns = Array.isArray(u.unknowns) ? u.unknowns : [];
    u.field_map = Array.isArray(u.field_map) ? u.field_map.filter((f) => f && f.field) : [];
    u.more_apis = Array.isArray(u.more_apis) ? u.more_apis.filter((x) => x && x.api).slice(0, 6) : [];
    u.scopes = Array.isArray(u.scopes) ? u.scopes.filter((x) => x && x.name) : [];
    return send(res, 200, { understanding: u, source, pages, docsChars: docs.length, model: lastModelUsed });
  } catch (e) {
    return send(res, e.status || 500, { error: e.message || "Something went wrong" });
  }
}
