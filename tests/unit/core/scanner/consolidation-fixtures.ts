/**
 * WG15 DQ 7: legacy stores for the consolidation tests. Records are cloned from one ingested
 * template, so every field is well formed; their observations carry the given centre, OBW and
 * peak. Restored with `restore()`, as a store written before requirement 7 would be loaded.
 */
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import type {
	JournalEntry,
	StoreSnapshot,
} from "../../../../src/core/scanner/store/discovery-store.js"
import type {
	Discovery,
	Observation,
	ProtocolFamily,
	ScannerConfidence,
	ScannerProtocol,
} from "../../../../src/core/scanner/types.js"
import { counterIds, makeObs } from "../../../mocks/scanner/observations.js"

export const T0 = Date.UTC(2026, 9, 1, 12, 0, 0)

export interface LegacySpec {
	id: string
	centreHz: number
	obwHz?: number // default 8000
	peakDbfs?: number // default -50
	count?: number // default 5
	family?: ProtocolFamily // default "unknown"
	protocol?: ScannerProtocol // default "unknown"
	confidence?: ScannerConfidence // default "activity"
	firstSeenMs?: number // default T0
	identity?: Discovery["identity"]
	operator?: Discovery["operator"]
	sourceId?: string // default "src-1"
}

let template: { d: Discovery; o: Observation } | null = null

function templateRecord(): { d: Discovery; o: Observation } {
	if (template !== null) return template
	const store = new DiscoveryStore({
		maxDiscoveries: 10,
		now: () => T0,
		newId: counterIds(),
	})
	store.ingest(
		makeObs({ id: "tpl", centreHz: 446_000_000, startedAt: T0, snrDb: 30 }),
	)
	const s = store.snapshot()
	const d = s.discoveries[0]
	const o = s.observations[0]
	if (d === undefined || o === undefined)
		throw new Error("template not created")
	template = { d, o }
	return template
}

const iso = (ms: number): string => new Date(ms).toISOString()

export function legacySnapshot(specs: readonly LegacySpec[]): StoreSnapshot {
	const { d: td, o: to } = templateRecord()
	const discoveries: Discovery[] = []
	const observations: Observation[] = []
	for (const s of specs) {
		const count = s.count ?? 5
		const first = s.firstSeenMs ?? T0
		const d: Discovery = structuredClone(td)
		d.id = s.id
		d.frequencyHz = Math.round(s.centreHz)
		d.frequencyKey = `g:${Math.round(s.centreHz)}`
		d.measuredOffsetHz = 0
		d.bandwidthHz = s.obwHz ?? 8000
		d.family = s.family ?? "unknown"
		d.protocol = s.protocol ?? "unknown"
		d.confidence = s.confidence ?? "activity"
		d.firstSeenAt = iso(first)
		d.lastSeenAt = iso(first + count * 1000)
		d.observationCount = count
		d.airtimeMs = count * 1000
		d.coChannel = []
		d.sourceIds = [s.sourceId ?? "src-1"]
		if (s.identity !== undefined) d.identity = s.identity
		else delete d.identity
		if (s.operator !== undefined) d.operator = s.operator
		else delete d.operator
		discoveries.push(d)
		for (let i = 0; i < count; i++) {
			const o: Observation = structuredClone(to)
			o.id = `${s.id}-o${i}`
			o.discoveryId = s.id
			o.centerHz = s.centreHz
			o.obwHz = s.obwHz ?? 8000
			o.peakDbfs = s.peakDbfs ?? -50
			o.startedAt = iso(first + i * 1000)
			if (o.endedAt !== undefined) o.endedAt = iso(first + i * 1000 + 500)
			// These fixtures model established identities, so provide checked content
			// rather than relying on a legacy discovery label alone.
			if (s.identity !== undefined)
				o.decode = [
					{
						protocol: d.protocol,
						identity: s.identity,
						contentVerified: true,
						crcClean: true,
						metadata: {},
						at: first + i * 1000 + 3.7,
						epoch: o.sampleRange.epoch,
						origin: "probe",
					},
				]
			observations.push(o)
		}
	}
	return { discoveries, observations, corrections: [] }
}

export function storeOf(specs: readonly LegacySpec[]): {
	store: DiscoveryStore
	entries: JournalEntry[]
} {
	const entries: JournalEntry[] = []
	const store = new DiscoveryStore({
		maxDiscoveries: 100_000,
		now: () => T0 + 86_400_000,
		newId: counterIds(),
	})
	store.restore(legacySnapshot(specs))
	let seq = 0
	store.on("mutation", (e: Omit<JournalEntry, "seq">) =>
		entries.push({ ...e, seq: ++seq }),
	)
	return { store, entries }
}

/** Live ids and each one's sorted observation ids. */
export function shape(store: DiscoveryStore): Record<string, string[]> {
	const s = store.snapshot()
	const out: Record<string, string[]> = {}
	for (const d of [...s.discoveries].sort((a, b) => (a.id < b.id ? -1 : 1)))
		out[d.id] = []
	for (const o of s.observations) out[o.discoveryId]?.push(o.id)
	for (const k of Object.keys(out)) out[k]?.sort()
	return out
}
