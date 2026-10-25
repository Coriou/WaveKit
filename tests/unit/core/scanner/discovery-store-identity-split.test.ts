import { describe, expect, it } from "vitest"
import fc from "fast-check"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import type {
	Identity,
	ObservationInput,
	ScannerProtocol,
} from "../../../../src/core/scanner/types.js"
import {
	counterIds,
	evidence,
	makeObs,
} from "../../../mocks/scanner/observations.js"

const F = 446_100_000
const T0 = Date.UTC(2026, 9, 24, 12, 0, 0)

const IDENTITY: Partial<Record<ScannerProtocol, Identity>> = {
	dmr: { kind: "dmr-cc", value: "1" },
	p25p1: { kind: "p25-nac", value: "293" },
	p25p2: { kind: "p25-nac", value: "293" },
	ysf: { kind: "ysf-dgid", value: "7" },
	pocsag: { kind: "pocsag-capcode", value: "1234567" },
	nxdn96: { kind: "nxdn-ran", value: "3" },
}

function newStore(): DiscoveryStore {
	return new DiscoveryStore({
		maxDiscoveries: 100,
		now: () => T0,
		newId: counterIds(),
		rasters: () => [],
	})
}

function obs(
	id: string,
	centreHz: number,
	at: number,
	peakDbfs: number,
): ObservationInput {
	const o = makeObs({
		id,
		centreHz,
		startedAt: at,
		durationMs: 1_000,
		snrDb: 30,
		gate: "passed",
	})
	o.track.peakDbfs = peakDbfs
	return o
}

/** Ingests `id`, appends a decode to it and applies it; returns the record id and the result. */
function decodeOnNew(
	store: DiscoveryStore,
	id: string,
	centreHz: number,
	at: number,
	peakDbfs: number,
	protocol: ScannerProtocol,
): {
	discoveryId: string
	result: ReturnType<DiscoveryStore["applyEvidence"]>
} {
	const discoveryId =
		store.ingest(obs(id, centreHz, at, peakDbfs)).discoveryId ?? ""
	expect(discoveryId).not.toBe("")
	const identity = IDENTITY[protocol]
	if (identity === undefined) throw new Error(`no identity for ${protocol}`)
	const ev = evidence(protocol, at + 100, { identity })
	expect(store.appendObservationEvidence(id, ev)).toBe(true)
	return { discoveryId, result: store.applyEvidence(discoveryId, ev) }
}

interface Case {
	protocol?: ScannerProtocol
	bOffsetHz?: number
	aPeak?: number
	bPeak?: number
	bStartMs?: number
}

/** Record A decoded at F (1 s from T0), then the same identity decoded on record B. */
function adjacent(c: Case = {}): {
	store: DiscoveryStore
	a: string
	b: string
	result: ReturnType<DiscoveryStore["applyEvidence"]>
} {
	const protocol = c.protocol ?? "dmr"
	const store = newStore()
	const a = decodeOnNew(store, "a", F, T0, c.aPeak ?? -20, protocol)
	expect(a.result).not.toBeNull()
	expect(store.get(a.discoveryId)?.confidence).toBe("decoded")
	const b = decodeOnNew(
		store,
		"b",
		F + (c.bOffsetHz ?? 9_400),
		T0 + (c.bStartMs ?? 500),
		c.bPeak ?? -45,
		protocol,
	)
	expect(b.discoveryId).not.toBe(a.discoveryId)
	return { store, a: a.discoveryId, b: b.discoveryId, result: b.result }
}

describe("DQ 2.4: identity split for adjacent-channel decode copies", () => {
	it("refuses a DMR source id copied onto a 25 dB weaker record 9.4 kHz away", () => {
		const { store, a, b, result } = adjacent()
		expect(result).toBeNull()
		const weak = store.get(b)
		expect(weak?.confidence).not.toBe("decoded")
		expect(weak?.identity).toBeUndefined()
		expect(store.get(a)?.identity).toEqual(IDENTITY.dmr)
	})

	it.each<[string, Case]>([
		["B only 5 dB weaker", { bPeak: -25 }],
		["B 35 kHz away", { bOffsetHz: 35_000 }],
		["B 3 s after A ends", { bStartMs: 1_000 + 2_000 + 3_000 }],
		["the same capcode on POCSAG records", { protocol: "pocsag" }],
		["B stronger than A", { aPeak: -45, bPeak: -20 }],
		["a protocol outside the set (NXDN)", { protocol: "nxdn96" }],
	])("applies the decode when %s", (_name, c) => {
		const { store, b, result } = adjacent(c)
		expect(result).not.toBeNull()
		expect(store.get(b)?.confidence).toBe("decoded")
	})

	// Feature: detection-quality, Property 7: Identity rule scope
	// Validates: Requirements 2.4
	it("refuses a decode only when every 2.4 condition holds", () => {
		const protocols: ScannerProtocol[] = [
			"dmr",
			"p25p1",
			"p25p2",
			"ysf",
			"pocsag",
			"nxdn96",
		]
		fc.assert(
			fc.property(
				fc.constantFrom(...protocols),
				fc.integer({ min: 3_000, max: 40_000 }),
				fc.boolean(),
				fc.integer({ min: -60, max: -10 }),
				fc.integer({ min: -25, max: 25 }),
				fc.integer({ min: -3_000, max: 6_000 }),
				(protocol, distance, above, aPeak, delta, bStartMs) => {
					const bPeak = aPeak + delta
					const { store, b, result } = adjacent({
						protocol,
						bOffsetHz: above ? distance : -distance,
						aPeak,
						bPeak,
						bStartMs,
					})
					// A spans [0, 1 000] ms; B's decode observation [s, s + 1 000] widened by 2 000.
					const overlaps =
						bStartMs - 2_000 <= 1_000 && bStartMs + 1_000 + 2_000 >= 0
					const refused =
						["dmr", "p25p1", "p25p2", "ysf"].includes(protocol) &&
						distance >= 6_000 &&
						distance <= 30_000 &&
						aPeak - bPeak >= 10 &&
						overlaps
					expect(result === null).toBe(refused)
					expect(store.get(b)?.confidence === "decoded").toBe(!refused)
				},
			),
			{ numRuns: 150 },
		)
	})

	it("never refuses the stronger record", () => {
		const store = newStore()
		// the weak record decodes first; the strong one 9.4 kHz away still takes its decode
		const weak = decodeOnNew(store, "w", F + 9_400, T0, -45, "dmr")
		expect(weak.result).not.toBeNull()
		const strong = decodeOnNew(store, "s", F, T0 + 200, -20, "dmr")
		expect(strong.result).not.toBeNull()
		expect(store.get(strong.discoveryId)?.confidence).toBe("decoded")
	})
})
