"""Runnable self-check for seed consumption: `python3 box/bin/test_seed.py`.

The seed prompt must run on the open that creates the session and NEVER again —
otherwise reopening a Project after the Box restarts re-sends it and the agent
redoes the work.
"""
import json
import os
import tempfile
from importlib.machinery import SourceFileLoader

# The funnel has no .py extension, so load it by path.
session = SourceFileLoader(
    "agentbox_session", os.path.join(os.path.dirname(os.path.abspath(__file__)), "agentbox-session")
).load_module()


def demo():
    with tempfile.TemporaryDirectory() as d:
        meta_path = os.path.join(d, "project.json")
        with open(meta_path, "w", encoding="utf-8") as f:
            json.dump({"name": "Cat Game", "slug": "cat-game", "seedPrompt": "build a cat game"}, f)

        assert session.consume_seed(meta_path) == "build a cat game"
        assert session.consume_seed(meta_path) is None  # second open never reseeds

        meta = json.load(open(meta_path, encoding="utf-8"))
        assert meta == {"name": "Cat Game", "slug": "cat-game"}  # rest of the meta survives
    print("ok")


if __name__ == "__main__":
    demo()
