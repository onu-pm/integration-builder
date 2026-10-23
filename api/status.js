import { hasKey, MODEL, send } from "./_lib/core.js";

export default function handler(req, res) {
  send(res, 200, { ai: hasKey(), provider: "Gemini", model: hasKey() ? MODEL : null });
}
