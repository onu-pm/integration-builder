// TEMPORARY: times candidate Gemini models on the real "read the docs" task. Remove after choosing.
import { RULES, calendlyReference, callGemini, send } from "./_lib/core.js";

const ALLOWED = ["gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite"];

export default async function handler(req, res) {
  const model = new URL(req.url, "http://x").searchParams.get("model");
  if (!ALLOWED.includes(model)) return send(res, 400, { error: "model not in test list" });
  const t0 = Date.now();
  try {
    const out = await callGemini(`${RULES}

<documentation app="Calendly">
${calendlyReference()}
</documentation>

Extract how to retrieve users and usage data for Calendly. Reply with ONLY a JSON object: {"base_url": "...", "auth": "...", "users_steps": ["..."], "usage": ["..."], "pagination": "...", "rate_limits": ["..."], "mapping": [["app field","CloudEagle field"]], "unknowns": ["..."]}`, { maxOutputTokens: 3000, temperature: 0.2 }, model);
    send(res, 200, { model, ms: Date.now() - t0, ok: Boolean(out?.base_url && Array.isArray(out?.users_steps)), sample: JSON.stringify(out).slice(0, 160) });
  } catch (e) {
    send(res, 200, { model, ms: Date.now() - t0, ok: false, error: e.message.slice(0, 300) });
  }
}
