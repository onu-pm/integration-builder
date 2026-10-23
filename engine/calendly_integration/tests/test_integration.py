"""Validation suite: runs the generated integration against CloudEagle's
simulated Calendly. One test per requirement in the brief, plus safeguards."""
import io
import json
import logging
import os
import sys
import threading

import pytest
from werkzeug.serving import make_server

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "sandbox"))

from calendly_integration import sync                                          # noqa: E402
from calendly_integration.auth import PersonalAccessTokenAuth                  # noqa: E402
from calendly_integration.client import CalendlyClient                         # noqa: E402
from calendly_integration.errors import (AuthenticationError, NotFoundError,   # noqa: E402
                                         PermissionDeniedError)
from calendly_integration.logging_config import JsonFormatter                  # noqa: E402
from calendly_integration.mapping import map_all                               # noqa: E402
from calendly_integration.usage import last_activity_per_user, meetings_per_user  # noqa: E402
from calendly_integration.users import get_organization_uri, list_members      # noqa: E402
from simulated_calendly import ORG, VALID_TOKEN, create_app                    # noqa: E402


class Sim:
    """Starts the simulated Calendly on a free port with a given scenario."""

    def __init__(self, **scenario):
        self.app = create_app(**scenario)
        self.server = make_server("localhost", 0, self.app)
        self.url = f"http://localhost:{self.server.server_port}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    @property
    def requests(self):
        return self.app.config["REQUEST_LOG"]

    def stop(self):
        self.server.shutdown()


@pytest.fixture
def log_stream():
    stream = io.StringIO()
    logger = logging.getLogger(f"test-{id(stream)}")
    logger.handlers.clear()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(JsonFormatter())
    logger.addHandler(handler)
    logger.setLevel("INFO")
    logger.propagate = False
    return logger, stream


def make_client(sim, logger, token=VALID_TOKEN, waits=None):
    os.environ["CALENDLY_TOKEN"] = token
    return CalendlyClient(sim.url, PersonalAccessTokenAuth(), logger,
                          allowed_hosts=["localhost"],
                          sleep=(waits.append if waits is not None else (lambda s: None)))


# 1. Auth setup
def test_auth_bearer_token_accepted_and_bad_token_rejected(log_stream):
    logger, _ = log_stream
    sim = Sim()
    try:
        assert get_organization_uri(make_client(sim, logger)) == ORG
        with pytest.raises(AuthenticationError) as err:
            get_organization_uri(make_client(sim, logger, token="wrong"))
        assert "Reconnect Calendly" in str(err.value)
    finally:
        sim.stop()


# 2. Users: two-step lookup + 3. Pagination
def test_users_two_steps_across_all_pages(log_stream):
    logger, _ = log_stream
    sim = Sim()
    try:
        client = make_client(sim, logger)
        members = list_members(client, get_organization_uri(client), logger)
        assert len(members) == 214
        paths = [r["path"] for r in sim.requests if "organization_memberships" in r["path"]]
        assert len(paths) == 3                       # 100 + 100 + 14
        assert all("count=100" in p for p in paths)
        assert "page_token=100" in paths[1] and "page_token=200" in paths[2]
    finally:
        sim.stop()


# 4. Usage: meetings booked (all plans) and last activity (Enterprise only)
def test_usage_meetings_and_activity_enterprise(log_stream):
    logger, _ = log_stream
    sim = Sim()
    try:
        client = make_client(sim, logger)
        users, events, _ = sim.app.config["DATA"]
        meetings = meetings_per_user(client, ORG, logger)
        assert sum(meetings.values()) == len(events)
        activity, available = last_activity_per_user(client, ORG, logger)
        assert available and len(activity) == 150
    finally:
        sim.stop()


def test_usage_activity_log_unavailable_without_enterprise(log_stream):
    logger, _ = log_stream
    sim = Sim(enterprise=False)
    try:
        activity, available = last_activity_per_user(make_client(sim, logger), ORG, logger)
        assert activity == {} and available is False   # sync continues, signal marked unavailable
    finally:
        sim.stop()


# 5. Error handling
def test_rate_limit_429_waits_for_reset_and_retries(log_stream):
    logger, _ = log_stream
    sim = Sim(rate_limit_once_on="/scheduled_events")
    waits = []
    try:
        meetings_per_user(make_client(sim, logger, waits=waits), ORG, logger)
        statuses = [r["status"] for r in sim.requests if "scheduled_events" in r["path"]]
        assert statuses[0] == 429 and statuses[1] == 200
        assert waits[0] == 2.0                          # waited X-RateLimit-Reset seconds
    finally:
        sim.stop()


def test_server_error_retried_with_backoff(log_stream):
    logger, _ = log_stream
    sim = Sim(rate_limit_once_on=None, server_error_once_on="/organization_memberships")
    waits = []
    try:
        members = list_members(make_client(sim, logger, waits=waits), ORG, logger)
        assert len(members) == 214 and waits == [1]
    finally:
        sim.stop()


def test_non_admin_gets_clear_permission_error(log_stream):
    logger, _ = log_stream
    sim = Sim(token_role="user")
    try:
        with pytest.raises(PermissionDeniedError) as err:
            list_members(make_client(sim, logger), ORG, logger)
        assert "Owner or Admin" in str(err.value)
    finally:
        sim.stop()


def test_unknown_organization_is_not_found(log_stream):
    logger, _ = log_stream
    sim = Sim()
    try:
        with pytest.raises(NotFoundError):
            list_members(make_client(sim, logger), ORG + "X", logger)
    finally:
        sim.stop()


# 6. Logging: every request logged, no token and no full email in logs
def test_logs_are_structured_and_redacted(log_stream):
    logger, stream = log_stream
    sim = Sim()
    try:
        client = make_client(sim, logger)
        list_members(client, get_organization_uri(client), logger)
        logger.info("debug Bearer sim-test-token user1@example-corp.com")
        lines = [json.loads(l) for l in stream.getvalue().splitlines()]
        assert any(l["event"] == "request" and l["status"] == "200" for l in lines)
        text = stream.getvalue()
        assert VALID_TOKEN not in text and "user1@example-corp.com" not in text
    finally:
        sim.stop()


# Safeguards: read-only client and host allow-list
def test_client_is_read_only_and_host_restricted(log_stream):
    logger, _ = log_stream
    sim = Sim()
    try:
        client = make_client(sim, logger)
        for verb in ("post", "put", "patch", "delete"):
            assert not hasattr(client, verb)
        with pytest.raises(ValueError):
            client.get("https://evil.example.com/steal")
    finally:
        sim.stop()


# Data structures: Calendly -> CloudEagle standard record
def test_mapping_to_cloudeagle_format(log_stream):
    logger, _ = log_stream
    sim = Sim()
    try:
        client = make_client(sim, logger)
        members = list_members(client, ORG, logger)
        meetings = meetings_per_user(client, ORG, logger)
        activity, available = last_activity_per_user(client, ORG, logger)
        records = map_all(members, meetings, activity, available)
        expected = {"application", "external_id", "name", "email", "role", "added_on",
                    "usage_90d", "usage_metric", "last_active", "last_active_available", "status"}
        assert all(set(r) == expected for r in records)
        assert {r["status"] for r in records} == {"active", "inactive"}
    finally:
        sim.stop()


# Sandbox before production: the stage gate
def test_production_blocked_until_sandbox_passes(tmp_path, monkeypatch):
    monkeypatch.setattr(sync, "REPORTS", str(tmp_path))
    with pytest.raises(SystemExit) as err:
        sync.check_stage_gate("production", limited=True)
    assert "sandbox" in str(err.value)
    (tmp_path / "sandbox_report.json").write_text(json.dumps({"passed": True}))
    sync.check_stage_gate("production", limited=True)          # limited run now allowed
    with pytest.raises(SystemExit) as err:
        sync.check_stage_gate("production", limited=False)     # full run still blocked
    assert "limited" in str(err.value)


def test_limited_production_run_fetches_one_page_only(log_stream):
    logger, _ = log_stream
    sim = Sim()
    try:
        members = list_members(make_client(sim, logger), ORG, logger, max_pages=1)
        assert len(members) == 100
    finally:
        sim.stop()
