# Design It Twice

When the user wants to explore alternative interfaces for a chosen deepening candidate, design it several times over before picking. Based on "Design It Twice" (Ousterhout) — your first idea is unlikely to be the best.

Uses the vocabulary in [SKILL.md](SKILL.md) — **module**, **interface**, **seam**, **adapter**, **leverage**.

## Process

### 1. Frame the problem space

Before designing anything, write a user-facing explanation of the problem space for the chosen candidate:

- The constraints any new interface would need to satisfy
- The dependencies it would rely on, and which category they fall into (see [DEEPENING.md](DEEPENING.md))
- A rough illustrative code sketch to ground the constraints — not a proposal, just a way to make the constraints concrete

Show this to the user, then proceed to Step 2 — they read and think while you design.

### 2. Produce 3+ radically different designs

Design the interface **one design at a time, finishing each before starting the next**, and give each one a different governing constraint:

- Design 1: "Minimize the interface — aim for 1–3 entry points max. Maximise leverage per entry point."
- Design 2: "Maximise flexibility — support many use cases and extension."
- Design 3: "Optimise for the most common caller — make the default case trivial."
- Design 4 (if applicable): "Design around ports & adapters for cross-seam dependencies."

The hard part is that one session cannot un-see its first idea, so a later design tends to come out as a mild variation of an earlier one. Fight that deliberately: before starting each new design, restate its constraint, and if the result shares the previous design's shape — same entry points, same decomposition — throw it away and redo it. Designs that only differ in naming are wasted work.

Ground every design in both the [SKILL.md](SKILL.md) vocabulary and the project's domain language from `CONTEXT.md`, so all of them name things consistently.

Each design states:

1. Interface (types, methods, params — plus invariants, ordering, error modes)
2. Usage example showing how callers use it
3. What the implementation hides behind the seam
4. Dependency strategy and adapters (see [DEEPENING.md](DEEPENING.md))
5. Trade-offs — where leverage is high, where it's thin

### 3. Present and compare

Present designs sequentially so the user can absorb each one, then compare them in prose. Contrast by **depth** (leverage at the interface), **locality** (where change concentrates), and **seam placement**.

After comparing, give your own recommendation: which design you think is strongest and why. If elements from different designs would combine well, propose a hybrid. Be opinionated — the user wants a strong read, not a menu.
