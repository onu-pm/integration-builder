"""Retrieve usage. Calendly exposes two usage signals:

1. Meetings booked per user (all plans): GET /scheduled_events for the
   organization in the last N days, counted per host via `event_memberships`.
2. Last activity per user (Enterprise plan only): GET /activity_log_entries.
   On non-Enterprise plans Calendly returns 403; we record that the signal is
   unavailable instead of failing the whole sync.
"""
from collections import Counter
from datetime import datetime, timedelta, timezone

from .errors import PermissionDeniedError
from .pagination import fetch_all


def _iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%S.000000Z")


def meetings_per_user(client, organization_uri, logger, days=90, max_pages=None):
    now = datetime.now(timezone.utc)
    params = {
        "organization": organization_uri,
        "min_start_time": _iso(now - timedelta(days=days)),
        "max_start_time": _iso(now),
        "status": "active",
    }
    counts = Counter()
    for event in fetch_all(client, "/scheduled_events", params, logger, max_pages):
        for host in event.get("event_memberships", []):
            counts[host["user"]] += 1
    return counts


def last_activity_per_user(client, organization_uri, logger, days=90, max_pages=None):
    """Returns ({user_uri: latest occurred_at}, available: bool)."""
    since = datetime.now(timezone.utc) - timedelta(days=days)
    params = {"organization": organization_uri, "min_occurred_at": _iso(since)}
    latest = {}
    try:
        for entry in fetch_all(client, "/activity_log_entries", params, logger, max_pages):
            actor = (entry.get("actor") or {}).get("uri")
            when = entry.get("occurred_at")
            if actor and when and (actor not in latest or when > latest[actor]):
                latest[actor] = when  # ISO-8601 UTC strings compare correctly
    except PermissionDeniedError:
        logger.info("activity log unavailable (Calendly Enterprise plan only)")
        return {}, False
    return latest, True
