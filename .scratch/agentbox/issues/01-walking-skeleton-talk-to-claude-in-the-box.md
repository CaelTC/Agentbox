# 01 — Walking skeleton: talk to Claude inside the Box

**What to build:** A person can start Agentbox from a minimal shell script, authenticate with **Login with Claude**, type a prompt, and get a reply from Claude Code running inside the Box. Their work persists across restarts. This is the tracer bullet that proves the whole spine — Engine, the Box, auth, persistence — end to end.

**Blocked by:** None — can start immediately.

**Status:** done

- [ ] A Dockerfile builds the Box from a base image with Claude Code installed.
- [ ] A shell script starts Colima with the Resource Cap (~4 CPU / 6 GB RAM / 25 GB disk) and drops the user into a Claude Code session in the Box.
- [ ] Claude Code runs with permissions bypassed (no per-action prompts).
- [ ] The Box mounts no host filesystem; the Workspace lives on a named volume and survives a stop/start.
- [ ] The user authenticates via Login with Claude (their own subscription seat), sends a prompt, and receives a reply.

_Note: not safe for real Sandbox Users until Egress hardening (#02) lands — until then the Box still has open access to private/local ranges._
