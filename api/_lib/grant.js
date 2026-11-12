// Write requests (POST/PUT/PATCH/DELETE) through the tester are only allowed to API hosts that Fetch itself
// read from the app's docs. The server signs those hosts; the relay checks the signature.
import { createHmac, createHash, timingSafeEqual } from "node:crypto";

const secret = () => process.env.FETCH_SECRET || createHash("sha256").update("fetch-grant:" + (process.env.GEMINI_API_KEY || "dev")).digest("hex");
// Shared hosting platforms: grant the exact host, never the whole platform.
const SHARED = /(^|\.)(amazonaws\.com|azurewebsites\.net|azure-api\.net|herokuapp\.com|vercel\.app|netlify\.app|cloudfunctions\.net|appspot\.com|onrender\.com|github\.io|workers\.dev|pages\.dev|firebaseapp\.com|web\.app|ngrok\.io|ngrok-free\.app|run\.app|fly\.dev|railway\.app|repl\.co|glitch\.me|blogspot\.com|myshopify\.com)$/;
export const rootOf = (h) => {
  const host = String(h || "").toLowerCase().replace(/^www\./, "");
  if (SHARED.test(host)) return host;
  const p = host.split(".");
  // Two-part country suffixes like co.uk, co.in, com.au.
  const n = p.length >= 3 && /^(co|com|org|net|gov|ac|edu)$/.test(p[p.length - 2]) && p[p.length - 1].length === 2 ? 3 : 2;
  return p.slice(-n).join(".");
};
export const sign = (root) => createHmac("sha256", secret()).update("host:" + root).digest("base64url").slice(0, 32);
export function grantsFor(urls) {
  const out = {};
  for (const u of urls) { try { const h = new URL(u).hostname; if (h && h.includes(".")) { const r = rootOf(h); out[r] = sign(r); } } catch {} }
  return out;
}
export function checkGrant(url, grants) {
  try {
    const r = rootOf(new URL(url).hostname); const g = String((grants || {})[r] || ""); const want = sign(r);
    return g.length === want.length && timingSafeEqual(Buffer.from(g), Buffer.from(want));
  } catch { return false; }
}
