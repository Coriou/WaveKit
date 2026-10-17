# Specs and design documents

Read this when your task implements or changes a spec. Plain Markdown; no editor or agent
tool is required to read or write any of it.

## Where things live

| Path                              | What                                                                                           | Status                                                                             |
| --------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `docs/specs/<feature>/`           | Spec-driven features: `requirements.md`, `design.md`, `tasks.md`                               | Canonical for new specs                                                            |
| `docs/engineering/<topic>.md`     | Task-local engineering notes: measurements, investigations, design deltas too small for a spec | Canonical                                                                          |
| `docs/superpowers/{specs,plans}/` | Earlier single-file designs and implementation plans                                           | Frozen archive: still referenced from code, tests and config; do not add new files |

Whichever skill or tool helps you write a design, save the result in the paths above.

## Spec index

- [activity-recording-catalog](activity-recording-catalog/requirements.md)
- [band-plans](band-plans/requirements.md)
- [build-devx-overhaul](build-devx-overhaul/requirements.md)
- [core-access-policy](core-access-policy/requirements.md)
- [decode-envelope](decode-envelope/requirements.md)
- [lora-decoder](lora-decoder/requirements.md)
- [operator-data](operator-data/requirements.md)
- [receiver-capabilities](receiver-capabilities/requirements.md)
- [regional-display-registry](regional-display-registry/requirements.md)
- [scanner-followups](scanner-followups/requirements.md): running-job range edits,
  per-range fields, signals only, preempting job, identity search (SF1)
- [viewed-slice-spectrum](viewed-slice-spectrum/requirements.md)
- [web-gaps-1](web-gaps-1/requirements.md): waterfall backfill and averaging, analog
  transmission events, AIS vessel tracker, Activity on by default (WG1)
- [web-gaps-2](web-gaps-2/requirements.md): Activity presentation, APRS and Meshtastic
  trackers, CTCSS/DTMF, AIS checksum, update throttle, call metadata, device labels,
  lockouts skip sweeps, per-job hits (WG2)
- [web-gaps-3](web-gaps-3/requirements.md): fair-share Activity retention and the hole
  contract, RF provenance on receptions, Meshtastic flood copies, coverage per bearing,
  Meshtastic telemetry and neighbours (WG3)
- [web-gaps-4](web-gaps-4/requirements.md): bulk position trails, approximate station
  location, storage report, live-audio AGC, AIS channel, Meshtastic fix time, SDR host
  version, station write layer (WG4)
- [web-gaps-5](web-gaps-5/requirements.md): automatic band map and activity timeline,
  trail altitude and Meshtastic trail positions, AIS types 4/9/21 and the vessel channel,
  verified tuning trust, SDR# and Gqrx band-plan import (WG5)
- [web-gaps-6](web-gaps-6/requirements.md): decoded-elsewhere ranges on scanner plans and
  per-hit duration, decoder option schemas (report only), DCS on analog transmissions,
  band-plan import by URL with update check, redacted config export, sample-rate presets (WG6)
- [web-gaps-7](web-gaps-7/requirements.md): ambient identify for AIS, ACARS, VDL2 and LoRa,
  noise and tone squelch with the noise-tail fix, suggested gain tables, opt-in band-plan skip
  exclusions and decoded-elsewhere refresh, audio stream CORS, bounded decoder options, minors
  (WG7)
- [web-gaps-8](web-gaps-8/requirements.md): decoder settings store and protected decoder PATCH
  applied on restart, read-only recordings inventory with download, spectrum bins above 2 048
  by a measured host cap (WG8)
- [web-gaps-9](web-gaps-9/requirements.md): browser pairing for a web app on another port,
  recording Keep and deletion behind one deletion decision, strict tuning trust and faster
  operator retunes, zoom workload benchmark, minors (WG9)

## The three files

- **`requirements.md`**: user stories and numbered acceptance criteria (`1.1`, `1.2`, ...).
  Numbers are stable identifiers: never renumber. Append new criteria, and mark retired
  ones as superseded in place.
- **`design.md`**: architecture, interfaces, data models and numbered **correctness
  properties**. Each property names the requirements it validates and becomes a property test.
- **`tasks.md`**: an ordered, dependency-sequenced checklist. Each task cites its criteria
  and any properties it implements:

  ```markdown
  - [ ] 4.5 Implement Source Manager
    - TCP client with auto-reconnect and exponential backoff
    - _Requirements: 1.1, 1.2_
    - **Property 3: Reconnect Backoff Bound**
  ```

A spec may reference another file with `#[[file:<path>]]`: read the referenced file too.
Cross-spec links are relative (`../decode-envelope/design.md`), so moving whole spec
directories together keeps them valid.

## Working a task list

1. Read `tasks.md` first: checked items are done.
2. Work tasks in order and check each one off (`- [x]`) when complete.
3. Stop at checkpoint tasks: verify tests pass and report before continuing.
4. Keep the spec honest about state: say what is reviewed design versus implemented, and
   which foundations exist unmounted versus wired into the running app. Keep stated
   dependency gates until they are actually met.
5. Reference requirement numbers in commit messages and in test comments.

Property tests use `fast-check` with at least `numRuns: 100` and carry the trace comment:

```ts
// Feature: <feature>, Property N: <name>
// Validates: Requirements X.Y, X.Z
```

Lane status, review IDs, ownership matrices and handoffs are private working notes and
stay in the ignored `.agents/` directory, never in a spec.
