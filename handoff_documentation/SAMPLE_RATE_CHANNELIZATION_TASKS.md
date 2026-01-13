# WaveKit Sample Rate & Channelization Features - Task Tracker

## Overview

This document tracks the implementation of dynamic sample rate handling and channelization features.

---

## Priority Order

1. **Dynamic Sample Rate Handling** (4 days) — Prerequisite for other features
2. **Wideband Client-Side Channelizer** (15 days) — For high-bandwidth local setups
3. **Server-Side Channelizer in sdr-host** (23 days) — For bandwidth-constrained remote setups

---

## Feature 1: Dynamic Sample Rate Handling

**Status:** ⬜ Not Started  
**Document:** [DYNAMIC_SAMPLE_RATE_HANDOFF.md](./DYNAMIC_SAMPLE_RATE_HANDOFF.md)

### Tasks

- [ ] **Step 1:** TunerRelay event emission
  - [ ] Add `sample-rate-changed` to `TunerRelayEvents`
  - [ ] Emit event in `updateCommandState()` for cmd 0x02
- [ ] **Step 2:** SourceManager caps update
  - [ ] Add `caps-changed` to `SourceManagerEvents`
  - [ ] Implement `updateSourceCaps()` method
- [ ] **Step 3:** Wire events in main entry point
  - [ ] Connect TunerRelay → SourceManager event
  - [ ] Add WebSocket broadcast for `source:caps-changed`
- [ ] **Step 4:** LiveDemodulator listener
  - [ ] Subscribe to `caps-changed` event
  - [ ] Restart pipeline on sample rate change
- [ ] **Step 5:** DecoderManager integration
  - [ ] Subscribe to `caps-changed` event
  - [ ] Restart affected decoders
  - [ ] Add health warnings for suboptimal rates
- [ ] **Step 6:** Testing
  - [ ] Unit tests for event propagation
  - [ ] Integration test with SDR++
- [ ] **Step 7:** Documentation
  - [ ] Update ARCHITECTURE.md
  - [ ] Update README.md

---

## Feature 2: Wideband Client-Side Channelizer

**Status:** ⬜ Not Started (Blocked on Feature 1)  
**Document:** [WIDEBAND_CHANNELIZER_HANDOFF.md](./WIDEBAND_CHANNELIZER_HANDOFF.md)

### Prerequisites

- [x] Dynamic sample rate handling documented
- [ ] Dynamic sample rate handling implemented
- [ ] Multi-source support verified

### Tasks

- [ ] Phase 1: Research & Prototyping (2 days)
- [ ] Phase 2: Channelizer Core (5 days)
- [ ] Phase 3: Virtual Source Integration (3 days)
- [ ] Phase 4: Configuration & API (1 day)
- [ ] Phase 5: Testing & Documentation (3 days)

---

## Feature 3: Server-Side Channelizer (sdr-host)

**Status:** ⬜ Not Started (Blocked on sdr-host implementation)  
**Document:** [SERVER_SIDE_CHANNELIZER_HANDOFF.md](./SERVER_SIDE_CHANNELIZER_HANDOFF.md)

### Prerequisites

- [ ] sdr-host package implemented
- [ ] Dynamic sample rate handling implemented
- [ ] csdr added to sdr-host Docker image

### Tasks

- [ ] Research & prototyping on Pi (3 days)
- [ ] CPU monitoring infrastructure (2 days)
- [ ] Channel pipeline implementation (5 days)
- [ ] Stream server (TCP) (2 days)
- [ ] sdr-host API integration (3 days)
- [ ] WaveKit source type integration (3 days)
- [ ] Testing on various Pi models (3 days)
- [ ] Documentation (2 days)

---

## Decision Matrix

| Scenario                         | Recommended Approach                    |
| -------------------------------- | --------------------------------------- |
| Local SDR, high CPU available    | Wideband Client-Side Channelizer        |
| Remote SDR over Gigabit Ethernet | Wideband Client-Side Channelizer        |
| Remote SDR over WiFi             | Server-Side Channelizer OR Multi-dongle |
| Limited budget, simple needs     | Multi-dongle approach                   |
| Raspberry Pi SDR host            | Server-Side Channelizer                 |

---

## Related Documents

- [TUNER_INTERFACE_HANDOFF.md](./TUNER_INTERFACE_HANDOFF.md) — Tuner control API
- [ARCHITECTURE.md](../docs/ARCHITECTURE.md) — System architecture
