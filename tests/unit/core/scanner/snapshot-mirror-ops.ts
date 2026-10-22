/**
 * Seeded store op sequences for the WG11 snapshot mirror and worker tests (not a test file).
 * Drives the real DiscoveryStore through ingest, re-ingest, evidence, classification, operator,
 * delete, rekey (merges and aliases), prune and capacity eviction, and records every journal
 * entry it emits.
 */
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import type { JournalEntry } from "../../../../src/core/scanner/store/discovery-store.js"
import {
	recordingAlias,
	recordingArtifact,
} from "../../../../src/core/scanner/store/recording-operation.js"
import type {
	ScannerClass,
	ScannerProtocol,
} from "../../../../src/core/scanner/types.js"
import {
	counterIds,
	dmrCc,
	evidence,
	makeObs,
} from "../../../mocks/scanner/observations.js"

export const OPS_T0 = Date.UTC(2026, 9, 17, 12, 0, 0)
const DAY = 86_400_000
const BASE_HZ = 446_000_000
const SOURCES = ["src-1", "src-2"]
const CLASSES: ScannerClass[] = ["unknown", "analog-fm", "fsk4-12k5", "tdma-ms"]
const PROTOCOLS: ScannerProtocol[] = ["dmr", "analog-fm", "p25p1", "pocsag"]

export function mulberry32(seed: number): () => number {
	let a = seed >>> 0
	return () => {
		a = (a + 0x6d2b79f5) >>> 0
		let t = a
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
	}
}

const hex = (rand: () => number, n: number): string =>
	Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join("")
const uuid = (rand: () => number): string =>
	`${hex(rand, 8)}-${hex(rand, 4)}-4${hex(rand, 3)}-8${hex(rand, 3)}-${hex(rand, 12)}`

/** A prepared recording operation on `discoveryId` (journaled with the discovery, as Task 42). */
function prepare(
	store: DiscoveryStore,
	discoveryId: string,
	rand: () => number,
): void {
	const operationId = uuid(rand)
	const o = store.observations(discoveryId, null, 1).items[0]
	if (o === undefined) return
	const observationId = o.id
	store.prepareRecording({
		version: 1,
		operationId,
		producerRecordingId: operationId,
		discoveryId,
		observationId,
		alias: recordingAlias(discoveryId, operationId),
		artifact: recordingArtifact(discoveryId, operationId),
		desiredState: "linked",
		binding: {
			sourceId: o.sourceId,
			engineInstanceId: uuid(rand),
			stream: 1,
			epoch: 1,
			channelId: "opaque",
			channelGeneration: 1,
			inputFormat: "cf32",
			inputSampleRateHz: 48000,
			groupDelayInputSamples: null,
			targetHz: 446_000_000,
			captureCentreHz: null,
			tuningTrust: "commanded",
		},
		expectedOutput: {
			sampleRateHz: 8000,
			channelCount: 1,
			outputFrames: 80,
			fileBytes: 204,
		},
	})
}

export interface SeededRun {
	store: DiscoveryStore
	entries: Omit<JournalEntry, "seq">[]
	clock: { now: number }
}

/** A store with a fixed raster, a deterministic clock and ids; journal entries are recorded. */
export function seededStore(maxDiscoveries = 40): SeededRun {
	const clock = { now: OPS_T0 }
	const store = new DiscoveryStore({
		maxDiscoveries,
		now: () => clock.now,
		newId: counterIds(),
		rasters: () => [{ spacingHz: 12_500, firstChannelHz: BASE_HZ }],
	})
	const entries: Omit<JournalEntry, "seq">[] = []
	store.on("mutation", (e: Omit<JournalEntry, "seq">) => entries.push(e))
	return { store, entries, clock }
}

/** Applies `count` seeded ops (op codes from `rand`) to `run`. */
export function applySeededOps(
	run: SeededRun,
	rand: () => number,
	count: number,
	opts: { obsBase?: number; channels?: number; ingestShare?: number } = {},
): void {
	const obsBase = opts.obsBase ?? 0
	const channels = opts.channels ?? 8
	const ingestShare = opts.ingestShare ?? 0.55
	const { store, clock } = run
	const pick = <T>(xs: readonly T[]): T => {
		const x = xs[Math.floor(rand() * xs.length)]
		if (x === undefined) throw new Error("empty pick")
		return x
	}
	const known = new Set<string>()
	const track = (id: string): void => {
		known.add(id)
	}
	store.on("change", track)
	const ids = (): string[] => {
		for (const id of known) if (store.get(id) === undefined) known.delete(id)
		return [...known].sort()
	}
	let obs = obsBase
	for (let i = 0; i < count; i++) {
		clock.now += 1000 + Math.floor(rand() * 5000)
		const r = rand()
		if (r < ingestShare) {
			const reuse = obs > obsBase && rand() < 0.15
			const id = reuse
				? `o${obsBase + Math.floor(rand() * (obs - obsBase))}`
				: `o${obs++}`
			const cls = pick(CLASSES)
			store.ingest(
				makeObs({
					id,
					centreHz:
						BASE_HZ +
						Math.floor(rand() * channels) * 12_500 +
						Math.floor(rand() * 400) -
						200,
					startedAt: clock.now - 900,
					blocks: 2 + Math.floor(rand() * 4),
					snrDb: 10 + Math.floor(rand() * 20),
					cls,
					hypotheses:
						cls === "unknown" ? [] : [[pick(PROTOCOLS), 0.5 + rand() / 2]],
					sourceId: pick(SOURCES),
					jobIds: [rand() < 0.5 ? "job-1" : "job-2"],
				}),
			)
			continue
		}
		const all = ids()
		if (all.length === 0) continue
		const target = pick(all)
		if (r < 0.65) {
			const protocol = pick(PROTOCOLS)
			store.applyEvidence(
				target,
				evidence(protocol, clock.now, {
					...(protocol === "dmr"
						? { identity: dmrCc(1 + Math.floor(rand() * 3)) }
						: {}),
					talkgroups: [String(Math.floor(rand() * 9))],
				}),
			)
		} else if (r < 0.72) {
			store.applyClassification(target, {
				class: pick(CLASSES),
				hypotheses: [{ protocol: pick(PROTOCOLS), score: rand() }],
				tier: "spectral",
			})
		} else if (r < 0.8) {
			store.setOperator(target, {
				label: `L${Math.floor(rand() * 5)}`,
				...(rand() < 0.3 ? { keep: rand() < 0.5 } : {}),
			})
		} else if (r < 0.85) {
			store.delete(target)
		} else if (r < 0.92) {
			store.rekey(pick(SOURCES), pick([-12_500, 0, 300, 12_500, 25_000]))
		} else if (r < 0.95) {
			if (rand() < 0.2) clock.now += DAY * 2
			store.pruneInactive(1)
		} else if (r < 0.97) {
			store.setEvidenceFlags(target, { psd: rand() < 0.5 })
		} else if (r < 0.98) {
			prepare(store, target, rand)
		} else {
			store.setLimits({
				maxDiscoveries: 5 + Math.floor(rand() * 30),
				minSurfaceBlocks: 2,
			})
		}
	}
	store.off("change", track)
}
