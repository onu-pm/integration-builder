# Fetch: find and test any API

Live: https://fetch-integration-builder.vercel.app

A developer tool: from an app name to a working, tested API call.

1. **App**: type the app's name. Popular apps use a checked docs link; anything else is found with AI web search (Gemini + Google Search), and the link is opened to confirm it loads. You can change it or paste the docs text.
2. **APIs**: as soon as the docs are found, Fetch shows the read endpoints grouped by module, like the docs. Fields are optional: add them to get the exact endpoints that return them.
   Fetch reads the docs (and related pages on the same site, or an OpenAPI spec) and returns the read-only endpoints that give those fields: path, parameters, where each field sits in the response, scopes, how auth works, how to get a key on a free/trial account, paging and rate limits.
3. **Test**: a Postman-style tester. Add your trial key once in **Auth** (collection-level), fill the parameters, **Send**. See status, time, size, pretty JSON, headers, and a check of which of your fields came back. Copy as cURL or download a **Postman Collection (v2.1)** to import into Postman.
4. **Code**: generate a small read-only client in Python, Node.js, Java or Go, checked by 7 safety rules, and download it as a .zip.

## Security model

- **Keys are never stored.** The key lives only in the open tab's memory (not localStorage, not cookies). It's sent to `/api/proxy` with each request and forwarded to the API. The server doesn't log or keep it. Exports (Postman, cURL, code) use a placeholder (`{{apiKey}}`, `$APP_API_KEY`).
- **Read-only.** The proxy only sends GET.
- **SSRF-safe.** https only, standard ports, no credentials in URLs, and every hostname is resolved and checked at connect time: private, loopback, link-local, CGNAT and cloud-metadata ranges are refused, including after redirects. Credentials are dropped on cross-host redirects.
- **Limits.** Per-IP rate limits (AI runs, searches and test requests), 15 s timeout and 1 MB response cap.
- **Prompt injection.** Docs are scanned before the AI sees them and treated as data only.

## Deploy on Vercel

Framework preset **Other**, no build command. Environment variables:

| Name | Required | Notes |
|---|---|---|
| `GEMINI_API_KEY` | yes | Google AI Studio key. Never put it in code. |
| `GEMINI_MODEL` | no | Defaults to `gemini-3.6-flash`; falls back to lighter models when busy. |
| `SERPER_API_KEY` | no | Google search via serper.dev for finding docs (Postman docs first). Without it, Gemini search or guesses are used. |
| `JINA_API_KEY` | no | Raises the rate limit of the reader used for JavaScript-rendered docs pages. |

## Layout

- `public/index.html`: the whole front end (no build step).
- `api/find-docs.js`: app name → docs URL.
- `api/discover.js`: docs + fields → endpoints, auth, field map.
- `api/proxy.js`: the tester's GET relay.
- `api/generate.js`: code generation, in two parallel halves.
- `api/_lib/`: Gemini client, docs reader, SSRF-safe fetch, app list.
- `engine/`: an earlier hand-checked reference integration (Python, with tests).
