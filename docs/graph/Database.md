---
tags: [concept]
---

# Database

A PostgreSQL server in its own container (`agentbox-postgres`) beside the Box, started with it on every launch. It lives on an **internal** docker network (`agentbox-db`, pinned subnet 172.30.0.0/24): internal means docker gives it no route out at all, so the Database cannot escape that network, and no port is published, so nothing on the host or LAN can reach it either. [[The Box]] is attached to the network as a second interface, and the [[Egress Policy]] opens exactly one hole — TCP 5432 to the pinned subnet — so a [[Project]] reaches it at `postgresql://postgres:postgres@agentbox-postgres:5432/postgres` and nothing else on the subnet. The fixed password is a non-secret by construction: the socket is unreachable from anywhere but inside the Box, and it guards nothing but this disposable data. Data persists on a named volume, like the [[Workspace]].
_Avoid_: "the postgres container is part of the Box" (it is a sibling with its own walls), localhost:5432 on the Mac (deliberately not published — publishing would require a non-internal network, which would give the Database a route out)
