"""CloudEagle simulated sandbox for Calendly.

Calendly has no developer sandbox, so CloudEagle builds a simulated API from
the documentation: same paths, parameters, response shapes, cursor pagination,
rate-limit headers and error codes. Generated code is tested here before it
touches any real account. Test data is fictional.

Scenarios (set via create_app arguments) let tests force each failure the docs
describe: 401, 403 (non-admin / non-Enterprise), 404, 429 and 500.
"""
import random
from datetime import datetime, timedelta, timezone

from flask import Flask, jsonify, request

ORG = "https://api.calendly.com/organizations/ORG_SIM_001"
VALID_TOKEN = "sim-test-token"


def _ts(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%S.000000Z")


def build_data(n_users=214, seed=7):
    rng = random.Random(seed)
    now = datetime.now(timezone.utc)
    first = ["Aarav", "Diya", "Kabir", "Meera", "Rohan", "Sara", "Vikram", "Anika", "Leo", "Maya"]
    last = ["Shah", "Iyer", "Khan", "Das", "Rao", "Patel", "Singh", "Menon", "Gupta", "Bose"]
    users = []
    for i in range(n_users):
        name = f"{first[i % 10]} {last[(i // 10) % 10]} {i + 1}"
        uri = f"https://api.calendly.com/users/USER_{i + 1:04d}"
        role = "owner" if i == 0 else ("admin" if i < 4 else "user")
        users.append({
            "uri": f"https://api.calendly.com/organization_memberships/MEM_{i + 1:04d}",
            "role": role,
            "organization": ORG,
            "created_at": _ts(now - timedelta(days=rng.randint(30, 900))),
            "updated_at": _ts(now - timedelta(days=rng.randint(1, 29))),
            "user": {
                "uri": uri, "name": name,
                "slug": name.lower().replace(" ", "-"),
                "email": f"user{i + 1}@example-corp.com",
                "scheduling_url": f"https://calendly.com/{name.lower().replace(' ', '-')}",
                "timezone": "Asia/Kolkata",
                "created_at": _ts(now - timedelta(days=900)),
                "updated_at": _ts(now - timedelta(days=5)),
            },
        })
    # Roughly 30% of users host no meetings in the last 90 days (unused seats).
    events = []
    for u in users:
        if rng.random() < 0.30:
            continue
        for _ in range(rng.randint(1, 4)):
            start = now - timedelta(days=rng.randint(1, 85), hours=rng.randint(0, 23))
            events.append({
                "uri": f"https://api.calendly.com/scheduled_events/EV_{len(events) + 1:05d}",
                "name": "30 Minute Meeting", "status": "active",
                "start_time": _ts(start), "end_time": _ts(start + timedelta(minutes=30)),
                "event_type": "https://api.calendly.com/event_types/ET_1",
                "event_memberships": [{"user": u["user"]["uri"],
                                       "user_email": u["user"]["email"],
                                       "user_name": u["user"]["name"]}],
            })
    activity = []
    for u in users[:150]:
        activity.append({
            "uri": f"https://api.calendly.com/activity_log_entries/AL_{len(activity) + 1:05d}",
            "occurred_at": _ts(now - timedelta(days=rng.randint(0, 60))),
            "organization": ORG, "namespace": "User", "action": "Login",
            "actor": {"uri": u["user"]["uri"], "display_name": u["user"]["name"],
                      "organization": ORG, "type": "User"},
            "details": {},
        })
    return users, events, activity


def create_app(enterprise=True, token_role="admin", rate_limit_once_on="/scheduled_events",
               server_error_once_on=None, n_users=214):
    app = Flask(__name__)
    users, events, activity = build_data(n_users)
    state = {"rate_limited": set(), "errored": set(), "remaining": 500}
    app.config["REQUEST_LOG"] = []

    def page(items):
        count = min(int(request.args.get("count", 20)), 100)
        start = int(request.args.get("page_token", "0") or 0)
        chunk = items[start:start + count]
        nxt = start + count if start + count < len(items) else None
        return {"collection": chunk, "pagination": {
            "count": len(chunk),
            "next_page": f"{request.base_url}?page_token={nxt}" if nxt is not None else None,
            "previous_page": None,
            "next_page_token": str(nxt) if nxt is not None else None,
            "previous_page_token": None}}

    def error(status, title, message):
        return jsonify({"title": title, "message": message}), status

    @app.before_request
    def checks():
        auth = request.headers.get("Authorization", "")
        if auth != f"Bearer {VALID_TOKEN}":
            return error(401, "Unauthenticated", "The access token is invalid")
        if rate_limit_once_on == request.path and request.path not in state["rate_limited"]:
            state["rate_limited"].add(request.path)
            resp, status = error(429, "Too Many Requests", "Rate limit exceeded")
            resp.headers.update({"X-RateLimit-Limit": "500", "X-RateLimit-Remaining": "0",
                                 "X-RateLimit-Reset": "2"})
            return resp, status
        if server_error_once_on == request.path and request.path not in state["errored"]:
            state["errored"].add(request.path)
            return error(500, "Internal Server Error", "Please try again")
        return None

    @app.after_request
    def headers(resp):
        if resp.status_code != 429:
            state["remaining"] = max(state["remaining"] - 1, 2)
            resp.headers.update({"X-RateLimit-Limit": "500",
                                 "X-RateLimit-Remaining": str(state["remaining"]),
                                 "X-RateLimit-Reset": "60"})
        app.config["REQUEST_LOG"].append({
            "method": request.method, "path": request.full_path.rstrip("?"),
            "status": resp.status_code,
            "rate_limit_remaining": resp.headers.get("X-RateLimit-Remaining"),
            "reset": resp.headers.get("X-RateLimit-Reset")})
        return resp

    @app.get("/users/me")
    def me():
        u = users[0]["user"]
        return jsonify({"resource": {**u, "current_organization": ORG}})

    def require_org():
        org = request.args.get("organization")
        if org != ORG:
            return error(404, "Resource Not Found", "The organization was not found")
        return None

    @app.get("/organization_memberships")
    def memberships():
        bad = require_org()
        if bad:
            return bad
        if token_role == "user":
            return error(403, "Permission Denied", "You do not have permission")
        return jsonify(page(users))

    @app.get("/scheduled_events")
    def scheduled_events():
        bad = require_org()
        if bad:
            return bad
        lo, hi = request.args.get("min_start_time"), request.args.get("max_start_time")
        items = [e for e in events if (not lo or e["start_time"] >= lo)
                 and (not hi or e["start_time"] <= hi)]
        return jsonify(page(items))

    @app.get("/activity_log_entries")
    def activity_log():
        bad = require_org()
        if bad:
            return bad
        if not enterprise:
            return error(403, "Permission Denied", "This feature requires an Enterprise plan")
        return jsonify(page(activity))

    app.config["DATA"] = (users, events, activity)
    return app


if __name__ == "__main__":
    create_app().run(port=8765)
