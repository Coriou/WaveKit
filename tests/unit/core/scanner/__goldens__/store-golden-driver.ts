/**
 * Deterministic driver for the WG11 store goldens (lane SC, req 3.4 and 3.5): a seeded sequence of
 * ingest, re-ingest, retract, merge, evidence, classification, operator, delete, rekey, prune,
 * eviction, restore and replay on a fixed clock. Recorded from the frozen store; the reworked store
 * must reproduce every journal line, change event and snapshot text byte for byte.
 */
import { DiscoveryStore } from "../../../../../src/core/scanner/store/discovery-store.js"
import type {
	JournalEntry,
	StoreSnapshot,
} from "../../../../../src/core/scanner/store/discovery-store.js"
import type {
	ObservationInput,
	ScannerClass,
	ScannerProtocol,
} from "../../../../../src/core/scanner/types.js"
import type { Raster } from "../../../../../src/core/spectrum/types.js"
import {
	classification,
	counterIds,
	dmrCc,
	evidence,
	makeObs,
} from "../../../../mocks/scanner/observations.js"

export interface GoldenRun {
	lines: string[]
	snapshots: string[]
}

const BASE = 446_006_250
const PMR: Raster[] = [{ spacingHz: 12_500, firstChannelHz: BASE }]
const T0 = Date.UTC(2026, 9, 9, 12, 0, 0)
const SOURCES = ["src-1", "src-2", "src-3"]
const JOBS = ["job-a", "job-b", "job-c"]
const PROTOS: ScannerProtocol[] = [
	"dmr",
	"analog-fm",
	"unknown",
	"nxdn96",
	"digital-unknown",
	"carrier",
]

/** mulberry32: small seeded PRNG. */
export function rng(seed: number): () => number {
	let a = seed >>> 0
	return () => {
		a = (a + 0x6d2b79f5) >>> 0
		let t = a
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

const classOf = (p: ScannerProtocol): ScannerClass =>
	p === "dmr" || p === "nxdn96"
		? "fsk4-12k5"
		: p === "analog-fm"
			? "analog-fm"
			: p === "carrier"
				? "carrier"
				: p === "digital-unknown"
					? "fsk4-6k25"
					: "unknown"

export function runGolden(seed: number, steps: number, slots = 14): GoldenRun {
	const r = rng(seed)
	const int = (n: number): number => Math.floor(r() * n)
	const pick = <T>(xs: readonly T[]): T => xs[int(xs.length)] as T
	let clock = T0
	const ids = counterIds()
	const lines: string[] = []
	const snapshots: string[] = []
	const journal: JournalEntry[] = []
	let seq = 0
	const attach = (s: DiscoveryStore): void => {
		s.on("mutation", (e: Omit<JournalEntry, "seq">) => {
			lines.push(`M ${JSON.stringify(e)}`)
			seq += 1
			journal.push(JSON.parse(JSON.stringify({ seq, ...e })) as JournalEntry)
		})
		s.on("change", (id: string, change: string) =>
			lines.push(`C ${id} ${change}`),
		)
		s.on("evicted", (list: unknown) => lines.push(`E ${JSON.stringify(list)}`))
	}
	const make = (): DiscoveryStore => {
		const s = new DiscoveryStore({
			maxDiscoveries: 40,
			now: () => clock,
			newId: ids,
			rasters: (sourceId: string) => (sourceId === "src-2" ? [] : PMR),
			discoveryHoldsKept: id => id.endsWith("7"),
		})
		attach(s)
		return s
	}
	let store = make()
	const inputs: ObservationInput[] = []
	let checkpoint: { snap: StoreSnapshot; seq: number } | null = null
	// the ids snapshot() lists (sorted by id), without cloning every observation
	const discoveryIds = (): string[] =>
		store
			.list({ limit: 500 })
			.items.map(d => d.id)
			.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
	for (let i = 0; i < steps; i++) {
		clock += 500 + int(4_000)
		const roll = slots <= 2 && r() < 0.9 ? int(45) : int(100)
		if (roll < 45) {
			const proto = pick(PROTOS)
			const slot = int(slots)
			const jobs = JOBS.filter(() => r() < 0.5)
			const obs = makeObs({
				id: `o${i}`,
				centreHz: BASE + slot * 6_250 + int(900) - 450,
				startedAt: clock,
				blocks: 1 + int(4),
				cls: classOf(proto),
				hypotheses: proto === "unknown" ? [] : [[proto, r() < 0.8 ? 0.8 : 0.3]],
				...(r() < 0.1 ? { cap: "adjacent-leak" as const } : {}),
				tier: r() < 0.5 ? "channel" : "spectral",
				sweep: r() < 0.4,
				jobIds: r() < 0.05 ? [] : jobs.length === 0 ? ["job-a"] : jobs,
				sourceId: r() < 0.7 ? "src-1" : pick(SOURCES),
				snrDb: 10 + int(25),
				open: r() < 0.2,
				edge: r() < 0.05,
				burst: r() < 0.05,
				truncated: r() < 0.03,
			})
			inputs.push(obs)
			lines.push(`R ${JSON.stringify(store.ingest(obs))}`)
		} else if (roll < 55 && inputs.length > 0) {
			// re-ingest (same or changed snapshot of a known track)
			const prev = pick(inputs)
			const variant = int(4)
			const next: ObservationInput =
				variant === 0
					? prev
					: {
							...prev,
							jobIds: variant === 1 ? [...prev.jobIds, "job-z"] : prev.jobIds,
							endedAt: prev.startedAt + 1_000 + int(3_000),
							endReason: "quiet",
							track: {
								...prev.track,
								snrDb: variant === 2 ? prev.track.snrDb + 3 : prev.track.snrDb,
								centreHz: prev.track.centreHz + (variant === 3 ? 120 : 0),
								flags: {
									...prev.track.flags,
									truncated: r() < 0.05,
								},
							},
						}
			lines.push(`R ${JSON.stringify(store.ingest(next))}`)
		} else if (roll < 67) {
			const all = discoveryIds()
			if (all.length === 0) continue
			const id = pick(all)
			const proto = pick(["dmr", "nxdn96", "dpmr", "ysf"] as ScannerProtocol[])
			const identity =
				proto === "dmr"
					? dmrCc(1 + int(3))
					: { kind: "nxdn-ran" as const, value: String(1 + int(3)) }
			const ev = evidence(proto, clock, {
				...(r() < 0.7 ? { identity } : {}),
				encrypted: r() < 0.2,
				crcClean: r() < 0.9,
				talkgroups: Array.from({ length: int(6) }, (_, j) =>
					String(j + int(4)),
				),
			})
			lines.push(
				`R ${JSON.stringify(
					store.applyEvidence(
						id,
						ev,
						r() < 0.2 ? { cap: "suspected-intermod" } : {},
					),
				)}`,
			)
		} else if (roll < 72 && inputs.length > 0) {
			const o = pick(inputs)
			const ev = evidence(pick(["dmr", "nxdn96"] as ScannerProtocol[]), clock, {
				identity: dmrCc(1 + int(2)),
			})
			lines.push(
				`R ${JSON.stringify(store.appendObservationEvidence(o.id, r() < 0.3 ? { ...ev, at: o.startedAt + 10 } : ev))}`,
			)
		} else if (roll < 80) {
			const all = discoveryIds()
			if (all.length === 0) continue
			const proto = pick(PROTOS)
			lines.push(
				`R ${JSON.stringify(
					store.applyClassification(
						pick(all),
						classification(
							classOf(proto),
							proto === "unknown" ? [] : [[proto, 0.8]],
							r() < 0.2 ? "suspected-intermod" : undefined,
							r() < 0.5 ? "channel" : "spectral",
						),
					),
				)}`,
			)
		} else if (roll < 84) {
			const all = discoveryIds()
			if (all.length === 0) continue
			const id = pick(all)
			const v = int(4)
			lines.push(
				`R ${JSON.stringify(
					store.setOperator(
						id,
						v === 0
							? { keep: r() < 0.5 }
							: v === 1
								? { lockout: r() < 0.3 }
								: { label: `L${int(5)}` },
					),
				)}`,
			)
		} else if (roll < 87) {
			const all = discoveryIds()
			if (all.length === 0) continue
			lines.push(`R ${JSON.stringify(store.delete(pick(all)))}`)
		} else if (roll < 89) {
			lines.push(
				`R ${JSON.stringify(store.rekey(pick(["src-1", "src-3"]), int(3_000) - 1_500))}`,
			)
		} else if (roll < 91) {
			clock += 2 * 86_400_000
			lines.push(`R ${JSON.stringify(store.pruneInactive(1 + int(3)))}`)
		} else if (roll < 93) {
			store.setLimits({ maxDiscoveries: 10 + int(40), minSurfaceBlocks: 2 })
		} else if (roll < 96) {
			const all = discoveryIds()
			if (all.length === 0) continue
			const id = pick(all)
			const v = int(3)
			if (v === 0)
				lines.push(
					`R ${JSON.stringify(store.setEvidenceFlags(id, { psd: true }))}`,
				)
			else if (v === 1)
				lines.push(
					`R ${JSON.stringify(store.setUndecodedReason(id, "timeout"))}`,
				)
			else if (inputs.length > 0)
				lines.push(
					`R ${JSON.stringify(store.attachRecordings(pick(inputs).id, [`rec${i}`], "linked"))}`,
				)
		} else if (roll < 98) {
			if (checkpoint === null) {
				checkpoint = { snap: store.snapshot(), seq }
				snapshots.push(JSON.stringify(checkpoint.snap))
			} else {
				// restore the checkpoint into a fresh store, replay the journal after it, continue there
				const fresh = make()
				fresh.restore(checkpoint.snap)
				for (const e of journal) if (e.seq > checkpoint.seq) fresh.replay(e)
				store = fresh
				snapshots.push(JSON.stringify(store.snapshot()))
				checkpoint = null
			}
		} else {
			snapshots.push(JSON.stringify(store.snapshot()))
		}
	}
	snapshots.push(JSON.stringify(store.snapshot()))
	return { lines, snapshots }
}
