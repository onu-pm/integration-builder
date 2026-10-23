# AI Integration Builder: clickable prototype

Concept by **Anupam Kalita** for the CloudEagle Senior Product Manager assignment ("AI-Generated Integration Builder"). Not a CloudEagle product; all people and data are fictional.

**The idea:** when an app isn't available in Direct Integrations ("No App found"), the admin requests it and assigns a developer. The developer uses AI to generate the integration code from the app's API documentation, tests it in a sandbox, and the admin approves go-live. Once live, it works like any other integration.

## Try it

**Direct Integrations** shows every connected app as a card. Click a card to open it: **Overview**, **Usage**, **Licence management** (select unused licences to remove at renewal) and **Settings** (sync frequency, alerts, reconnect, versions, disconnect) all work.

Two people use it: **Priya** (IT admin) and **Ravi** (the developer she assigns). To add an app that isn't in the grid, click **+ New integration** (or search for it, try *Calendly*), then choose **I'll build it with AI** or **Assign a developer**. Both follow the same four steps:

1. **Data and access** — the admin picks the fields CloudEagle needs (name, email and status are always on; role, last active, usage and date added are recommended; department, manager and job title are optional). Each field says what it's used for. The developer adds technical fields the code needs (app user ID, account ID, last changed, or a custom one). The admin approves read-only access to exactly these fields; anything the developer adds later is flagged for her before go-live.
2. **Create the code** — paste the API docs link or text, pick a language (Python, Node.js, Java, Go). The AI shows where each requested field comes from in the API (available, plan-limited, or not in the API) and the exact read-only permissions (scopes) the code needs. Safety and automatic checks run on their own.
3. **Test it** — connect a test account (or do a read-only check on the company account), read the test report and approve it.
4. **Turn it on** — the admin reviews the permissions page (what CloudEagle can read, what it will never do, the app scopes), connects the company account, checks the first sync and turns it on.

Every **Connect** button (for built-in apps too) opens the same permissions screen before the app's sign-in. Switch between Priya and Ravi from the account menu (top right) or the buttons in the pop-up messages. The bell shows what each person needs to do.

**Reset demo** is at the bottom of the left menu.

## What's real and what's simulated

| Real | Simulated |
|---|---|
| AI reads the API docs and writes the integration (NVIDIA or Gemini, server-side) when a key is set | Login, invites and roles |
| Docs link fetched by the server; prompt-injection scan before the AI sees it | Connecting accounts (no credentials are entered) |
| Safety checks on the generated code (read-only, allowed hosts, no secrets, no dangerous calls, log masking, rate-limit handling) | Test-account responses (a 12-user trial org) |
| Sandbox run in the browser against a simulated Calendly: 214 users, 3 pages, a 429 retry, Enterprise-only data handled | Production preview, approval and syncing |

Without a key the app runs in **replay mode**: it shows the understanding and code generated earlier from Calendly's docs and labels it as such.

Many docs portals (Calendly's included) render their content with JavaScript, so a server fetch returns little text. For Calendly the server then uses a captured copy of the reference (`api/_lib/calendly_reference.txt`) and the page says so. For other apps, paste the docs text.

**Model note:** the demo runs on a free model (NVIDIA or Gemini). The PRD's recommendation is to choose the model by testing candidates on ~20 integrations already built by hand; the model is one environment variable here.

## Deploy on Vercel

1. Import this repo at vercel.com/new (Framework preset: **Other**; no build command).
2. **Settings → Environment Variables** — add one AI key:
   - `NVIDIA_API_KEY` (from build.nvidia.com). Optional `NVIDIA_MODEL` (default `minimaxai/minimax-m3.1-flash`), or
   - `GEMINI_API_KEY` (from Google AI Studio). Optional `GEMINI_MODEL` (default `gemini-3.6-flash`, free tier).
   If both are set, NVIDIA is used.
3. Redeploy. `GET /api/status` shows which provider and model are on.

Keys are only read by the server functions in `api/`. They are never sent to the browser and never stored in the repo. Each IP is limited to 20 AI calls an hour.

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
