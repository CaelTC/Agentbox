"""Pure, security-bearing helpers for the web console. No web-framework imports,
so they're unit-testable on the host (test_paths.py)."""
from __future__ import annotations

import os
import re

# The Project slug shape. A copy of the Launcher's SLUG_RE (core/projects.ts),
# which Python cannot import; launcher/test/projects.test.ts compares the two
# patterns as text, so the copy cannot quietly go slack. A session is now always
# a Project, so the console REJECTS anything that isn't a real slug rather than
# coercing it — an unknown/crafted name must 404, never spawn a shell.
_SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


def is_valid_slug(slug: str) -> bool:
    """True only for a well-formed Project slug: lowercase a–z / 0–9 / single dashes."""
    return bool(_SLUG_RE.match(slug or ""))


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
