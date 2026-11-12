# Fetch: find and test any API

Live: https://fetch-integration-builder.vercel.app

A developer tool: from an app name to a working, tested API call.

1. **App**: type the app's name. A directory of ~270 apps (with logos) suggests as you type; anything else is searched. Fetch lists the docs pages it finds (Postman docs first, then the official reference) and you pick one.
2. **APIs**: every endpoint, all methods, grouped by module like the docs, with a module sidebar and search. Postman collections and OpenAPI specs are read exactly (complete); plain HTML docs are read by AI (may miss some). Expand an endpoint for parameters, body and response examples; tick the ones you need and they collect in the Selected panel.
3. **Test**: a Postman-style tester for the selected endpoints. Pick the environment (sandbox or production base URL), add your sandbox key once in **Auth**, fill params, headers and body, **Send**. Copy as cURL or download a Postman Collection (v2.1).
4. **Code**: generate a client for the selected endpoints in Python, Node.js, Java or Go, checked by 7 safety rules, and download it as a .zip.

## Security model

- **Keys are never stored.** The key lives only in the open tab's memory (not localStorage, not cookies). It's sent to `/api/proxy` with each request and forwarded to the API. The server doesn't log or keep it. Exports (Postman, cURL, code) use a placeholder (`{{apiKey}}`, `$APP_API_KEY`).
- **Writes are fenced.** GET goes to any public https host. POST/PUT/PATCH/DELETE only go to hosts Fetch read from the app's docs (the server signs them), need the developer to confirm a sandbox/test account, and have tighter limits.
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
