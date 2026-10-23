# AI Integration Builder: clickable prototype

Concept by **Anupam Kalita** for the CloudEagle Senior Product Manager assignment ("AI-Generated Integration Builder"). Not a CloudEagle product; all people and data are fictional.

**The idea:** when an app isn't available in Direct Integrations ("No App found"), the admin requests it and assigns a developer. The developer uses AI to generate the integration code from the app's API documentation, tests it in a sandbox, and the admin approves go-live. Once live, it works like any other integration.

## Try it

Use the switch at the top to play both people:

1. **Priya (IT Admin):** search *Calendly* → **Request integration** → assign Ravi → **Send request**
2. **Ravi (Developer):** **Generate code with AI** → **Read docs** → review the cards → **Generate code** → **Continue to Test** → **Run sandbox tests** → upload any `.json`/`.txt` as the trial report → **Continue to Go live** → **Submit for approval**
3. **Priya:** **Connect Calendly** → **Run limited production run** → tick the check → **Approve and go live** → ⋮ → **Open Usage**

Yellow PM notes beside each screen explain the product decisions. **Reset demo** starts over.

## What's real and what's simulated

| Real | Simulated |
|---|---|
| AI reads the API docs and writes the integration (Gemini, server-side) when `GEMINI_API_KEY` is set | Login, invites and roles |
| Docs link fetched by the server; prompt-injection scan before the AI sees it | Connecting the account (no credentials are entered) |
| Safety checks on the generated code (read-only, allowed hosts, no secrets, no dangerous calls, log masking, rate-limit handling) | Trial-account report upload |
| Sandbox run in the browser against a simulated Calendly: 214 users, 3 pages, a 429 retry, Enterprise-only data handled | Limited production run and syncing |

Without a key the app runs in **replay mode**: it shows the understanding and code generated earlier from Calendly's docs and labels it as such.

Many docs portals (Calendly's included) render their content with JavaScript, so a server fetch returns little text. For Calendly the server then uses a captured copy of the reference (`api/_lib/calendly_reference.txt`) and the page says so. For other apps, paste the docs text.

**Model note:** the demo uses Gemini because it has a free tier. The PRD's recommendation is to choose the model by testing candidates on ~20 integrations already built by hand; the model is one environment variable here.

## Deploy on Vercel

1. Import this repo at vercel.com/new (Framework preset: **Other**; no build command).
2. **Settings → Environment Variables:** add `GEMINI_API_KEY` (from Google AI Studio). Optional: `GEMINI_MODEL` (default `gemini-2.5-flash`).
3. Deploy. `GET /api/status` shows whether AI is on.

The key is only read by the server functions in `api/`. It is never sent to the browser. Each IP is limited to 20 AI calls an hour.

## Repo layout

```
public/index.html          the prototype (single page)
api/status.js              is AI configured?
api/understand.js          fetch docs → injection scan → AI extracts the integration spec
api/generate.js            AI writes the integration files from the reviewed spec
api/_lib/                  shared helpers + captured Calendly reference
engine/                    the Python engine behind the prototype document
  calendly_integration/    generated read-only Calendly integration + 13 tests
  sandbox/                 simulated Calendly API
  generator/               generation pipeline and static safety checks
  evidence/                results of the real test and sandbox runs
```

Run the engine tests: `pip install requests pyyaml pytest flask && python -m pytest engine/calendly_integration/tests -v`
