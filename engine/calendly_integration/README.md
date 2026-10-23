# Calendly integration for CloudEagle (AI-generated, read-only)

Retrieves Calendly users and usage and maps them to CloudEagle's standard user record.

## What it needs
- A Calendly **Owner or Admin** token (Calendly only lists all organization members for these roles).
- Token in the environment (`CALENDLY_TOKEN`) or from your secrets vault. Never in code or config.
- Python 3.10+, `pip install requests pyyaml`.

## Run order (enforced by the code)
1. **Simulated sandbox** (CloudEagle): `python -m pytest tests` (no account needed)
2. **Trial account**: point `config/sandbox.yaml` at `https://api.calendly.com`, then
   `python -m calendly_integration.sync --stage sandbox`. Check the user count against Calendly's admin panel.
3. **Limited production run**: `python -m calendly_integration.sync --stage production --limited`
   (read-only, first page only, nothing saved)
4. **Full production sync**: `python -m calendly_integration.sync --stage production`

Production refuses to run until steps 2 and 3 have passed.

## Usage signals
- Meetings hosted in the last 90 days (all plans), from `/scheduled_events`.
- Last activity (Calendly Enterprise only), from `/activity_log_entries`. On other plans this is marked unavailable and the sync continues.
