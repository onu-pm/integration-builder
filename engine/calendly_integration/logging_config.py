"""Logging: one structured JSON line per action, with secrets and personal data masked.

Logs answer "what did the integration do, and when?" for debugging and audit,
without ever containing an access token or a full email address.
"""
import json
import logging
import re
import sys
from datetime import datetime, timezone

TOKEN_PATTERN = re.compile(r"(Bearer\s+)[A-Za-z0-9._\-]+", re.IGNORECASE)
EMAIL_PATTERN = re.compile(r"([A-Za-z0-9._%+\-])[A-Za-z0-9._%+\-]*@([A-Za-z0-9.\-]+)")


def redact(text):
    text = TOKEN_PATTERN.sub(r"\1[REDACTED]", str(text))
    return EMAIL_PATTERN.sub(r"\1***@\2", text)


class JsonFormatter(logging.Formatter):
    def format(self, record):
        entry = {
            "time": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "level": record.levelname,
            "event": redact(record.getMessage()),
        }
        for key in ("method", "path", "status", "attempt", "wait_seconds",
                    "rate_limit_remaining", "page", "records", "stage"):
            if hasattr(record, key):
                entry[key] = redact(getattr(record, key))
        return json.dumps(entry)


def get_logger(name="calendly_integration", level="INFO", log_file=None):
    logger = logging.getLogger(name)
    if logger.handlers:
        return logger
    logger.setLevel(level)
    handler = logging.FileHandler(log_file) if log_file else logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    logger.addHandler(handler)
    logger.propagate = False
    return logger
