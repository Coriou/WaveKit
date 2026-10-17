# Receiver endpoints tasks

Status: all tasks implemented and software-tested; the Pi side is merged, the core and bridge sit on feat/pi-ethernet. Nothing is deployed to a Pi. See [requirements](requirements.md), [design](design.md) and [tasks](tasks.md).

- [x] 1 sdr-host: `rankEndpoints`, `receiverId`, `endpoints` on `GET /api/status`, api-types DTO
  - _Requirements: 1.1–1.4_
  - **Property 1: Ranking order**
- [x] 2 Image: avahi service file in `IMAGE_SUPPORT`, avahi presence check, docs
  - _Requirements: 2.1–2.3_
- [x] 3 Checkpoint: Pi-side tests, typecheck, lint (software only; not deployed to a Pi)
- [x] 4 Core: Zod schema for the new status fields, `EndpointSelector`, `SourceManager.retarget`, config flag, source status field
  - _Requirements: 3.1–3.6_
  - **Property 2: No unverified switch**
  - **Property 3: Bounded switching and anchor fallback**
- [x] 5 Bridge `--auto`
  - _Requirements: 4.1_
- [x] 6 Checkpoint: touched tests, contracts, CLI suite, typecheck, lint; announce the source status contract (Main runs the full root suite)
