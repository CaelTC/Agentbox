# 07 — Web Preview

**What to build:** When a Sandbox User has Claude build a webpage or app that serves on a port, they can click Preview in the Launcher and see it in a browser tab on their Mac. This is the laptop reaching into the Box — it does not weaken threat A or B (see ADR 0001).

**Blocked by:** 05 — Project management home screen.

**Status:** done

- [ ] The Launcher can forward a port from the Box to the MacBook and open it in a browser tab.
- [ ] After Claude starts a dev server / serves a page in the Box, clicking Preview shows it in the browser.
- [ ] Port forwarding is scoped to the Box→browser direction and does not expose the laptop filesystem or LAN to the Box.
