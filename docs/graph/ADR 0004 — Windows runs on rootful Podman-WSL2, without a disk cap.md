---
tags: [adr]
---

# ADR 0004 — Windows runs on rootful Podman/WSL2, without a disk cap

Status: accepted

[[Agentbox]] was built for MacBooks: Colima gives it a headless, licence-free container runtime and a **[[Resource Cap]]** — `colima start --cpu 4 --memory 6 --disk 25` — that bounds the Box at a known ceiling on the host. ADR 0001 leans on that cap for threat A: the Box can damage the laptop neither by reaching its files (no host mounts) nor by filling its disk (the cap). Colleagues on Windows need the same sandbox. Colima has no Windows build, so the [[Engine]] there is **Podman machine**, which runs the Box in a Linux VM the same way Colima does. Podman machine on Windows has two providers, and neither reproduces what Colima gives us for free: - **WSL** (the default, and the only one on Windows Home)

Full text: `docs/adr/0004-windows-runs-on-rootful-podman-wsl2-without-a-disk-cap.md`
