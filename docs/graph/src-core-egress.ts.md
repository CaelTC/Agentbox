---
tags: [module, core]
---

# `src/core/egress.ts`

The [[Egress Policy]] (CONTEXT.md / ADR 0001, threat B): the whole public internet is reachable, but every private/local range is blocked.  This module generates the ordered firewall rule-set as pure data so the policy can be asserted in tests. `box/egress/apply-egress.sh` renders these same rules with the real `iptables` binary inside the Box — it must, since the Box's start-up cannot import TypeScript. The two are held together by the drift test in `test/egress.test.ts`, which compares that script's rules against these ones IN ORDER (order is the policy, see below).

Layer: [[core]]

- implements [[Egress Policy]]
- imports [[src-core-config.ts|src/core/config.ts]]
- tested by `launcher/test/egress.test.ts`
