# Receiver endpoints tasks

Status: design. See [requirements](requirements.md), [design](design.md) and [tasks](tasks.md).

- [ ] 1 sdr-host: `rankEndpoints`, `receiverId`, `endpoints` on `GET /api/status`, api-types DTO
  - _Requirements: 1.1–1.4_
  - **Property 1: Ranking order**
- [ ] 2 Image: avahi service file in `IMAGE_SUPPORT`, avahi presence check, docs
  - _Requirements: 2.1–2.3_
- [ ] 3 Checkpoint: Pi-side tests, typecheck, lint; deploy only with the user's go
- [ ] 4 Core: Zod schema for the new status fields, `EndpointSelector`, `SourceManager.retarget`, config flag, source status field
  - _Requirements: 3.1–3.6_
  - **Property 2: No unverified switch**
  - **Property 3: Bounded switching and anchor fallback**
- [ ] 5 Bridge `--auto`
  - _Requirements: 4.1_
- [ ] 6 Checkpoint: touched tests, full root suite, typecheck, lint; announce the source status contract
