# Decode envelope — design

Status: reviewed; the authorized unmounted foundation is implemented and its
validation checkpoint is complete. Runtime publishing, shared DTO promotion and
persistent storage remain deferred. This decoder-event envelope is useful for
inspect. A decoder event may be sync, stats, an error, a call update or a parsed
message; the name does not claim accepted scanner evidence.

## Existing contracts

- `src/decoders/types.ts`: DecoderOutput has a Date timestamp, decoder, type and
  unknown data. All current builtins set output.decoder to this.id, matching the
  manager's outer decoder.id argument; this is an instance ID, not decoderType.
  The timestamp is generally parser-emission time. Payloads may
  contain their own reported Date/time values.
- `src/decoders/manager.ts` forwards decoder:output with the instance ID;
  `src/api/websocket/events.ts` broadcasts {decoderId, output}. No event ID or
  capture-time RF context is present. Leave this contract unchanged.
- CLI `FormattedMessage` is presentation-only: protocol/category, formatted
  segments, string fields and bounded search text. It is not a canonical envelope;
  do not import, re-export or port the formatter registry into this foundation.
- Scanner Task 25's committed DTO contract lives in its own worktree. Discovery
  and Observation own their identifiers; DecodeEvidence owns accepted confirmation
  and qualified epoch semantics. scanner:identify is changing target state,
  currently without sourceId, timestamp, event ID or revision. Link records later;
  neither observations nor identify progress become immutable Activity identities.
- parseAcarsdecJson defaults missing frequency to 131.55 MHz. Several parsers
  normalize or discard original wire fields. The envelope cannot establish RF
  provenance from those payloads or promise original-wire inspection.

## Version-1 shape

The following internal DTO is the proposed public serialization shape. Optional
members are omitted when absent; the two unknown RF facts are explicitly null.

```ts
export type JsonScalar = string | number | boolean | null
export type JsonValue =
	| JsonScalar
	| readonly JsonValue[]
	| { readonly [key: string]: JsonValue }

export interface DecodeField {
	key: string
	label: string
	value: JsonScalar
	unit?: string
}

export interface DecodeProvenance {
	sourceId: string | null
	frequency: {
		hz: number
		basis: "channel" | "probe"
		tuningTrust: "commanded" | "relay" | "unverified"
	} | null
	jobId?: string
	probeId?: string
	channelId?: string
}

export interface DecodeReferences {
	callId?: string
	discoveryId?: string
	observationId?: string
}

export interface DecodeEnvelope {
	version: 1
	eventId: string
	producedAt: string
	receivedAt: string
	decoderId: string
	decoderType?: string
	outputType: string
	protocol: string | null
	category: "aircraft" | "voice" | "pager" | "data" | "other"
	title: string | null
	fields: readonly DecodeField[]
	provenance: DecodeProvenance
	refs?: DecodeReferences
	decodedData: JsonValue
}
```

An event ID is opaque to the helper. It is bounded and validated, never allocated
or recomputed here. The future ingress publisher owns uniqueness and allocates it
once before fan-out. A future store cannot replace it with a sequence/cursor or
rekey it when presentation changes. A lifecycle output gets its own event ID and
may reference the same native callId as another event. Native callId remains a
producer correlation reference, without a new global/restart uniqueness promise.

## Small API and file ownership

Proposed new source paths:

- `src/core/activity/types.ts`: internal DTO and construction-context types.
- `src/core/activity/projection.ts`: detached bounded JSON projection.
- `src/core/activity/envelope.ts`: safe construction and strict Zod validation.

Proposed new tests:

- `tests/unit/core/activity/projection.test.ts`
- `tests/unit/core/activity/envelope.test.ts`

No existing tracked source or shared export file needs to change. Promotion to
`packages/api-types/src/activity.ts` and its public exports is a later explicit
CLI/web/scanner contract checkpoint; do not create duplicate DTO declarations now.

Proposed APIs:

```ts
projectDecodedData(input: unknown): JsonValue
createDecodeEnvelope(
	output: DecoderOutput,
	context: DecodeEnvelopeContext,
	presentation?: DecodePresentation,
): DecodeEnvelope
validateDecodeEnvelope(input: unknown): DecodeEnvelope
```

Context requires eventId, receivedAt (Date) and authoritative decoderId. Its ID
must equal output.decoder; conflicting producer attribution is invalid. It may
supply decoderType, provenance and refs. Omitted provenance creates
{sourceId: null, frequency: null}. Presentation may supply protocol/category/title
and fields; omission uses the unknown defaults. It must be grounded by its caller,
but this generic helper does not perform protocol confirmation or semantic RF
classification. The validator returns a detached canonical envelope, accepts
canonical wire JSON only, and does not accept Date instances or undefined values
in a wire envelope, even when nested.

All inputs, including output/context/presentation metadata, pass descriptor safety
checks before Zod or code can read potentially hostile properties. Functions do
not read config, fetch status, query a tuner, generate IDs or use an implicit clock.
They throw a fixed WaveKitError message (`Invalid decoder event envelope`) with
code DECODE_ENVELOPE_INVALID. Strip reflective/Zod errors rather than retaining
causes or attaching supplied values. There is no logging in these helpers.

## Provenance and time

producedAt is the top-level output timestamp, converted with Date intrinsics;
receivedAt is supplied by the ingress owner. They are independent observations,
not an ordering guarantee. An embedded packet timestamp stays in decodedData;
pre-roll does not turn parser time into sample time.

The owner captures provenance with the input binding when the output is produced,
not by looking up current status later. sourceId may be known while frequency is
null; an external input may have frequency while sourceId is null. frequency.hz
is a finite positive bound channel/probe frequency, not a spectral measured
centre, carrier assumption or configured list. Its tuningTrust is mandatory.
Source centre plus an unqualified offset is insufficient. Do not accept global
stream/epoch/generation fields in v1; a later adapter must specify source+stream+
epoch or an equivalently qualified sample reference before adding them.

refs links existing domain IDs. Identifier prefixes do not imply scanner acceptance.
Do not reinterpret candidate/artefact/unsupported identify states as accepted
decodes. scanner:identify progress remains scanner-owned; a later terminal-result
adapter needs explicit event ownership and stable target/revision semantics.

## Projection and exact bounds

These are contract limits, not tuning options in this batch. UTF-8 means the byte
length of the actual UTF-8 encoding, not JavaScript UTF-16 string length.

| Item                                                                 | Limit / rule                                                             |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Complete compact JSON envelope                                       | 131072 UTF-8 bytes, inclusive                                            |
| decodedData depth                                                    | 16; root has depth 0; every child adds 1                                 |
| decodedData visited value positions                                  | 4096, inclusive; root counts 1                                           |
| Each payload object / array                                          | 256 physical own keys / array positions; array length key excluded       |
| Payload string values                                                | 32768 UTF-8 bytes each                                                   |
| Payload property names                                               | 256 UTF-8 bytes each; may be empty                                       |
| eventId, decoderId, decoderType, reference/provenance IDs, field key | 1–128 UTF-8 bytes                                                        |
| outputType and protocol (when non-null)                              | 1–64 UTF-8 bytes                                                         |
| Title (when non-null)                                                | 1–256 UTF-8 bytes                                                        |
| Fields                                                               | At most 64; exact unique field keys                                      |
| Field labels                                                         | 1–128 UTF-8 bytes                                                        |
| Field string values                                                  | At most 32768 UTF-8 bytes; may be empty                                  |
| Units                                                                | 1–32 UTF-8 bytes when present                                            |
| Metadata text                                                        | No C0/C1 controls; payload strings remain intact                         |
| Field and payload numbers                                            | Finite; negative zero projects to zero                                   |
| RF frequency                                                         | Finite, greater than zero, at most Number.MAX_SAFE_INTEGER Hz            |
| Timestamps                                                           | Canonical UTC YYYY-MM-DDTHH:mm:ss.sssZ, valid calendar, round-trip equal |

IDs are opaque bounded strings; no UUID/ULID allocation or domain prefix registry
is required. Reject empty IDs and controls, but preserve valid IDs exactly.
Wire schemas are strict at envelope/provenance/frequency/refs/presentation-field
metadata boundaries; decodedData preserves arbitrary safe JSON property names.

Projection accepts primitives, ordinary/null-prototype records, arrays and valid
plain Date instances only. Valid Dates use intrinsic getTime/toISOString and
never the object's methods or toJSON. Reject custom Date subclasses and every
extra Date own property rather than silently dropping attached data. Object
undefined values are omitted; undefined array
positions and holes become null. The raw root cannot be undefined. Primitive
number -0 becomes 0, as in JSON. Repeated shared subobjects are cloned in each
position; ancestor cycles are invalid. Count omitted undefined members and null
array holes as visited positions so sparse/undefined input cannot evade limits.

Inspect own descriptors rather than reading property values. Count physical own
keys before inspecting descriptors: objects permit at most 256 own keys, arrays
at most 256 positions plus the intrinsic length key. This includes nonenumerable
keys and symbols; do not allocate a complete descriptor map before checking width.
Reject own accessor
properties without invoking getters, including nonenumerable accessors. Reject
custom serializers without invoking them. Node's standard util.types.isProxy
may reject direct/nested proxies before reflection; this is a Node implementation
boundary, not a portable browser guarantee. Reflective exceptions still become the
same generic failure. Reject symbols, functions, bigint and nonplain instances;
nonenumerable ordinary data properties are outside the JSON projection. Reject
extra enumerable non-index array properties rather than silently losing them.

Check width/depth/node/string budgets before recursively descending. Build detached
records using safe own data properties so `__proto__`, constructor and prototype
remain inert data keys. Do not call JSON.stringify on original input, execute its
getters or rely on its serializer. Final compact JSON byte accounting runs only on
the detached safe envelope and includes escaping, keys and all metadata.
The projector also enforces a 131072-byte compact-JSON limit incrementally on the
projected decodedData, so a large tree of individually allowed strings cannot
allocate an oversized result before the final envelope check.

The identical payload depth/node/width/string budgets start at decodedData root
(depth 0) in both construction and wire validation. Metadata safety/validation is
separate: projecting the entire envelope through the same depth budget would
incorrectly spend one level on its wrapper. The wire validator rejects Date
instances anywhere, including nested decodedData, while the constructor projects
valid Dates. For every constructed envelope within limits, validating its JSON
round-trip must accept identical payload depth/node boundaries and preserve it. Reject an
over-limit result as a whole; no clipping, elision marker or partial raw payload.

## Correctness properties

1. **Immutable caller identity.** For every valid input/context, construction and
   wire validation preserve eventId. Changing payload/presentation/RF metadata
   cannot recompute it; separate caller IDs remain distinct even with equal data.
   _Validates: Requirements 1.2, 1.3, 1.4._
2. **Truthful defaults and explicit provenance.** Arbitrary payload frequency,
   source, protocol identifiers and decoder names cannot change default unknown
   provenance. Valid supplied context is preserved without reading live state.
   _Validates: Requirements 3.1, 3.2, 3.3, 3.5, 4.1._
3. **Complete detached JSON projection.** Supported bounded values project with
   the stated Date/undefined/-0 semantics and round-trip through JSON; mutation of
   input or output cannot affect the other, and ordinary unknown keys survive.
   _Validates: Requirements 5.1, 5.2, 5.5._
4. **Independent clocks and truthful event type.** Valid producer/ingestion times
   survive normalization in either order; reported payload times remain separate;
   lifecycle/status outputs keep their type without implying accepted evidence.
   _Validates: Requirements 1.1, 2.1, 2.2, 2.3, 4.2._
5. **Bounded all-or-nothing validation.** Values beyond each exact limit, invalid
   versions and malformed metadata fail with the same safe error; no partial
   envelope or truncated decodedData is returned.
   _Validates: Requirements 4.3, 5.3, 5.4, 6.1, 6.2._

Use fast-check with numRuns at least 100 and the project's Feature/Property/
Requirements comment convention. Hostile descriptor cases also need deterministic
getter/custom-serializer counters, circular/shared-object fixtures, exact escaped
UTF-8 size boundaries and generic error serialization assertions. Test payloads
exactly at depth 16 and 4096 nodes through both create and wire validation,
reject their one-over counterparts, and verify create/validate equivalence.

## Checkpoints and deferred work

First review this draft and the ownership plan. Implement the new-path foundation
only after authorization, then independently review source and run targeted tests,
repository typecheck and lint in a coordinated window. No runtime is changed or
protected by this helper batch. Publication/mounting requires a separate scanner/
CLI/web contract review, including current output admission and capture-time
context APIs. Persistent Activity storage, full-text search, replay cursors,
recording ownership, analog transmission events and accounts remain deferred.
