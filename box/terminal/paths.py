"""Pure, security-bearing helpers for the web console. No web-framework imports,
so they're unit-testable on the host (test_paths.py)."""
from __future__ import annotations

import os
import re

_UNSAFE = re.compile(r"[^A-Za-z0-9_-]+")


def sanitize_session_name(raw: str) -> str:
    """A tmux-safe session name: [A-Za-z0-9_-] only (tmux forbids ':' and '.').
    Falls back to 'main' when nothing usable remains, so it never yields ''."""
    name = _UNSAFE.sub("-", (raw or "").strip()).strip("-")
    return name or "main"


def safe_path(root: str, rel: str) -> str | None:
    """Resolve rel under root, refusing anything that escapes it (path traversal).
    Returns an absolute path, or None if it would escape root or touch .git."""
    if ".git" in os.path.normpath(rel).split(os.sep):
        return None
    root_r = os.path.realpath(root)
    target = os.path.realpath(os.path.join(root_r, rel))
    if target == root_r or target.startswith(root_r + os.sep):
        return target
    return None
