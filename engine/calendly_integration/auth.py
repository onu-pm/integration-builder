"""Auth setup: Calendly supports two methods, both sent as a Bearer token.

1. Personal Access Token (PAT): created by an admin in Calendly under
   Integrations > API & Webhooks. Simple, but it never expires and stops
   working if that person's role changes.
2. OAuth 2.0: recommended for organizations. Short-lived access token plus a
   refresh token.

The token is read from the environment or a secrets vault at run time. It is
never written in code, config files or logs.
"""
import os
import time

import requests

OAUTH_TOKEN_URL = "https://auth.calendly.com/oauth/token"


class PersonalAccessTokenAuth:
    def __init__(self, env_var="CALENDLY_TOKEN"):
        self.env_var = env_var

    def header(self):
        token = os.environ.get(self.env_var)
        if not token:
            raise RuntimeError(
                f"No Calendly token found. Set {self.env_var} from your secrets vault."
            )
        return {"Authorization": f"Bearer {token}"}

    def refresh(self):
        return False  # a PAT cannot be refreshed; a 401 means it was revoked


class OAuthAuth:
    """Holds an OAuth access token and refreshes it before it expires."""

    def __init__(self, client_id_env="CALENDLY_CLIENT_ID",
                 client_secret_env="CALENDLY_CLIENT_SECRET",
                 refresh_token_env="CALENDLY_REFRESH_TOKEN"):
        self.client_id = os.environ.get(client_id_env)
        self.client_secret = os.environ.get(client_secret_env)
        self.refresh_token = os.environ.get(refresh_token_env)
        self.access_token = None
        self.expires_at = 0

    def header(self):
        if not self.access_token or time.time() > self.expires_at - 60:
            self.refresh()
        return {"Authorization": f"Bearer {self.access_token}"}

    def refresh(self):
        response = requests.post(OAUTH_TOKEN_URL, data={
            "grant_type": "refresh_token",
            "refresh_token": self.refresh_token,
            "client_id": self.client_id,
            "client_secret": self.client_secret,
        }, timeout=30)
        response.raise_for_status()
        data = response.json()
        self.access_token = data["access_token"]
        self.refresh_token = data.get("refresh_token", self.refresh_token)
        self.expires_at = time.time() + int(data.get("expires_in", 7200))
        return True


def build_auth(method):
    if method == "oauth":
        return OAuthAuth()
    return PersonalAccessTokenAuth()
