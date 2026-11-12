// Outbound GET that can't be pointed at private networks (SSRF-safe).
// The IP check runs inside the socket's DNS lookup, so a hostname can't
// resolve to a public IP for the check and a private one for the connection.
import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import net from "node:net";
import zlib from "node:zlib";

const blocked = new net.BlockList();
[
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
].forEach(([a, p]) => blocked.addSubnet(a, p, "ipv4"));
[["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["64:ff9b::", 96], ["2001:db8::", 32]]
  .forEach(([a, p]) => blocked.addSubnet(a, p, "ipv6"));

export function isPrivateIp(ip) {
  const fam = net.isIPv4(ip) ? "ipv4" : net.isIPv6(ip) ? "ipv6" : null;
  if (!fam) return true;
  if (fam === "ipv6") {
    const m = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (m) return blocked.check(m[1], "ipv4");
  }
  return blocked.check(ip, fam);
}

function safeLookup(hostname, opts, cb) {
  dns.lookup(hostname, { ...opts, all: true }, (err, addrs) => {
    if (err) return cb(err);
    const list = Array.isArray(addrs) ? addrs : [{ address: addrs, family: opts.family || 4 }];
    const ok = list.filter((a) => !isPrivateIp(a.address));
    if (!ok.length) return cb(Object.assign(new Error("That address points to a private network, which isn't allowed."), { code: "EPRIVATE" }));
    if (opts.all) return cb(null, ok);
    cb(null, ok[0].address, ok[0].family);
  });
}

export class SafeFetchError extends Error {
  constructor(msg, code) { super(msg); this.code = code; }
}

function checkUrl(raw, httpsOnly) {
  let u;
  try { u = new URL(raw); } catch { throw new SafeFetchError("That isn't a valid URL.", "BAD_URL"); }
  if (u.protocol !== "https:" && (httpsOnly || u.protocol !== "http:")) throw new SafeFetchError(httpsOnly ? "Only https:// URLs can be tested." : "Only http(s) links are supported.", "BAD_URL");
  if (u.username || u.password) throw new SafeFetchError("Put credentials in the Auth tab, not in the URL.", "BAD_URL");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) && isPrivateIp(host)) throw new SafeFetchError("Private and local addresses can't be reached.", "PRIVATE");
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal|metadata\.google\.internal)$/i.test(host)) throw new SafeFetchError("Private and local addresses can't be reached.", "PRIVATE");
  if (u.port && !["80", "443", "8080", "8443"].includes(u.port)) throw new SafeFetchError("Only standard web ports are allowed.", "BAD_URL");
  return u;
}

function once(u, headers, timeoutMs, maxBytes, method = "GET", body = null) {
  return new Promise((resolve, reject) => {
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(u, { method, headers, lookup: safeLookup, timeout: timeoutMs }, (res) => {
      const enc = String(res.headers["content-encoding"] || "").toLowerCase();
      let stream = res;
      if (enc === "gzip" || enc === "x-gzip") stream = res.pipe(zlib.createGunzip());
      else if (enc === "deflate") stream = res.pipe(zlib.createInflate());
      else if (enc === "br") stream = res.pipe(zlib.createBrotliDecompress());
      const chunks = []; let size = 0; let truncated = false;
      stream.on("data", (c) => {
        if (truncated) return;
        size += c.length;
        if (size > maxBytes) { truncated = true; chunks.push(c.subarray(0, c.length - (size - maxBytes))); res.destroy(); finish(); return; }
        chunks.push(c);
      });
      let done = false;
      const finish = () => { if (done) return; done = true; resolve({ status: res.statusCode, statusText: res.statusMessage || "", headers: res.headers, body: Buffer.concat(chunks), truncated }); };
      stream.on("end", finish);
      stream.on("error", (e) => { if (truncated) finish(); else reject(new SafeFetchError("The response couldn't be read (" + e.message + ").", "READ")); });
      res.on("aborted", () => truncated ? finish() : null);
    });
    req.on("timeout", () => req.destroy(new SafeFetchError(`No response within ${Math.round(timeoutMs / 1000)} seconds.`, "TIMEOUT")));
    req.on("error", (e) => reject(e instanceof SafeFetchError ? e : new SafeFetchError(
      e.code === "EPRIVATE" ? e.message : e.code === "ENOTFOUND" ? `Couldn't find the host ${u.hostname}.` : e.code === "ECONNREFUSED" ? "The server refused the connection." : /certificate|SSL|TLS/i.test(e.message) ? "The server's HTTPS certificate isn't valid." : "Couldn't connect (" + (e.code || e.message) + ").",
      e.code || "NET")));
    if (body != null) req.write(body);
    req.end();
  });
}

// GET with manual redirects (each hop is re-checked).
export async function safeFetch(raw, { method = "GET", body = null, headers: inHeaders = {}, timeoutMs = 15000, maxBytes = 2_000_000, maxRedirects = 3, httpsOnly = false } = {}) {
  const headers = { ...inHeaders };
  let u = checkUrl(raw, httpsOnly);
  const deadline = Date.now() + timeoutMs;
  for (let hop = 0; ; hop++) {
    const left = deadline - Date.now();
    if (left < 500) throw new SafeFetchError(`No response within ${Math.round(timeoutMs / 1000)} seconds.`, "TIMEOUT");
    const r = await once(u, { "Accept-Encoding": "gzip, deflate, br", ...headers, Host: u.host, ...(body != null ? { "Content-Length": Buffer.byteLength(body) } : {}) }, left, maxBytes, method, body);
    if (method === "GET" && r.status >= 300 && r.status < 400 && r.headers.location && hop < maxRedirects) {
      const next = checkUrl(new URL(r.headers.location, u).href, httpsOnly);
      // Never forward credentials to a different host.
      if (next.host !== u.host) for (const k of Object.keys(headers)) if (/^(authorization|x-api-key|api-key|cookie)$/i.test(k) || /token|key|secret/i.test(k)) delete headers[k];
      u = next; continue;
    }
    return { ...r, url: u.href, redirects: hop };
  }
}
