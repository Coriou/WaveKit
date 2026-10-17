/**
 * WG11 req 3.5 (design "Snapshot worker"): a mirror of the snapshot's record set, one JSON text
 * per discovery and per observation, fed by the journal lines `ScannerPersistence.append` builds
 * (the mirror message is that line, design "SC journal") and by the store's `mirror-removal`
 * events. It applies each payload with the semantics of `DiscoveryStore.replay` (applyMutation):
 * discoveries replace by id, observations unlink their previous copy and are inserted in
 * canonical order with the per-discovery window trimmed, `removedObservations` unlink, `deleted`
 * removes the discovery with its observations. `build` assembles the text today's
 * `writeSnapshot` produces with `JSON.stringify` for the same state: same top-level key order,
 * discoveries sorted by id, observations by `compareObs`, the small parts (corrections, prepared
 * recording operations, aliases) passed in as the JSON the main thread stringified.
 *
 * Pure (no IO, no worker API): the worker entry and the in-process tests both use it.
 */
import type { StoreSnapshot } from "./discovery-store.js"

/** `DiscoveryStore` OBSERVATIONS_PER_DISCOVERY (not exported there); a drift shows as a count mismatch. */
export const MIRROR_OBSERVATIONS_PER_DISCOVERY = 256
const FILE_VERSION = 1

interface MirrorObservation {
	id: string
	discoveryId: string
	startedAt: string
	text: string
}

/** The snapshot fields the main thread computes (cheap, small): JSON texts, absent ones omitted. */
export interface SnapshotHead {
	lastSeq: number
	/** ISO timestamp, as `new Date(now).toISOString()`. */
	savedAt: string
	/** `JSON.stringify(snapshot.corrections)`; undefined when the field would be omitted. */
	corrections: string | undefined
	/** `JSON.stringify(prepared recording operations)` after schema validation. */
	recordingOperations: string
	/** `JSON.stringify(aliases)` when there is at least one entry; null otherwise (field omitted). */
	aliases: string | null
}

export interface MirrorCounts {
	discoveries: number
	observations: number
}

/** Small parts of a store snapshot, the shape `snapshotHeadOf` reads. */
export type SnapshotParts = Pick<
	StoreSnapshot,
	"corrections" | "recordingOperations" | "aliases"
>

/** The head for `parts` exactly as `writeSnapshot` stringifies them; `recordingOperations` already validated. */
export function snapshotHeadOf(
	parts: SnapshotParts,
	recordingOperations: unknown,
	lastSeq: number,
	savedAtMs: number,
): SnapshotHead {
	const aliases = parts.aliases
	return {
		lastSeq,
		savedAt: new Date(savedAtMs).toISOString(),
		corrections: JSON.stringify(parts.corrections) as string | undefined,
		recordingOperations: JSON.stringify(recordingOperations),
		aliases: aliases && aliases.length > 0 ? JSON.stringify(aliases) : null,
	}
}

const compareText = (a: string, b: string): number =>
	a < b ? -1 : a > b ? 1 : 0
const compareObs = (a: MirrorObservation, b: MirrorObservation): number =>
	compareText(a.startedAt, b.startedAt) || compareText(a.id, b.id)

/** The fields read from untrusted objects (all unknown until checked). */
interface Loose {
	id?: unknown
	seq?: unknown
	payload?: unknown
	discoveries?: unknown
	observations?: unknown
	deleted?: unknown
	removedObservations?: unknown
	discoveryId?: unknown
	startedAt?: unknown
}

function isRecord(value: unknown): value is Loose {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringList(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null
	for (const x of value) if (typeof x !== "string") return null
	return value as string[]
}

interface ParsedPayload {
	discoveries: { id: string; text: string }[]
	observations: MirrorObservation[]
	removedObservations: string[]
	deleted: string[]
}

/** Structural check of a mutation payload; the record texts are taken from the parsed values. */
function parsePayload(payload: unknown): ParsedPayload | null {
	if (!isRecord(payload)) return null
	const ds = payload.discoveries
	const os = payload.observations
	const deleted = stringList(payload.deleted)
	const removed =
		payload.removedObservations === undefined
			? []
			: stringList(payload.removedObservations)
	if (!Array.isArray(ds) || !Array.isArray(os) || !deleted || !removed)
		return null
	const discoveries: ParsedPayload["discoveries"] = []
	for (const d of ds as unknown[]) {
		if (!isRecord(d) || typeof d.id !== "string") return null
		discoveries.push({ id: d.id, text: JSON.stringify(d) })
	}
	const observations: MirrorObservation[] = []
	for (const o of os as unknown[]) {
		if (
			!isRecord(o) ||
			typeof o.id !== "string" ||
			typeof o.discoveryId !== "string" ||
			typeof o.startedAt !== "string"
		)
			return null
		observations.push({
			id: o.id,
			discoveryId: o.discoveryId,
			startedAt: o.startedAt,
			text: JSON.stringify(o),
		})
	}
	return { discoveries, observations, removedObservations: removed, deleted }
}

export class SnapshotMirror {
	private readonly discoveries = new Map<string, string>()
	private readonly observations = new Map<string, MirrorObservation>()
	private readonly byDiscovery = new Map<string, MirrorObservation[]>()
	private seq = 0
	/** Why the mirror stopped tracking the store (a malformed or out-of-order input); null while sound. */
	private brokenReason: string | null = null

	lastSeq(): number {
		return this.seq
	}

	broken(): string | null {
		return this.brokenReason
	}

	counts(): MirrorCounts {
		return {
			discoveries: this.discoveries.size,
			observations: this.observations.size,
		}
	}

	/** Bytes of record text held (UTF-16 units), the bulk of the mirror's heap. */
	textUnits(): number {
		let n = 0
		for (const t of this.discoveries.values()) n += t.length
		for (const o of this.observations.values()) n += o.text.length
		return n
	}

	/** One journal line (`{"seq":…,"at":…,"op":…,"payload":…}\n`). Malformed, out of order or past a seq gap: broken. */
	applyLine(line: string): void {
		if (this.brokenReason !== null) return
		let raw: unknown
		try {
			raw = JSON.parse(line)
		} catch {
			this.brokenReason = "malformed line"
			return
		}
		if (!isRecord(raw) || typeof raw.seq !== "number") {
			this.brokenReason = "malformed line"
			return
		}
		this.applyEntry(raw.seq, raw.payload)
	}

	applyEntry(seq: number, payload: unknown): void {
		if (this.brokenReason !== null) return
		if (!Number.isSafeInteger(seq) || seq <= this.seq) {
			this.brokenReason = "out-of-order line"
			return
		}
		// Persistence assigns contiguous seqs and feeds every one (refused ones too) after a reset
		// at the last seq, so a gap is a lost line: one the counts and lastSeq alone can miss.
		if (seq !== this.seq + 1) {
			this.brokenReason = "seq gap"
			return
		}
		const m = parsePayload(payload)
		if (m === null) {
			this.brokenReason = "malformed payload"
			return
		}
		this.seq = seq
		for (const d of m.discoveries) this.discoveries.set(d.id, d.text)
		for (const o of m.observations) {
			const previous = this.observations.get(o.id)
			if (previous !== undefined) this.unlink(previous)
			this.put(o)
		}
		for (const id of m.removedObservations) {
			const previous = this.observations.get(id)
			if (previous !== undefined) this.unlink(previous)
		}
		for (const id of m.deleted) this.removeDiscovery(id)
	}

	/** A store `mirror-removal`: records that left the snapshot set without a journal entry. */
	applyRemoval(removal: unknown): void {
		if (this.brokenReason !== null) return
		if (!isRecord(removal)) {
			this.brokenReason = "malformed removal"
			return
		}
		const ds = stringList(removal.discoveries)
		const os = stringList(removal.observations)
		if (!ds || !os) {
			this.brokenReason = "malformed removal"
			return
		}
		for (const id of os) {
			const previous = this.observations.get(id)
			if (previous !== undefined) this.unlink(previous)
		}
		for (const id of ds) this.removeDiscovery(id)
	}

	/** Replaces the whole state with a snapshot file text (the main path's own output) at `seq`. */
	resetFromText(text: string, seq: number): void {
		let raw: unknown
		try {
			raw = JSON.parse(text)
		} catch {
			raw = null
		}
		this.clear()
		if (!isRecord(raw) || !Number.isSafeInteger(seq) || seq < 0) {
			this.brokenReason = "malformed reset"
			return
		}
		this.seq = seq
		const m = parsePayload({
			discoveries: raw.discoveries,
			observations: raw.observations,
			deleted: [],
		})
		if (m === null) {
			this.brokenReason = "malformed reset"
			return
		}
		for (const d of m.discoveries) this.discoveries.set(d.id, d.text)
		// A snapshot is already canonical and trimmed: append in its order.
		for (const o of m.observations) {
			const previous = this.observations.get(o.id)
			if (previous !== undefined) this.unlink(previous)
			this.put(o)
		}
	}

	/** Stops applying input; the next snapshot request fails to the main path. */
	markBroken(reason: string): void {
		this.brokenReason ??= reason
	}

	clear(): void {
		this.discoveries.clear()
		this.observations.clear()
		this.byDiscovery.clear()
		this.seq = 0
		this.brokenReason = null
	}

	/** The snapshot file text for the mirrored records and `head`, byte-identical to `writeSnapshot`'s. */
	build(head: SnapshotHead): string {
		return [...snapshotChunks(this.capture(head))].join("")
	}

	/**
	 * The records of the current state in snapshot order, as references to the mirror's own
	 * (immutable) texts: O(records) pointers, no text copy. Later input does not change it.
	 */
	capture(head: SnapshotHead): CapturedSnapshot {
		const ids = [...this.discoveries.keys()].sort(compareText)
		const discoveries: string[] = new Array<string>(ids.length)
		for (let i = 0; i < ids.length; i++)
			discoveries[i] = this.discoveries.get(ids[i] as string) as string
		const obs = [...this.observations.values()].sort(compareObs)
		const observations: string[] = new Array<string>(obs.length)
		for (let i = 0; i < obs.length; i++)
			observations[i] = (obs[i] as MirrorObservation).text
		return { head: { ...head }, discoveries, observations }
	}

	private put(o: MirrorObservation): void {
		this.observations.set(o.id, o)
		let list = this.byDiscovery.get(o.discoveryId)
		if (list === undefined) {
			list = []
			this.byDiscovery.set(o.discoveryId, list)
		}
		let i = list.length
		for (;;) {
			const previous = list[i - 1]
			if (previous === undefined || compareObs(previous, o) <= 0) break
			i--
		}
		list.splice(i, 0, o)
		while (list.length > MIRROR_OBSERVATIONS_PER_DISCOVERY) {
			const dropped = list.shift()
			if (dropped !== undefined) this.observations.delete(dropped.id)
		}
	}

	private unlink(o: MirrorObservation): void {
		const list = this.byDiscovery.get(o.discoveryId)
		if (list !== undefined) {
			const i = list.findIndex(x => x.id === o.id)
			if (i >= 0) list.splice(i, 1)
		}
		this.observations.delete(o.id)
	}

	private removeDiscovery(id: string): void {
		if (!this.discoveries.delete(id)) return
		for (const o of this.byDiscovery.get(id) ?? [])
			this.observations.delete(o.id)
		this.byDiscovery.delete(id)
	}
}

/** A snapshot state captured by `SnapshotMirror.capture`. */
export interface CapturedSnapshot {
	head: SnapshotHead
	discoveries: readonly string[]
	observations: readonly string[]
}

/**
 * The snapshot file text of `c` in pieces of at most `perChunk` records (their concatenation is
 * the `JSON.stringify` text), so the writer never holds a second full copy.
 */
export function* snapshotChunks(
	c: CapturedSnapshot,
	perChunk = 512,
): Generator<string> {
	const h = c.head
	yield `{"version":${FILE_VERSION},"lastSeq":${JSON.stringify(h.lastSeq)},` +
		`"savedAt":${JSON.stringify(h.savedAt)},"discoveries":[`
	yield* joined(c.discoveries, perChunk)
	yield `],"observations":[`
	yield* joined(c.observations, perChunk)
	yield "]" +
		(h.corrections === undefined ? "" : `,"corrections":${h.corrections}`) +
		`,"recordingOperations":${h.recordingOperations}` +
		(h.aliases === null ? "" : `,"aliases":${h.aliases}`) +
		"}"
}

function* joined(
	texts: readonly string[],
	perChunk: number,
): Generator<string> {
	const step = Math.max(1, Math.floor(perChunk))
	for (let i = 0; i < texts.length; i += step)
		yield (i === 0 ? "" : ",") + texts.slice(i, i + step).join(",")
}
