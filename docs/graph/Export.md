---
tags: [concept]
---

# Export

A one-way, user-initiated copy of [[Project]] documents out of the Box onto the [[Sandbox User]]'s computer, performed by the trusted [[Launcher]]. The mirror of [[Upload]]. The [[Sandbox User]] picks the files, from a list the [[Launcher]] itself builds — the Box never names what crosses or where it lands. Only document-shaped files are offered, and the total is bounded, because an unbounded copy onto the host would be threat A. Carries threat C: what lands is document-shaped, not inert — a web file the Box wrote still runs script when it is opened. So every exported file is marked untrusted as it lands, in the host's own terms — `Zone.Identifier` on Windows, `com.apple.quarantine` on macOS — which is what makes Protected View, SmartScreen and Gatekeeper apply to it. The allowlist and the mark together reduce C to the risk class of an email attachment; they do not remove it, and it is the [[Sandbox User]], not the Box, who decides whether to open what landed.
_Avoid_: download (nothing is fetched over a network), sync (it is not continuous and never deletes), bare save (collides with saving a file inside Claude Code — the button is "Save to my computer", which still says where it goes)
