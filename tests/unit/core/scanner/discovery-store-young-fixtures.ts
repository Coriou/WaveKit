/**
 * WG15 DQ requirement 9: shared helpers for the young-record and weak-guess tests. Grid placement
 * (no raster); `F` is a multiple of 30 000 Hz so the 2 000, 2 500 and 3 000 Hz grids share its key.
 */
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import type { JournalEntry } from "../../../../src/core/scanner/store/discovery-store.js"
import type { ProofAnalogInput } from "../../../../src/core/scanner/scanner-redesign-contract.js"
import type {
	Discovery,
	ObservationInput,
	ProtocolFamily,
	ScannerClass,
} from "../../../../src/core/scanner/types.js"
import { counterIds, makeObs } from "../../../mocks/scanner/observations.js"
import { T0, legacySnapshot } from "./consolidation-fixtures.js"
import type { LegacySpec } from "./consolidation-fixtures.js"

export { T0 }
export type { LegacySpec }

export const F = 446_100_000
export const SRC = "src-1"

export function newStore(): {
	store: DiscoveryStore
	entries: JournalEntry[]
} {
	const entries: JournalEntry[] = []
	const store = new DiscoveryStore({
		maxDiscoveries: 1_000,
		now: () => T0 + 86_400_000,
		newId: counterIds(),
		rasters: () => [],
	})
	store.on("mutation", (e: Omit<JournalEntry, "seq">) =>
		entries.push({ ...e, seq: entries.length + 1 }),
	)
	return { store, entries }
}

/** A store restored from legacy records (as a store written before requirement 9 loads). */
export function restored(specs: readonly LegacySpec[]): DiscoveryStore {
	const { store } = newStore()
	store.restore(legacySnapshot(specs))
	return store
}

export interface Spec {
	id: string
	centreHz: number
	at: number
	obwHz?: number
	peakDbfs?: number
	snrDb?: number
	cls?: ScannerClass
}

export function obs(s: Spec): ObservationInput {
	const o = makeObs({
		id: s.id,
		centreHz: s.centreHz,
		startedAt: s.at,
		obwHz: s.obwHz ?? 9_000,
		snrDb: s.snrDb ?? 25,
		cls: s.cls ?? "unknown",
		gate: "passed",
	})
	if (s.peakDbfs !== undefined) o.track.peakDbfs = s.peakDbfs
	o.track.flags.overload = false
	return o
}

export function carrierOnly(at: number): ProofAnalogInput {
	return {
		outcome: "carrier-only",
		mode: "nfm",
		voice: false,
		tone: { ctcssHz: null, dcs: null },
		transport: "live",
		at,
	}
}

export function tone(at: number): ProofAnalogInput {
	return {
		outcome: "decoded",
		mode: "nfm",
		voice: true,
		tone: { ctcssHz: 88.5, dcs: null },
		transport: "live",
		at,
	}
}

/** Ids of the live records, sorted. */
export function ids(store: DiscoveryStore): string[] {
	return store
		.snapshot()
		.discoveries.map(d => d.id)
		.sort()
}

/** Private store paths the per-path fixtures drive directly. */
export interface StoreInternals {
	keyTarget(
		sourceId: string,
		key: string,
		family: ProtocolFamily,
		cls: ScannerClass,
		obs: ObservationInput,
		decodedAs?: string,
		evidenceLess?: boolean,
	): { merge: Discovery | null; coChannel: string[] }
	bandwidthJoins(d: Discovery, obwHz: number): boolean
	discoveries: Map<string, Discovery>
}

export const internals = (s: DiscoveryStore): StoreInternals =>
	s as unknown as StoreInternals
