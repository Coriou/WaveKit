# Regional display registry requirements

Status: reviewed design; not implemented or mounted. The complete public assembly must pass independent review before implementation allocation. No test or hardware qualification is implied.

See [requirements](requirements.md), [design](design.md) and [tasks](tasks.md).

## User story 1: As an admitted API reader, I can obtain bounded channel labels with clear data provenance without changing receiver behavior.

1.1 Registry operations shall be pure reads of a validated immutable dataset and return detached immutable projections.

1.2 Each request shall select an explicit region and, where applicable, family; no location inference or cross-region fallback shall produce certified rows.

1.3 Selection provenance and channel-data authority shall be separate fields; coarse configured/guessed/default context shall not establish national applicability.

1.4 Modes, bandwidth and step hints shall be labelled advisory and nullable; no absent hint shall acquire a guessed value or tuning authority.

1.5 Existing scanner/decoder defaults, overrides, ranges, protocol priors, rasters/snapping and jobs shall remain unchanged.

## User story 2: As a reader, I can resolve a label deterministically without confusing aliases or duplex directions.

2.1 IDs shall be stable within a dataset namespace, independent of ordering/display name; versioned publication shall identify changed data.

2.2 Alias lookup shall be scoped to exact region+family and normalized by the documented ASCII rule; distinct matches shall return ambiguity, never first-match success.

2.3 Duplicate normalized aliases on the same row shall be rejected; intentional cross-row collisions shall be explicitly declared in data and returned as ambiguity.

2.4 A row shall distinguish simplex from duplex and express duplex directions by endpoint role, without swapping receive/transmit frequency or guessing direction from numeric ordering.

2.5 No unsupported/unverified family-region pair shall return rows; empty verified datasets shall be distinguishable from unavailable evidence.

## User story 3: As a maintainer, I can audit the origin and bounds of every published row.

3.1 Verified datasets shall carry source organization/document identifier/edition/date/URL/digest/applicability and redistribution rationale; every row shall cite one or more bounded source references.

3.2 Numeric rows and hints shall only enter a verified publication after primary-source applicability and exact transcription/reconciliation review; broad ranges/rasters/vendor lists alone shall not qualify.

3.3 Dataset, response, string, alias and query bounds shall reject overflow; no silent truncation shall masquerade as a complete dataset.

3.4 Provider absence, invalid data or internal failure shall fail closed with safe fixed unavailable errors, never fabricated verified rows.

3.5 Publication hashing, storage bytes, correlated states, collision declarations and version coverage shall follow the exact canonical rules below; invalid registrations shall fail atomically.

## User story 4: As an operator, I retain the same access and lifecycle boundaries.

4.1 All routes shall be normal root-admitted metadata reads in protected mode; no bootstrap exception or unauthenticated regional data surface.

4.2 Legacy default/access configuration shall remain unchanged; only an explicitly mounted provider makes routes available.

4.3 No registry operation shall send receiver commands, acquire streams, mutate persistence/settings or emit scanner/audio control events.

4.4 Public documentation/spec status shall distinguish design, verified data, unmounted modules and mounted delivery; tests shall not imply regulatory/hardware qualification.

4.5 Exact-path method denial and bounded raw framing/query validation shall run after root admission and before content parsing/domain calls, preserving root errors and transport exclusions.
