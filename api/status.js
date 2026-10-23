import { hasKey, MODEL, PROVIDER, send } from "./_lib/core.js";

export default function handler(req, res) {
  send(res, 200, { ai: hasKey(), provider: PROVIDER, model: hasKey() ? MODEL : null });
}
