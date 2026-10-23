// Lists the chat models this NVIDIA key can use, so a fast one can be chosen.
import { PROVIDER, send } from "./_lib/core.js";

export default async function handler(req, res) {
  if (PROVIDER !== "NVIDIA") return send(res, 200, { provider: PROVIDER, models: [] });
  try {
    const r = await fetch("https://integrate.api.nvidia.com/v1/models", { headers: { Authorization: `Bearer ${process.env.NVIDIA_API_KEY}` } });
    const data = await r.json();
    const ids = (data.data || []).map((m) => m.id).sort();
    send(res, 200, { provider: PROVIDER, count: ids.length, models: ids });
  } catch (e) {
    send(res, 502, { error: e.message });
  }
}
