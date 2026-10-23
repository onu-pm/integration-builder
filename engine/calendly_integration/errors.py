"""Error handling: one exception type per failure the Calendly API documents.

Calendly returns JSON error bodies (typically with "title" and "message"), but
we parse them defensively because AI-generated code must never crash on an
unexpected error shape.
"""


class CalendlyError(Exception):
    """Base class. `retryable` tells the client whether trying again can help."""

    retryable = False

    def __init__(self, status, message, path=None):
        self.status = status
        self.path = path
        super().__init__(f"[{status}] {message} ({path})")


class InvalidRequestError(CalendlyError):      # 400: bad parameter, a bug in our request
    pass


class AuthenticationError(CalendlyError):      # 401: token missing, expired or revoked
    pass


class PermissionDeniedError(CalendlyError):    # 403: not an admin/owner, or feature not on this plan
    pass


class NotFoundError(CalendlyError):            # 404: organization or user URI does not exist
    pass


class RateLimitError(CalendlyError):           # 429: still limited after all retries
    retryable = True


class ServerError(CalendlyError):              # 5xx: Calendly-side problem
    retryable = True


STATUS_TO_ERROR = {
    400: InvalidRequestError,
    401: AuthenticationError,
    403: PermissionDeniedError,
    404: NotFoundError,
    429: RateLimitError,
}


def error_from_response(response, path):
    """Turn an HTTP error response into the right exception, whatever its body looks like."""
    try:
        body = response.json()
        message = body.get("message") or body.get("title") or response.reason
    except ValueError:
        message = response.reason or "Unknown error"
    cls = STATUS_TO_ERROR.get(response.status_code)
    if cls is None:
        cls = ServerError if response.status_code >= 500 else CalendlyError
    return cls(response.status_code, message, path)
