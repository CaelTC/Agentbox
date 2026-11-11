#!/usr/bin/env python3
"""Generate docs/graph/ — an Obsidian vault of this architecture.

Concept notes come from CONTEXT.md's ubiquitous language, module notes from the
real files and their real imports, so the graph is derived, never hand-drawn.
Re-run it after the architecture moves: python3 scripts/obsidian-graph.py
"""
import json, re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "graph"
SRC = ROOT / "launcher" / "src"

# Concepts a module belongs to, where the name alone does not say it.
CONCEPT_OF = {
    "core/upload": ["Upload"], "main/workspace-upload": ["Upload"],
    "core/export": ["Export"], "main/workspace-export": ["Export"],
    "core/import": ["Project Import"], "main/workspace-import": ["Project Import"],
    "core/delete": ["Delete Project"], "main/workspace-delete": ["Delete Project"],
    "core/github": ["Save to GitHub", "GitHub Account"],
    "main/github": ["GitHub Account"],
    "core/egress": ["Egress Policy"], "core/batteries": ["Batteries"],
    "core/preview": ["Web Preview"], "main/preview": ["Web Preview"],
    "core/refresh": ["Refresh on Launch"], "main/refresh-runner": ["Refresh on Launch"],
    "core/box": ["The Box"], "main/box-exec": ["Box-exec"], "main/box-gate": ["Box Gate"],
    "core/projects": ["Project"], "main/workspace-projects": ["Project", "Workspace"],
    "main/workspace": ["Workspace"], "main/session": ["Harness", "Project"],
    "core/session-window": ["Project"], "main/colima": ["Engine"],
    "main/podman": ["Engine"], "main/engine": ["Engine", "Resource Cap"],
    "core/codex": ["Harness"], "main/codex": ["Harness"],
    "core/config": ["Harness"], "main/settings": ["Harness"],
    "core/startup": ["Engine"], "main/bootstrap": ["Engine"],
}

def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")

def fname(name):
    """Obsidian resolves a wikilink by filename, and a filename holds no slash."""
    return re.sub(r'[\\/:*?"<>|]', "-", name)

def ref(name):
    safe = fname(name)
    return f"[[{safe}|{name}]]" if safe != name else f"[[{name}]]"

SLASHED = re.compile(r"\[\[([^\]|]*[\\/][^\]|]*)\]\]")
def alias(text):
    return SLASHED.sub(lambda m: ref(m.group(1)), text)

def write(name, front, body):
    (OUT / f"{fname(name)}.md").write_text(f"---\n{front}\n---\n\n{body.rstrip()}\n")

# --- concepts, from CONTEXT.md -------------------------------------------
context = (ROOT / "CONTEXT.md").read_text()
entries = re.findall(r"^\*\*(.+?)\*\*:\n(.*?)(?=\n\*\*|\n## |\Z)", context, re.S | re.M)
terms = [t for t, _ in entries]
# longest first so "Box Gate" wins over "The Box"
order = sorted(terms, key=len, reverse=True)

def linkify(text, exclude=()):
    """Wikilink every other concept named in this text, outside code spans."""
    parts = re.split(r"(`[^`]*`)", text)
    for i, part in enumerate(parts):
        if part.startswith("`"):
            continue
        for term in order:
            if term in exclude:
                continue
            part = re.sub(rf"(?<!\[)\b{re.escape(term)}\b(?!\]|\w)", f"[[{term}]]", part)
        parts[i] = part
    return "".join(parts)

for term, body in entries:
    write(term, "tags: [concept]", f"# {term}\n\n{linkify(body.strip(), {term})}")

# --- ADRs ----------------------------------------------------------------
adrs = []
for adr in sorted((ROOT / "docs" / "adr").glob("*.md")):
    text = adr.read_text()
    title = text.splitlines()[0].lstrip("# ").strip()
    num = adr.name[:4]
    name = f"ADR {num} — {title}"
    adrs.append(name)
    status = re.search(r"## Status\n+(.+)", text)
    ctx = re.search(r"## (?:Context|Decision)\n+(.*?)(?=\n## )", text, re.S)
    body = [f"# {name}", "", f"Status: {status.group(1).strip() if status else '?'}", ""]
    if ctx:
        body.append(linkify(" ".join(ctx.group(1).split())[:700]))
    body += ["", f"Full text: `docs/adr/{adr.name}`"]
    write(name, "tags: [adr]", "\n".join(body))

# --- modules, from the real imports --------------------------------------
# The renderer has no imports — its edges are the load order index.html fixes.
ORDER = re.findall(r'script[^>]+src="\./(\w[\w-]*)\.js"', (SRC / "renderer" / "index.html").read_text())

layers = {}
mods = sorted(p for p in SRC.rglob("*.ts") if not p.name.endswith(".d.ts"))
names = {}
for p in mods:
    key = p.relative_to(SRC).with_suffix("").as_posix()
    names[key] = f"src/{key}.ts"

for p in mods:
    key = p.relative_to(SRC).with_suffix("").as_posix()
    text = p.read_text()
    doc = re.match(r"/\*\*(.*?)\*/", text, re.S)
    purpose = ""
    if doc:
        purpose = " ".join(l.strip().lstrip("*").strip() for l in doc.group(1).splitlines()).strip()
    links = []
    for imp in re.findall(r'from "(\.[^"]+)"', text):
        target = (p.parent / imp).resolve().relative_to(SRC).as_posix()
        if target in names:
            links.append(names[target])
    layer = key.split("/")[0] if "/" in key else "shared"
    layers[key] = layer
    test = ROOT / "launcher" / "test" / f"{p.stem}.test.ts"
    body = [f"# `src/{key}.ts`", ""]
    if purpose:
        body += [linkify(purpose), ""]
    body += [f"Layer: [[{layer}]]", ""]
    for c in CONCEPT_OF.get(key, []):
        body.append(f"- implements [[{c}]]")
    for l in dict.fromkeys(links):
        body.append(f"- imports {ref(l)}")
    if p.stem in ORDER and ORDER.index(p.stem):
        body.append(f"- loads after {ref(names['renderer/' + ORDER[ORDER.index(p.stem) - 1]])}")
    if test.exists():
        body.append(f"- tested by `launcher/test/{test.name}`")
    write(names[key], f"tags: [module, {layer}]", "\n".join(body))

# --- layers and the hand-drawn spine -------------------------------------
LAYERS = {
    "core": "Pure, unit-tested logic — no Electron, no side effects. Every rule the "
            "system enforces is decided here and executed by [[main]].",
    "main": "The Electron main process: the trusted, host-side half. It holds the "
            "[[Box Gate]], the only door into the Box ([[Box-exec]]), and the "
            "[[GitHub Account]] token the Box never sees.",
    "renderer": "Classic `<script>`s sharing one global scope, loaded in the order "
                "`index.html` lists. No imports — anything host-side is reached through "
                "`window.agentbox` ([[src/preload.ts]]). Only the machinery region of "
                "`machinery.ts` is testable.",
    "shared": "The IPC contract both halves compile against.",
}
for layer, blurb in LAYERS.items():
    kids = [f"- {ref(n)}" for k, n in sorted(names.items()) if layers.get(k) == layer]
    write(layer, "tags: [layer]", alias(f"# `{layer}`\n\n{blurb}\n\n") + "\n".join(kids))

BOX = {
    "box/Dockerfile": "The image: [[Batteries]] (Node, Python, Rust, git), both "
                      "[[Harness]]es, and the web console. Built by [[Refresh on Launch]].",
    "box/entrypoint.sh": "Boot order inside [[The Box]]: [[Egress Policy]] first, then the "
                         "ChatGPT-login bridge ([[Agent Login]]), then the console, then sleep. "
                         "Also writes the Box-global `AGENTS.md` every agent reads.\n\n"
                         "- runs [[box/egress/apply-egress.sh]]\n- starts [[box/terminal/server.py]]",
    "box/bin/agentbox-session": "**The funnel.** The single source of truth for launching a "
                                "[[Project]]: validate the slug, require `.agentbox/project.json`, "
                                "`tmux new-session -A`, then the [[Harness]] named in that metadata "
                                "with its guardrails off ([[ADR 0001 — The container is the permission boundary]], "
                                "[[ADR 0007 — A second agent, same walls]]).\n\n"
                                "- reached by [[src/main/session.ts]] through [[Box-exec]]\n"
                                "- reached by [[box/terminal/server.py]] on a pty\n"
                                "- seeds a [[Seed Prompt]] on a fresh session only",
    "box/terminal/server.py": "The web console — Starlette on `127.0.0.1:7681`, loopback only. "
                              "Serves the terminal page and the WebSocket that runs "
                              "[[box/bin/agentbox-session]] on a pty, plus a read-only file listing.",
    "box/egress/apply-egress.sh": "The [[Egress Policy]] in iptables: public internet open, all "
                                  "private/link-local ranges blocked, one hole for the [[Database]].",
    "box/egress/verify-egress.sh": "Proves [[Egress Policy]] holds. The [[Install Script]] stops "
                                   "here if it does not.",
}
for name, blurb in BOX.items():
    write(name, "tags: [box]", alias(f"# `{name}`\n\n{blurb}"))

moc = ["# Agentbox — architecture", "",
       "Generated by `scripts/obsidian-graph.py` from `CONTEXT.md`, the ADRs and the real imports.",
       "", "## The two sides", "",
       "- Host (trusted): [[Launcher]] — [[main]], [[renderer]], [[shared]], [[core]]",
       "- " + ref("The Box") + " (the boundary): " + ", ".join(ref(n) for n in BOX),
       "- Between them: exactly one door, [[Box-exec]], serialised by the [[Box Gate]]",
       "", "## Decisions", ""] + [f"- {ref(a)}" for a in adrs] + [
       "", "## Language", ""] + [f"- [[{t}]]" for t in terms]
write("Architecture MOC", "tags: [moc]", "\n".join(moc))

# Colour the graph by what a note IS, so the two sides of the boundary read apart.
conf = OUT / ".obsidian"
conf.mkdir(exist_ok=True)
(conf / "graph.json").write_text(json.dumps({
    "colorGroups": [
        {"query": "tag:#concept", "color": {"a": 1, "rgb": 5431378}},   # blue  — the language
        {"query": "tag:#adr", "color": {"a": 1, "rgb": 14701138}},      # amber — decisions
        {"query": "tag:#box", "color": {"a": 1, "rgb": 14431557}},      # red   — inside the Box
        {"query": "tag:#module", "color": {"a": 1, "rgb": 5419488}},    # green — host code
        {"query": "tag:#layer", "color": {"a": 1, "rgb": 11621088}},
    ],
    "showTags": True, "showAttachments": False, "hideUnresolved": True,
    "scale": 0.6, "repelStrength": 11, "linkStrength": 0.7, "linkDistance": 90,
}, indent=2))
(OUT / "README.md").write_text(
    "# The graph\n\nOpen this folder as an Obsidian vault (Open folder as vault), then "
    "start at [[Architecture MOC]] and press the graph icon.\n\nIt is generated — edit "
    "`CONTEXT.md`, the ADRs or the code, then re-run `python3 scripts/obsidian-graph.py`.\n\n"
    "`How it works.canvas` is hand-drawn and NOT generated — open it to walk someone "
    "through the system in one screen.\n"
)
print(f"{len(list(OUT.glob('*.md')))} notes → {OUT.relative_to(ROOT)}")
