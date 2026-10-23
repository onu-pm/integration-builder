// TEMPORARY: times candidate NVIDIA models on the real "read the docs" task. Remove after choosing.
import { RULES, calendlyReference, callNvidia, send } from "./_lib/core.js";

const ALLOWED = ["mistralai/codestral-22b-instruct-v0.1", "google/gemma-4-31b-it", "nvidia/nemotron-3.5-lightning-30b-a3b", "z-ai/glm-5.3-flash", "openai/gpt-oss-20b", "minimaxai/minimax-m3.1-flash", "meta/llama-3.1-nemotron-70b-instruct", "nvidia/llama-3.1-nemotron-70b-instruct"];

export default async function handler(req, res) {
  const model = new URL(req.url, "http://x").searchParams.get("model");
  if (!ALLOWED.includes(model)) return send(res, 400, { error: "model not in test list" });
  const t0 = Date.now();
  try {
    const out = await callNvidia(`${RULES}

<documentation app="Calendly">
${calendlyReference()}
</documentation>

Extract how to retrieve users and usage data for Calendly. Reply with ONLY a JSON object: {"base_url": "...", "auth": "...", "users_steps": ["..."], "usage": ["..."], "pagination": "...", "rate_limits": ["..."], "mapping": [["app field","CloudEagle field"]], "unknowns": ["..."]}`, { maxOutputTokens: 3000, temperature: 0.2 }, model);
    send(res, 200, { model, ms: Date.now() - t0, ok: Boolean(out?.base_url && Array.isArray(out?.users_steps)), sample: JSON.stringify(out).slice(0, 200) });
  } catch (e) {
    send(res, 200, { model, ms: Date.now() - t0, ok: false, error: e.message.slice(0, 300) });
  }
}
