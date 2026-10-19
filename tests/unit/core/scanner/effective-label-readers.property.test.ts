/**
 * After ingest, sink evidence, decodes and operator marks, every discovery's
 * identityOf and confidence sort agree with get(). Capacity eviction drops the
 * lowest shown confidence, and still refuses a stored decoded record.
 */
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import type {
	ProofAnalogInput,
	ProofTrialInput,
} from "../../../../src/core/scanner/scanner-redesign-contract.js"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import { CONFIDENCE_RANK } from "../../../../src/core/scanner/types.js"
import type {
	Discovery,
	ScannerConfidence,
} from "../../../../src/core/scanner/types.js"
import {
	classification,
	counterIds,
	dmrCc,
	evidence,
	makeObs,
} from "../../../mocks/scanner/observations.js"
import { mulberry } from "./store-index-ops.js"

const BASE = 446_000_000
const rank = (c: ScannerConfidence): number => CONFIDENCE_RANK[c]

function tone(at: number): ProofAnalogInput {
	return {
		outcome: "decoded",
		mode: "nfm",
		voice: true,
		tone: { ctcssHz: 88.5, dcs: null },
		transport: "live",
		at,
	}
}

function heard(at: number): ProofAnalogInput {
	return {
		outcome: "heard",
		mode: "nfm",
		voice: true,
		tone: { ctcssHz: null, dcs: null },
		transport: "live",
		at,
	}
}

function carrier(at: number): ProofAnalogInput {
	return {
		outcome: "carrier-only",
		mode: "nfm",
		voice: false,
		tone: { ctcssHz: null, dcs: null },
		transport: "live",
		at,
	}
}

function dataLike(at: number): ProofAnalogInput {
	return {
		outcome: "data-like",
		mode: "nfm",
		voice: false,
		tone: { ctcssHz: null, dcs: null },
		transport: "live",
		at,
	}
}

function trial(at: number): ProofTrialInput {
	return {
		protocol: "dmr",
		decoder: "dsd-fme",
		outcome: "no-sync",
		order: 1,
		at,
	}
}

function agree(store: DiscoveryStore): void {
	const listed = store.list({ sort: "confidence", limit: 500 }).items
	expect(listed).toHaveLength(store.snapshot().discoveries.length)
	let previous = Number.POSITIVE_INFINITY
	for (const item of listed) {
		const shown = store.get(item.id)
		expect(shown?.protocol).toBe(item.protocol)
		expect(shown?.family).toBe(item.family)
		expect(shown?.confidence).toBe(item.confidence)
		expect(store.identityOf(item.id)).toEqual({
			id: item.id,
			protocol: item.protocol,
			confidence: item.confidence,
		})
		const next = rank(item.confidence)
		expect(next).toBeLessThanOrEqual(previous)
		previous = next
	}
}

/** Victim get() would name: lowest shown confidence, then oldest, then smaller id. */
function predictVictim(store: DiscoveryStore): string | undefined {
	const stored = new Map(
		store.snapshot().discoveries.map(d => [d.id, d.confidence]),
	)
	let victim: Discovery | undefined
	for (const shown of store.list({ limit: 500 }).items) {
		if (stored.get(shown.id) === "decoded" || shown.confidence === "decoded")
			continue
		if (shown.operator?.keep === true || shown.operator?.lockout === true)
			continue
		if (
			victim === undefined ||
			rank(shown.confidence) < rank(victim.confidence) ||
			(rank(shown.confidence) === rank(victim.confidence) &&
				(shown.lastSeenAt < victim.lastSeenAt ||
					(shown.lastSeenAt === victim.lastSeenAt && shown.id < victim.id)))
		)
			victim = shown
	}
	return victim?.id
}

describe("proof-implied label agrees across readers", () => {
	it("identityOf, eviction and confidence order follow get() after sink evidence", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 2 ** 31 - 1 }),
				fc.integer({ min: 2, max: 4 }),
				fc.integer({ min: 12, max: 36 }),
				(seed, max, steps) => {
					const rand = mulberry(seed)
					let clock = 1_700_000_000_000
					let n = 0
					const observations: string[] = []
					const store = new DiscoveryStore({
						maxDiscoveries: max,
						now: () => clock,
						newId: counterIds(),
					})
					const pick = <T>(xs: readonly T[]): T =>
						xs[Math.floor(rand() * xs.length)] as T
					const ingestAt = (centreHz: number): void => {
						clock += 1_000
						const before = store.snapshot().discoveries.map(d => d.id)
						const full = before.length >= max
						const predicted = full ? predictVictim(store) : undefined
						const id = `o${n}`
						n += 1
						const res = store.ingest(
							makeObs({
								id,
								centreHz,
								startedAt: clock,
								gate: "passed",
								jobIds: ["job-1"],
							}),
						)
						observations.push(id)
						if (!full) {
							expect(res.discoveryId).toBeTruthy()
							return
						}
						if (predicted === undefined) {
							expect(res).toEqual({ discoveryId: null, change: "transient" })
							expect(
								store
									.snapshot()
									.discoveries.map(d => d.id)
									.sort(),
							).toEqual([...before].sort())
							return
						}
						expect(res.discoveryId).toBeTruthy()
						expect(before.includes(res.discoveryId ?? "")).toBe(false)
						for (const existing of before) {
							if (existing === predicted)
								expect(store.get(existing)).toBeUndefined()
							else expect(store.get(existing)).toBeDefined()
						}
					}
					for (let step = 0; step < steps; step++) {
						clock += 500
						const roll = rand()
						const ids = store.snapshot().discoveries.map(d => d.id)
						if (roll < 0.4 || observations.length === 0) {
							ingestAt(BASE + n * 1_000_000)
						} else if (roll < 0.7) {
							const obs = pick(observations)
							const kind = rand()
							if (kind < 0.35) store.recordAnalog(obs, tone(clock))
							else if (kind < 0.6) store.recordAnalog(obs, heard(clock))
							else if (kind < 0.8) store.recordAnalog(obs, carrier(clock))
							else {
								store.recordAnalog(obs, dataLike(clock))
								store.recordTrial(obs, trial(clock))
							}
						} else if (roll < 0.85 && ids.length > 0) {
							const id = pick(ids)
							store.applyEvidence(
								id,
								evidence("dmr", clock, { identity: dmrCc(1) }),
							)
							if (rand() < 0.5)
								store.recordAnalog(pick(observations), heard(clock))
						} else if (roll < 0.95 && ids.length > 0) {
							store.setOperator(
								pick(ids),
								rand() < 0.5 ? { keep: true } : { lockout: true },
							)
						} else if (ids.length > 0) {
							store.applyClassification(
								pick(ids),
								classification("unknown", [], "adjacent-leak", "channel"),
							)
						}
						agree(store)
					}
				},
			),
			{ numRuns: 100 },
		)
	}, 60_000)
})
