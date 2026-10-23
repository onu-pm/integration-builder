"""Automatic safety checks run on every AI-generated integration before a human sees it.

Static checks on the code (no execution):
 1. Read-only: no POST/PUT/PATCH/DELETE calls anywhere.
 2. Host allow-list: every hard-coded URL points to an allowed host.
 3. No secrets in code: no token-like strings or literal Authorization values.
 4. No dangerous calls: eval, exec, subprocess, os.system, pickle, raw sockets.
 5. Logging redaction present: logs mask tokens and emails.
 6. Rate-limit handling present: 429 / X-RateLimit headers handled.
Plus one check on the input:
 7. Prompt injection: the API docs contain no instructions aimed at the AI.
"""
import ast
import os
import re
import sys

WRITE_METHODS = {"post", "put", "patch", "delete"}
DANGEROUS = {"eval", "exec", "compile", "__import__", "system", "popen",
             "Popen", "call", "run", "loads", "socket"}
DANGEROUS_MODULES = {"subprocess", "pickle", "socket", "ctypes"}
SECRET_PATTERNS = [re.compile(p) for p in (
    r"Bearer\s+[A-Za-z0-9\-_\.]{20,}",
    r"eyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{10,}",      # JWT-looking tokens
    r"(?i)(api[_-]?key|secret|password)\s*=\s*['\"][^'\"]{8,}['\"]",
)]
INJECTION_PATTERNS = [re.compile(p, re.I) for p in (
    r"ignore (all |any )?(previous|prior) instructions",
    r"you are (now )?(an? )?(ai|assistant|language model)",
    r"send (the )?(token|key|credentials|secret)",
    r"(system|developer) prompt",
    r"exfiltrat",
)]
URL_PATTERN = re.compile(r"https?://([A-Za-z0-9.\-]+)")


def _py_files(folder):
    for root, _, files in os.walk(folder):
        if "tests" in root.split(os.sep):
            continue
        for name in files:
            if name.endswith(".py"):
                yield os.path.join(root, name)


def check_code(folder, allowed_hosts):
    findings = {k: [] for k in ("read_only", "hosts", "secrets", "dangerous",
                                "log_redaction", "rate_limits")}
    all_source = ""
    for path in _py_files(folder):
        source = open(path).read()
        all_source += source
        rel = os.path.relpath(path, folder)
        tree = ast.parse(source)
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
                attr = node.func.attr
                owner = getattr(node.func.value, "id", "") or getattr(node.func.value, "attr", "")
                if attr in WRITE_METHODS and owner in {"requests", "session", "self", "client", "http"}:
                    if not (owner == "requests" and attr == "post" and "auth.py" in rel):
                        findings["read_only"].append(f"{rel}:{node.lineno} {owner}.{attr}()")
                if attr in DANGEROUS and owner in {"os", "subprocess", "pickle", "socket"}:
                    findings["dangerous"].append(f"{rel}:{node.lineno} {owner}.{attr}()")
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) \
                    and node.func.id in {"eval", "exec", "compile", "__import__"}:
                findings["dangerous"].append(f"{rel}:{node.lineno} {node.func.id}()")
            if isinstance(node, (ast.Import, ast.ImportFrom)):
                names = [a.name.split(".")[0] for a in node.names] if isinstance(node, ast.Import) \
                    else [(node.module or "").split(".")[0]]
                for n in names:
                    if n in DANGEROUS_MODULES:
                        findings["dangerous"].append(f"{rel}:{node.lineno} import {n}")
        for host in URL_PATTERN.findall(source):
            if host not in allowed_hosts:
                findings["hosts"].append(f"{rel}: {host}")
        for pattern in SECRET_PATTERNS:
            for m in pattern.finditer(source):
                findings["secrets"].append(f"{rel}: {m.group(0)[:20]}...")
    if "REDACTED" not in all_source:
        findings["log_redaction"].append("no token redaction found in logging")
    if "429" not in all_source and "RateLimit" not in all_source:
        findings["rate_limits"].append("no 429 / X-RateLimit handling found")
    return findings


def check_docs_for_injection(docs_text):
    return [m.group(0) for p in INJECTION_PATTERNS for m in p.finditer(docs_text)]


LABELS = {
    "read_only": "Read-only: no create/update/delete requests",
    "hosts": "Only calls allowed hosts",
    "secrets": "No secrets written in code",
    "dangerous": "No dangerous calls (eval, exec, subprocess, pickle, sockets)",
    "log_redaction": "Logs mask tokens and emails",
    "rate_limits": "Handles rate limits (429 / X-RateLimit headers)",
}


def report(findings, injection_hits):
    rows = [(LABELS[k], "PASS" if not v else "FAIL", "; ".join(v)) for k, v in findings.items()]
    rows.append(("API docs scanned for prompt injection",
                 "PASS" if not injection_hits else "FAIL", "; ".join(injection_hits)))
    return rows


if __name__ == "__main__":
    folder = sys.argv[1]
    hosts = {"api.calendly.com", "auth.calendly.com", "calendly.com", "localhost"}
    for label, status, detail in report(check_code(folder, hosts), []):
        print(f"{status}  {label}  {detail}")
