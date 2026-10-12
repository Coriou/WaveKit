# Decode envelope — requirements

Owner decision amendment — 2026-10-12: align categories with the eight brand IDs,
add nullable entityKey and optional position; the foundation remains unmounted.

Status: reviewed and implemented as an unmounted foundation for Roadmap §4a
and the spectrum → tune → identify → inspect milestone. Existing decoder output,
REST, WebSocket, CLI and scanner behavior are unchanged. Runtime publishing,
shared DTO promotion and persistent storage remain deferred.

## 1. Identity and compatibility

1.1 Provide a version-1 envelope for an individual decoder output event. Preserve
its output type, including sync, stats, errors and call lifecycle output. An
envelope is not proof of a successfully decoded or scanner-confirmed reception.
1.2 Require a caller-supplied immutable event ID. Preserve it exactly across
construction, serialization and validation. Do not allocate IDs, deduplicate,
hash the payload or derive identity from frequency, title or mutable metadata.
1.3 The future ingress owner allocates the ID once and shares that envelope with
all consumers. Separate receptions may have identical payloads and different IDs;
reprocessing the same reception must retain its assigned ID.
1.4 Keep domain identifiers such as call, discovery and observation IDs as
references. Do not use them as the envelope's event ID or change their ownership.
1.5 Preserve all existing runtime contracts. The foundation must have no runtime
mounts, shared package exports, subscriptions, timers, disk or network operations.

## 2. Clocks

2.1 Normalize the DecoderOutput timestamp into producedAt: the time the producer
emitted the parsed output. It is not necessarily the time the radio frame aired.
2.2 Require a separate caller-supplied receivedAt for envelope ingestion. Do not
substitute an implicit current clock or infer reception time from payload fields.
2.3 Emit canonical UTC ISO timestamps, validate calendar values, and reject invalid
Date values. Keep reported timestamps inside decodedData. Do not require either
clock to precede the other: pre-roll, replay and clock adjustment can differ.

## 3. Truthful provenance

3.1 Default sourceId and RF frequency to null. Accept provenance only from the
caller that owns the event-time input binding; do not inspect current tuner state,
configuration, decoder names or decodedData to invent it.
3.2 A supplied RF frequency must have an explicit channel/probe basis and tuning
trust. It describes the event-time bound channel or probe, not an automatic
measurement of the emission centre. Unverified tuning remains visibly unverified.
3.3 Keep source, job, probe and channel IDs independent and optional where absent;
a known source may have unknown frequency, and a known external channel may lack
a core source ID. Do not infer a core source from a protocol radio/talker ID.
3.4 Defer stream, epoch, sample ranges and channel generations until adapters can
provide qualified references. Never expose an unqualified epoch as global identity.
3.5 In particular, do not promote ACARS's synthetic frequency fallback, VDL2's zero
sentinel, protocol carrier constants or a configured frequency list into RF truth.

## 4. Inspectable presentation

4.1 Expose protocol, category, nullable title and typed scalar fields independently
from decodedData. Unknown defaults are protocol null, category other, title null
and an empty fields list. Do not guess protocol from a decoder instance ID.
4.2 Accept caller-supplied presentation only after structural validation. The
adapter supplying it must have evidence from a known output type, validated
payload or owner context. Do not reproduce scanner confirmation logic or import
CLI presentation modules into core.
4.3 Preserve typed finite numbers, booleans, strings and null in fields; require
unique field keys and bounded labels and units. Do not fabricate unit conversion,
coordinates, frequency or a successfully identified protocol in the generic path.
4.4 The category vocabulary matches packages/brand/icons/categories.json: aircraft,
marine, aviation-data, voice, paging, aprs, sensors and mesh, plus other fallback.
It does not replace scanner protocol families or confidence. This supersedes the
original CLI category vocabulary by owner decision on 2026-10-12.
4.5 Expose nullable entityKey as a bounded kind:value correlation key supplied by
an evidence-owning adapter (e.g. icao:ABC123, mmsi:123456789, callsign:F1ABC,
node:123, capcode:456, talkgroup-radio:7+42). It is not event identity or proof of
scanner acceptance. Default null; never infer it from arbitrary decodedData.
4.6 Accept optional position {lat, lon, altM?} from validated caller presentation.
Latitude and longitude are finite degrees in [-90, 90] and [-180, 180]; altitude
is finite metres. Omit unknown position; never fabricate it from RF context.

## 5. Complete bounded decoded data

5.1 Provide a complete, detached JSON projection of DecoderOutput.data. This is the
existing decoded payload, not a claim to retain original protocol wire JSON,
stdout lines, RF samples or discarded parser fields. Preserve unknown JSON keys.
5.2 Normalize valid Date values to ISO strings without invoking user serializers.
Omit undefined object members; project undefined array members and holes to null.
Apply ordinary JSON numeric normalization for negative zero. Reject a root
undefined value rather than inventing a payload.
5.3 Reject nonfinite numbers, invalid dates, cycles, functions, symbols, bigint,
unsupported object instances, custom serializers and accessor properties without
invoking their value getters or serialization methods. Bound traversal before
recursive descent and contain reflective exceptions. This Node foundation may
reject proxies through the standard Node intrinsic before reflection; it does
not claim a portable general-JavaScript proxy defense.
5.4 Enforce the design's depth, node, container, UTF-8 string and total encoded-byte
limits, including physical own-key inspection before descriptor traversal. Reject
the entire envelope when decoded data cannot fit; never silently
truncate the payload and describe the result as complete.
5.5 Clone the data and metadata without mutation, retention of input references or
prototype pollution. Treat property names as data, including `__proto__` and
constructor; these must not change output prototypes.

## 6. Validation, errors and scope

6.1 Validate a strict versioned boundary with Zod after safe descriptor/projection
checks. Reject unknown versions, unknown envelope metadata keys, invalid IDs,
invalid timestamps and malformed provenance or presentation.
6.2 Every invalid construction/validation failure uses WaveKitError with a stable
DECODE_ENVELOPE_INVALID code and fixed message. Do not expose payload values,
property names, IDs, reflected exception messages, causes or validation paths.
6.3 Build only new internal types, projection, envelope helpers and targeted tests
once the design is approved. Public DTO publication requires a separate shared
contract checkpoint. No durable store, search, cursor replay, recording catalog,
accounts or scanner recovery/confirmation implementation belongs in this batch.
6.4 Tests cover representative existing output shapes and meaningful hostile cases.
Property tests map to design properties and run at least 100 iterations. Review
owned paths and run targeted tests, typecheck and lint before an implementation
checkpoint; there are no runtime acceptance claims from foundation tests.
