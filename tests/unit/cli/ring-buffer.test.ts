import fc from "fast-check"
import { describe, expect, it } from "vitest"
import type { AircraftState } from "@wavekit/api-types"
import {
	aircraftDelete,
	aircraftPrune,
	aircraftResync,
	aircraftUpsert,
	createRing,
	ringCloseGap,
	ringOpenGap,
	ringPush,
} from "../../../cli/source/data/ring-buffer.js"
import type {
	AircraftEntry,
	MessageEntry,
} from "../../../cli/source/data/types.js"

function entry(decoderId: string, at = 0): Omit<MessageEntry, "seq"> {
	return {
		decoderId,
		type: "t",
		receivedAt: at,
		output: { type: "t", decoder: decoderId, timestamp: "x", data: null },
		formatted: {
			protocol: "T",
			category: "other",
			segments: [],
			fields: [],
			emergency: false,
			searchText: "",
		},
	}
}

describe("message ring", () => {
	// Feature: cli-dashboard-overhaul, Property 9: message ring
	// Validates: spec §10.8
	it("P9: bounded, ordered, newest kept, per-decoder floor honoured", () => {
		fc.assert(
			fc.property(
				fc
					.integer({ min: 1, max: 20 })
					.chain(n =>
						fc.tuple(
							fc.constant(n),
							fc.array(fc.integer({ min: 0, max: n - 1 }), {
								minLength: 1,
								maxLength: 2500,
							}),
						),
					),
				([, picks]) => {
					const ring = createRing()
					const inserted = new Map<string, number[]>()
					let newest = -1
					for (const p of picks) {
						const id = `d${p}`
						const e = ringPush(ring, entry(id))
						newest = e.seq
						inserted.set(id, [...(inserted.get(id) ?? []), e.seq])
					}
					expect(ring.entries.length).toBeLessThanOrEqual(1000)
					for (let i = 1; i < ring.entries.length; i++) {
						expect(ring.entries[i]!.seq).toBeGreaterThan(
							ring.entries[i - 1]!.seq,
						)
					}
					expect(ring.entries.at(-1)?.seq).toBe(newest)
					for (const [id, seqs] of inserted) {
						const kept = ring.entries
							.filter(e => e.decoderId === id)
							.map(e => e.seq)
						expect(kept.length).toBeGreaterThanOrEqual(
							Math.min(seqs.length, 50),
						)
						expect(kept).toEqual(seqs.slice(seqs.length - kept.length))
					}
				},
			),
			{ numRuns: 100 },
		)
	})
	it("evicts the overall oldest when every decoder is at the floor", () => {
		const ring = createRing(4, 2)
		for (const id of ["a", "a", "b", "b", "c"]) ringPush(ring, entry(id))
		expect(ring.entries.map(e => e.decoderId)).toEqual(["a", "b", "b", "c"])
	})
})

describe("gaps", () => {
	it("opens after the newest seq and closes with from ≤ to", () => {
		const ring = createRing()
		ringPush(ring, entry("a"))
		ringOpenGap(ring, 5000)
		ringOpenGap(ring, 6000)
		expect(ring.gaps).toEqual([{ afterSeq: 0, from: 5000, to: null }])
		ringCloseGap(ring, 4000)
		expect(ring.gaps).toEqual([{ afterSeq: 0, from: 5000, to: 5000 }])
	})
	it("prunes gaps older than the oldest retained entry", () => {
		const ring = createRing(2, 1)
		ringPush(ring, entry("a"))
		ringOpenGap(ring, 1)
		ringCloseGap(ring, 2)
		for (let i = 0; i < 4; i++) ringPush(ring, entry(`x${i}`))
		expect(ring.gaps).toEqual([])
	})
	it("never prunes an open gap, so its close still lands", () => {
		const ring = createRing(2, 1)
		ringPush(ring, entry("a"))
		ringOpenGap(ring, 10)
		for (let i = 0; i < 4; i++) ringPush(ring, entry(`x${i}`))
		expect(ring.gaps).toEqual([{ afterSeq: 0, from: 10, to: null }])
		ringCloseGap(ring, 20)
		expect(ring.gaps).toEqual([{ afterSeq: 0, from: 10, to: 20 }])
	})
})

describe("aircraft map", () => {
	const ac = (
		icao: string,
		over: Partial<AircraftState> = {},
	): AircraftState => ({
		icao,
		seen: 0,
		messages: 1,
		firstSeen: 0,
		lastUpdated: 0,
		...over,
	})
	it("merges identification on update and keys by upper-case ICAO", () => {
		const map = new Map<string, AircraftEntry>()
		aircraftUpsert(
			map,
			ac("4ca9d2", { identification: { registration: "EI-DCL" } }),
			1,
		)
		aircraftUpsert(
			map,
			ac("4CA9D2", {
				callsign: "RYR4KT",
				identification: { typeCode: "B738" },
			}),
			2,
		)
		expect(map.get("4CA9D2")?.state).toMatchObject({
			callsign: "RYR4KT",
			identification: { registration: "EI-DCL", typeCode: "B738" },
		})
	})
	it("deletes by any-case ICAO, mutating the one map in place", () => {
		const map = new Map<string, AircraftEntry>()
		aircraftUpsert(map, ac("4ca9d2"), 1)
		const before = map
		aircraftDelete(map, "4ca9d2")
		expect(map).toBe(before)
		expect(map.size).toBe(0)
	})
	it("prunes after 300 s and resyncs wholesale", () => {
		const map = new Map<string, AircraftEntry>()
		aircraftUpsert(map, ac("a"), 0)
		aircraftUpsert(map, ac("b"), 200_000)
		expect(aircraftPrune(map, 300_001)).toBe(1)
		aircraftResync(map, [ac("c"), ac("d")], 400_000)
		expect([...map.keys()]).toEqual(["C", "D"])
	})
})
