/**
 * Detection quality requirement 10: synthetic legacy stores holding fragments of one channel.
 * Built on the consolidation fixtures; a 12.5 kHz channel raster covers the whole test range.
 */
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import type {
	JournalEntry,
	StoreSnapshot,
} from "../../../../src/core/scanner/store/discovery-store.js"
import type { Raster } from "../../../../src/core/spectrum/types.js"
import { counterIds } from "../../../mocks/scanner/observations.js"
import { T0, legacySnapshot } from "./consolidation-fixtures.js"
import type { LegacySpec } from "./consolidation-fixtures.js"

export { T0 }
export const HOUR = 3_600_000
export const SPACING = 12_500
export const FIRST = 446_000_000
/** Channel `n` of the test raster. */
export const ch = (n: number): number => FIRST + n * SPACING

export const RASTER: Raster = { spacingHz: SPACING, firstChannelHz: FIRST }

export interface FragmentSpec extends LegacySpec {
	recordings?: number
	decoded?: boolean
	/** Epoch milliseconds of the last sighting (default: `firstSeenMs` plus count seconds). */
	lastSeenMs?: number
}

export function fragmentSnapshot(
	specs: readonly FragmentSpec[],
): StoreSnapshot {
	const s = legacySnapshot(specs)
	for (const spec of specs) {
		const d = s.discoveries.find(x => x.id === spec.id)
		if (d === undefined) continue
		if (spec.recordings !== undefined) d.evidence.recordings = spec.recordings
		if (spec.decoded === true) {
			d.confidence = "decoded"
			d.protocol = "dmr"
			d.family = "digital-voice"
		}
		if (spec.lastSeenMs !== undefined)
			d.lastSeenAt = new Date(spec.lastSeenMs).toISOString()
	}
	return s
}

export function fragmentStore(
	specs: readonly FragmentSpec[],
	opts: { nowMs?: number; rasters?: Raster[] } = {},
): {
	store: DiscoveryStore
	entries: JournalEntry[]
	clock: { now: number }
	before: StoreSnapshot
} {
	const clock = { now: opts.nowMs ?? T0 + HOUR }
	const rasters = opts.rasters ?? [RASTER]
	const store = new DiscoveryStore({
		maxDiscoveries: 100_000,
		now: () => clock.now,
		newId: counterIds(),
		channelRasters: () => rasters,
	})
	const before = fragmentSnapshot(specs)
	store.restore(structuredClone(before))
	const entries: JournalEntry[] = []
	let seq = 0
	store.on("mutation", (e: Omit<JournalEntry, "seq">) =>
		entries.push({ ...e, seq: ++seq }),
	)
	return { store, entries, clock, before }
}

/** Sum of `observationCount` over the live records. */
export function sightings(store: DiscoveryStore): number {
	let n = 0
	for (const d of store.snapshot().discoveries) n += d.observationCount
	return n
}
