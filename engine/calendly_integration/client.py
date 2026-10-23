"""API client: the single gateway to Calendly.

Safeguards are built in here, so no other file can bypass them:
- Read-only: only GET exists. There is no method to create, change or delete.
- Host allow-list: requests can only go to the configured Calendly host.
- Rate limits: reads X-RateLimit-Remaining / X-RateLimit-Reset, pauses before
  running out, and on 429 waits for the reset before retrying.
- Retries with backoff for 429 and 5xx; immediate, clear errors for 400/401/403/404.
"""
import time
from urllib.parse import urlparse

import requests

from .errors import AuthenticationError, error_from_response


class CalendlyClient:
    def __init__(self, base_url, auth, logger, allowed_hosts,
                 timeout=30, max_retries=4, sleep=time.sleep):
        self.base_url = base_url.rstrip("/")
        self.auth = auth
        self.log = logger
        self.allowed_hosts = set(allowed_hosts)
        self.timeout = timeout
        self.max_retries = max_retries
        self.sleep = sleep
        self.session = requests.Session()
        self.session.headers.update({"Accept": "application/json"})
        self._check_host(self.base_url)

    def _check_host(self, url):
        host = urlparse(url).hostname
        if host not in self.allowed_hosts:
            raise ValueError(f"Blocked request to non-allowed host: {host}")

    def get(self, path_or_url, params=None):
        url = path_or_url if path_or_url.startswith("http") else f"{self.base_url}{path_or_url}"
        self._check_host(url)
        path = urlparse(url).path
        refreshed = False

        for attempt in range(1, self.max_retries + 2):
            response = self.session.get(url, params=params, headers=self.auth.header(),
                                        timeout=self.timeout)
            remaining = response.headers.get("X-RateLimit-Remaining")
            reset = response.headers.get("X-RateLimit-Reset")
            self.log.info("request", extra={"method": "GET", "path": path,
                                            "status": response.status_code, "attempt": attempt,
                                            "rate_limit_remaining": remaining})

            if response.ok:
                # Slow down before hitting the limit, not after.
                if remaining is not None and int(remaining) <= 1 and reset:
                    wait = float(reset)
                    self.log.info("rate limit nearly used, pausing",
                                  extra={"wait_seconds": wait})
                    self.sleep(wait)
                return response.json()

            if response.status_code == 401 and not refreshed and self.auth.refresh():
                refreshed = True
                continue

            error = error_from_response(response, path)
            if error.retryable and attempt <= self.max_retries:
                if response.status_code == 429 and reset:
                    wait = float(reset)
                else:
                    wait = min(2 ** (attempt - 1), 30)  # 1, 2, 4, 8 ... capped at 30s
                self.log.warning("retrying", extra={"path": path, "status": response.status_code,
                                                    "attempt": attempt, "wait_seconds": wait})
                self.sleep(wait)
                continue

            self.log.error("request failed", extra={"path": path, "status": response.status_code})
            if isinstance(error, AuthenticationError):
                error.args = (str(error) + " Reconnect Calendly: the token is invalid or revoked.",)
            raise error

        raise error  # pragma: no cover
