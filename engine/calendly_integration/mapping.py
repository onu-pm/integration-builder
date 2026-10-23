"""Field mapping: translate Calendly's data structure into one standard
CloudEagle user record, so Usage and License Management work the same for
every app. (The CloudEagle record shape is an assumption to confirm with the
CloudEagle team.)

Calendly field                              -> CloudEagle field
organization_membership.user.uri            -> external_id
organization_membership.user.name           -> name
organization_membership.user.email          -> email
organization_membership.role                -> role (owner / admin / user)
organization_membership.created_at          -> added_on
count of scheduled events hosted (90 days)  -> usage_90d
latest activity log entry (Enterprise only) -> last_active
"Calendly"                                  -> application
"""

APPLICATION = "Calendly"


def to_cloudeagle_record(membership, meetings, last_active, activity_available):
    user = membership["user"]
    usage = meetings.get(user["uri"], 0)
    active_signal = usage > 0 or bool(last_active)
    return {
        "application": APPLICATION,
        "external_id": user["uri"],
        "name": user.get("name"),
        "email": user.get("email"),
        "role": membership.get("role"),
        "added_on": membership.get("created_at"),
        "usage_90d": usage,
        "usage_metric": "meetings_hosted",
        "last_active": last_active if activity_available else None,
        "last_active_available": activity_available,
        "status": "active" if active_signal else "inactive",
    }


def map_all(memberships, meetings, activity, activity_available):
    return [to_cloudeagle_record(m, meetings, activity.get(m["user"]["uri"]), activity_available)
            for m in memberships]
