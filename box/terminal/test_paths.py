"""Runnable self-check for the security-bearing helpers: `python3 test_paths.py`."""
from paths import safe_path, sanitize_session_name


def demo():
    assert sanitize_session_name("my proj!") == "my-proj"
    assert sanitize_session_name("a.b:c") == "a-b-c"
    assert sanitize_session_name("   ") == "main"
    assert sanitize_session_name("../../etc") == "etc"

    root = "/workspace"
    assert safe_path(root, "") == "/workspace"
    assert safe_path(root, "proj/file.txt") == "/workspace/proj/file.txt"
    assert safe_path(root, "../etc/passwd") is None
    assert safe_path(root, "proj/../../etc") is None
    assert safe_path(root, ".git/config") is None
    print("ok")


if __name__ == "__main__":
    demo()
