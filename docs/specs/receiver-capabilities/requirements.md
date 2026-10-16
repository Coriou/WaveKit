# Receiver capabilities requirements

Status: read-only foundations and route composition implemented and software-validated in protected and legacy modes. Current numerical regional data and physical receiver support/readback remain unavailable or unknown. No browser, regulatory or hardware qualification is implied.

See [requirements](requirements.md), [design](design.md) and [tasks](tasks.md).

## User story 1: an admitted API reader can discover what the core actually knows about a receiver without assuming successful control or hardware identity.

1.1 Each response has schemaVersion 1, exact source incarnation/session identity and snapshot provenance.

1.2 Command availability, transport applicability and physical support are separate closed dimensions for every fixed control.

1.3 Peer tunerType/gainCount are current-session advertised integers only; no model/table/range/bias-T inference.
_Amended by [web-gaps-6 8.1–8.2](../web-gaps-6/requirements.md): a fixed list of suggested RTL-SDR sample rates may accompany rtl_tcp items; it is a suggestion inside the validated command ranges and claims nothing about the device._
_Amended by [web-gaps-7 5.1–5.6](../web-gaps-7/requirements.md): a cited librtlsdr gain table may accompany an rtl_tcp item when the advertised tunerType is listed and the advertised gainCount equals the table's length; it is a suggestion matched on two advertised integers and claims nothing about the device. Tuning ranges stay uninferred._

1.4 Gain value uses tenthsDb; gainIndex is dimensionless and never converted through gainCount.

1.5 Configured declarations, local write/relay observations, peer advertisement and physical readback remain distinct evidence classes. First slice physical readback is always unknown.

1.6 No read invokes command writes, connect/reconnect, replay, probing, file/network reads or acquisition.

## User story 2: evidence cannot silently survive receiver replacement.

2.1 New registration and each connection attempt have distinct opaque identities; same source ID never implies same receiver/session.

2.2 Snapshot is one synchronous detached capture, with no await/callback between membership validation and field copies.

2.3 Disconnected/connecting/removed/old socket evidence cannot be current peer knowledge; reconnect starts missing header state.

2.4 Partial header, invalid magic, nonapplicable transport/format and valid header are distinguishable.

2.5 Payload waiting/paused/stale/streaming/ended state is independent of evidence validity; no age timeout upgrades/downgrades physical support.

2.6 Late old callbacks cannot mutate current session evidence or successor watchdog/retry/caps/activity; no provider history cache revives claims.

2.7 The bounded 128-bit allocator guarantees lifetime nonreuse until exhaustion; evidence failure never aborts operational source actions, and recovery/error results follow the exact closed reader contract.

## User story 3: clients receive bounded truthful results through normal admission.

3.1 Only the two read routes below exist; no bootstrap exception, write or WebSocket bus.

3.2 Closed validated DTOs with bounded strings/arrays/serialization; deterministic pagination/order and no silent truncation.

3.3 Unknown source, absent/failed/conflicting provider and malformed input have fixed distinct outcomes; no successful known fallback.

3.4 SDR++ IQ/audio, RTL non-header variants and recordings describe inapplicable transport without asserting hardware unsupported.

3.5 Provider construction/disposal adds no source subscriptions/timers, consumers or retained per-session history.

3.6 Existing source/tuner/relay/scanner behavior and DTOs remain unchanged except explicitly reviewed callback ownership race fixes; public additions require integration patches.

3.7 Page selection uses at most 17 references, validates lookahead, and never silently omits unrepresentable sources; one UTF8<=256/decodedUTF16<=100 representability policy governs source/list/cursor/DTO so every listed ID roundtrips through the existing single-source router.

3.8 Feature input/serialization and root admission/framework errors have distinct explicit precedence; rejected requests perform zero evidence reads.
