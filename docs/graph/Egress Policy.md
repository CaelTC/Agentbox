---
tags: [concept]
---

# Egress Policy

[[The Box]]'s network rule — the whole public internet is reachable, but all private/local ranges (RFC-1918, link-local, the host gateway) are blocked. Defends threat B against LAN / on-prem systems. Both Harnesses' vendors sit in the open half — Anthropic's endpoints and, since Codex, OpenAI's — reached by whichever one is running (ADR 0007).
