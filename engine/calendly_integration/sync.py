"""Entry point: run the integration for one stage.

    python -m calendly_integration.sync --stage sandbox
    python -m calendly_integration.sync --stage production --limited   # read-only, 1 page, nothing saved
    python -m calendly_integration.sync --stage production

Stage gate: production will not run unless the sandbox run has passed
(reports/sandbox_report.json with "passed": true). The limited production run
must pass before a full production sync.
"""
import argparse
import json
import os
import sys
from datetime import datetime, timezone

import yaml

from .auth import build_auth
from .client import CalendlyClient
from .logging_config import get_logger
from .mapping import map_all
from .usage import last_activity_per_user, meetings_per_user
from .users import get_organization_uri, list_members

HERE = os.path.dirname(os.path.abspath(__file__))
REPORTS = os.path.join(HERE, "reports")


def load_config(stage):
    with open(os.path.join(HERE, "config", f"{stage}.yaml")) as f:
        return yaml.safe_load(f)


def _report(name):
    path = os.path.join(REPORTS, name)
    if not os.path.exists(path):
        return None
    with open(path) as f:
        return json.load(f)


def check_stage_gate(stage, limited):
    if stage != "production":
        return
    sandbox = _report("sandbox_report.json")
    if not sandbox or not sandbox.get("passed"):
        sys.exit("Blocked: run and pass the sandbox stage before production.")
    if not limited:
        trial = _report("production_limited_report.json")
        if not trial or not trial.get("passed"):
            sys.exit("Blocked: run and pass the limited production run (--limited) first.")


def run(stage, limited=False, client=None):
    config = load_config(stage)
    logger = get_logger(level=config.get("log_level", "INFO"))
    check_stage_gate(stage, limited)
    max_pages = 1 if limited else None
    logger.info("sync started", extra={"stage": stage + (" (limited)" if limited else "")})

    client = client or CalendlyClient(
        base_url=config["base_url"], auth=build_auth(config["auth_method"]),
        logger=logger, allowed_hosts=config["allowed_hosts"])

    org = get_organization_uri(client)
    members = list_members(client, org, logger, max_pages)
    meetings = meetings_per_user(client, org, logger, config["usage_window_days"], max_pages)
    activity, available = last_activity_per_user(client, org, logger,
                                                 config["usage_window_days"], max_pages)
    records = map_all(members, meetings, activity, available)

    summary = {
        "stage": stage, "limited": limited,
        "finished_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "users": len(records),
        "inactive_users": sum(r["status"] == "inactive" for r in records),
        "last_active_available": available,
        "passed": len(records) > 0,
    }
    logger.info("sync finished", extra={"records": len(records)})

    os.makedirs(REPORTS, exist_ok=True)
    name = f"{stage}{'_limited' if limited else ''}_report.json"
    with open(os.path.join(REPORTS, name), "w") as f:
        json.dump(summary, f, indent=2)

    if not limited and config.get("deliver_to_cloudeagle"):
        out = os.path.join(REPORTS, f"{stage}_records.json")
        with open(out, "w") as f:
            json.dump(records, f, indent=2)  # hand-off point to CloudEagle ingestion (assumed)
    return summary, records


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--stage", choices=["sandbox", "production"], required=True)
    parser.add_argument("--limited", action="store_true",
                        help="read-only first page only, nothing saved")
    args = parser.parse_args()
    summary, _ = run(args.stage, args.limited)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
