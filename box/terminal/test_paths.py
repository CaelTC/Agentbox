"""Runnable self-check for the security-bearing helpers: `python3 test_paths.py`."""
from paths import is_valid_slug, safe_path


def demo():
    assert is_valid_slug("my-project")
    assert is_valid_slug("game2")
    assert not is_valid_slug("")
    assert not is_valid_slug("../etc")   # traversal can never be a slug
    assert not is_valid_slug("My Proj")  # uppercase / spaces rejected, not coerced
    assert not is_valid_slug("-leading")
    assert not is_valid_slug("a--b")     # double dash isn't the sanitizer's output

    root = "/workspace"
    assert safe_path(root, "") == "/workspace"
    assert safe_path(root, "proj/file.txt") == "/workspace/proj/file.txt"
    assert safe_path(root, "../etc/passwd") is None
    assert safe_path(root, "proj/../../etc") is None
    assert safe_path(root, ".git/config") is None
    print("ok")


if __name__ == "__main__":
    demo()
