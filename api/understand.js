// Stage 1-2: read the API docs (fetch the link server-side or use pasted text),
// scan for prompt injection, then ask the model for a structured spec.
import { RULES, calendlyReference, fetchDocs, gemini, injectionHits, rateLimited, readBody, send } from "./_lib/core.js";
import { lastModelUsed } from "./_lib/core.js";

const SHAPE = `{"base_url": "...", "auth": "methods in one line", "auth_warning": "required role, or null", "users_steps": ["METHOD /path → what it gives", "..."], "usage": ["signal — METHOD /path (plan restriction if any)", "..."], "usage_note": "one line, or null", "pagination": "one line", "rate_limits": ["...", "..."], "mapping": [["app field", "CloudEagle field"], ...], "unknowns": ["things the docs don't state"], "missing_users": false}`;

export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Use POST" });
  if (rateLimited(req)) return send(res, 429, { error: "Too many requests from this network. Try again in an hour." });
  try {
    const { app = "", docsUrl = "", docsText = "" } = await readBody(req);
    const appName = String(app).slice(0, 80) || "the app";
    const isCalendly = appName.trim().toLowerCase() === "calendly";

    let docs = "", source = "";
    if (docsText && docsText.trim().length >= 200) {
      docs = String(docsText).slice(0, 200_000); source = "pasted";
    } else if (docsUrl) {
      try { docs = await fetchDocs(docsUrl); source = "fetched"; } catch (e) { docs = ""; source = "fetch_failed:" + e.message; }
      if (docs.length < 1500) {
        if (isCalendly) { docs = calendlyReference(); source = "captured"; }
        else if (source.startsWith("fetch_failed:")) return send(res, 422, { error: `Couldn't read the docs link (${source.slice(13)}). Paste the API reference text instead.` });
        else return send(res, 422, { error: "That docs page loads its content with JavaScript, so the server got almost no text. Paste the API reference text instead." });
      }
    } else if (isCalendly) {
      docs = calendlyReference(); source = "captured";
    } else {
      return send(res, 400, { error: "Add a docs link or paste the documentation text." });
    }

    const hitsFound = injectionHits(docs);
    if (hitsFound.length) return send(res, 422, { error: "Stopped: the documentation contains text aimed at the AI (possible prompt injection).", injection: hitsFound });

    const understanding = await gemini(`${RULES}

<documentation app="${appName}">
${docs.slice(0, 150_000)}
</documentation>

Extract how to retrieve users and usage data for ${appName} so CloudEagle can track licences.
Reply with ONLY a JSON object of exactly this shape (short strings, no markdown):
${SHAPE}
Set missing_users to true only if the documentation has no way to list users.`, { maxOutputTokens: 4096 });

    const u = understanding || {};
    if (!u.base_url || !Array.isArray(u.users_steps) || !Array.isArray(u.mapping)) {
      return send(res, 502, { error: "The AI's answer was missing required fields. Try again." });
    }
    u.usage = Array.isArray(u.usage) ? u.usage : [];
    u.rate_limits = Array.isArray(u.rate_limits) ? u.rate_limits : [];
    u.unknowns = Array.isArray(u.unknowns) ? u.unknowns : [];
    return send(res, 200, { understanding: u, source, docsChars: docs.length, model: lastModelUsed });
  } catch (e) {
    return send(res, e.status || 500, { error: e.message || "Something went wrong" });
  }
}
