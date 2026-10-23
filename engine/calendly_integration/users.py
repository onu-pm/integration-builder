"""Retrieve users. Calendly has no single "list all users" call, so it takes 2 steps:

1. GET /users/me -> the token owner's `current_organization` URI
2. GET /organization_memberships?organization={uri} -> every member of that organization

Step 2 needs an Owner or Admin token; otherwise Calendly returns 403.
"""
from .errors import PermissionDeniedError
from .pagination import fetch_all


def get_organization_uri(client):
    me = client.get("/users/me")["resource"]
    return me["current_organization"]


def list_members(client, organization_uri, logger, max_pages=None):
    try:
        return list(fetch_all(client, "/organization_memberships",
                              {"organization": organization_uri}, logger, max_pages))
    except PermissionDeniedError as error:
        raise PermissionDeniedError(
            403, "Listing all users needs a Calendly Owner or Admin token.", error.path
        ) from error
