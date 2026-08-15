"""Runnable self-check for seed consumption and agent selection:
`python3 box/bin/test_seed.py`.

The seed prompt must run on the open that creates the session and NEVER again —
otherwise reopening a Project after the Box restarts re-sends it and the agent
redoes the work.

The "agent" key in project.json picks which agent the session runs; absent means
Claude Code (existing Projects have no key), and an unrecognised value must fail
loudly instead of silently launching the wrong agent.
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


def demo_agent():
    with tempfile.TemporaryDirectory() as d:
        meta_path = os.path.join(d, "project.json")

        def write(meta):
            with open(meta_path, "w", encoding="utf-8") as f:
                json.dump(meta, f)

        write({"slug": "cat-game"})  # no "agent" key: existing Projects stay on Claude
        assert session.agent_command(meta_path) == ["claude", "--dangerously-skip-permissions"]

        write({"slug": "cat-game", "agent": "codex"})
        assert session.agent_command(meta_path) == ["codex", "--dangerously-bypass-approvals-and-sandbox"]

        write({"slug": "cat-game", "agent": "cursor"})
        try:
            session.agent_command(meta_path)
        except SystemExit:
            pass
        else:
            raise AssertionError("an unknown agent must fail, not silently run something")
    print("ok")


if __name__ == "__main__":
    demo()
    demo_agent()
