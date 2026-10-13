import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { PositionCoalescer } from "../../../../../src/core/activity/storage/coalesce.js"
import {
	ACTIVITY_LIMIT_DEFAULTS,
	ACTIVITY_POSITION_COALESCE_MS,
} from "../../../../../src/core/activity/storage/limits.js"
import { envelope } from "./helpers.js"

const T0 = Date.parse("2026-10-13T00:00:00.000Z")
const iso = (ms: number) => new Date(ms).toISOString()

function aircraft(
	icao: string,
	at: number,
	extra: Record<string, string | number> = {},
) {
	return envelope({
		outputType: "aircraft",
		receivedAt: iso(at),
		decodedData: { icao, lat: 51, lon: 4, altitude: 35_000, ...extra },
	})
}

function offer(
	c: PositionCoalescer,
	env: ReturnType<typeof envelope>,
): boolean {
	const d = c.decide(env)
	if (d.store) d.commit()
	else c.noteCoalesced()
	return d.store
}

describe("position coalescing", () => {
	it("defaults to one position-only update per entity per 60 s", () => {
		expect(ACTIVITY_POSITION_COALESCE_MS).toBe(60_000)
		expect(ACTIVITY_LIMIT_DEFAULTS.positionCoalesceMs).toBe(60_000)
		const c = new PositionCoalescer(60_000, 100)
		const stored = [0, 1_000, 59_999, 60_000, 61_000, 120_000].map(dt =>
			offer(c, aircraft("abc123", T0 + dt)),
		)
		expect(stored).toEqual([true, false, false, true, false, true])
		expect(c.coalesced).toBe(3)
	})

	it("always stores identity changes and never coalesces other output types", () => {
		const c = new PositionCoalescer(60_000, 100)
		expect(offer(c, aircraft("abc123", T0))).toBe(true)
		expect(offer(c, aircraft("abc123", T0 + 1_000, { callsign: "UAL1" }))).toBe(
			true,
		)
		expect(offer(c, aircraft("abc123", T0 + 2_000, { callsign: "UAL1" }))).toBe(
			false,
		)
		// Absent identity fields on a position report are not a change.
		expect(offer(c, aircraft("abc123", T0 + 3_000))).toBe(false)
		expect(offer(c, aircraft("abc123", T0 + 4_000, { squawk: "7700" }))).toBe(
			true,
		)
		for (let i = 0; i < 5; i++)
			expect(
				offer(
					c,
					envelope({
						outputType: "page",
						receivedAt: iso(T0 + i),
						decodedData: { capcode: 1234 },
					}),
				),
			).toBe(true)
		const ship = (at: number, name?: string) =>
			envelope({
				outputType: "ship",
				receivedAt: iso(at),
				decodedData: {
					mmsi: "244660000",
					messageType: name ? 19 : 1,
					lat: 51,
					...(name ? { name } : {}),
				},
			})
		expect(offer(c, ship(T0))).toBe(true)
		expect(offer(c, ship(T0 + 1_000))).toBe(false)
		expect(offer(c, ship(T0 + 2_000, "EVER GIVEN"))).toBe(true)
	})

	it("coalesces bare presence but stores any field outside the allowlist", () => {
		const c = new PositionCoalescer(60_000, 100)
		const bare = (at: number) =>
			envelope({
				outputType: "aircraft",
				receivedAt: iso(at),
				decodedData: { icao: "abc123", lastSeen: iso(at), messageCount: 1 },
			})
		expect(offer(c, bare(T0))).toBe(true)
		expect(offer(c, bare(T0 + 1_000))).toBe(false) // Beast presence is redundant
		// An SBS identification report: a first callsign is new information.
		expect(offer(c, aircraft("abc123", T0 + 2_000, { callsign: "UAL1" }))).toBe(
			true,
		)
		// Extra fields the allowlist does not know are stored.
		expect(offer(c, aircraft("abc123", T0 + 3_000, { nic: 8 }))).toBe(true)
		expect(
			offer(
				c,
				aircraft("abc123", T0 + 4_000, { callsign: "UAL1", type: "adsb_icao" }),
			),
		).toBe(true)
		expect(offer(c, aircraft("abc123", T0 + 5_000, { callsign: "UAL1" }))).toBe(
			false,
		)
	})

	it("stores every AIS message type other than position reports", () => {
		const c = new PositionCoalescer(60_000, 100)
		const ais = (messageType: number, at: number) =>
			envelope({
				outputType: "ship",
				receivedAt: iso(at),
				decodedData: { mmsi: "244660000", messageType, lat: 51, lon: 4 },
			})
		expect(offer(c, ais(1, T0))).toBe(true)
		expect(offer(c, ais(1, T0 + 1_000))).toBe(false)
		expect(offer(c, ais(18, T0 + 2_000))).toBe(false)
		expect(offer(c, ais(27, T0 + 2_500))).toBe(false)
		for (const [i, type] of [14, 6, 8, 12, 9, 21, 5, 24, 4].entries())
			expect(offer(c, ais(type, T0 + 3_000 + i))).toBe(true)
		// A report without a message type cannot be shown redundant.
		expect(
			offer(
				c,
				envelope({
					outputType: "ship",
					receivedAt: iso(T0 + 4_000),
					decodedData: { mmsi: "244660000", lat: 51 },
				}),
			),
		).toBe(true)
	})

	it("undoes a commit whose write failed, unless a later reception replaced it", () => {
		const c = new PositionCoalescer(60_000, 100)
		const undo = c.decide(aircraft("abc123", T0, { callsign: "UAL1" })).commit()
		undo()
		expect(offer(c, aircraft("abc123", T0 + 1_000, { callsign: "UAL1" }))).toBe(
			true,
		)
		const stale = c.decide(aircraft("abc123", T0 + 70_000)).commit()
		expect(offer(c, aircraft("abc123", T0 + 71_000, { squawk: "1200" }))).toBe(
			true,
		)
		stale() // superseded: keeps the later state
		expect(offer(c, aircraft("abc123", T0 + 72_000, { squawk: "1200" }))).toBe(
			false,
		)
	})

	it("does not record a reception whose row was not admitted", () => {
		const c = new PositionCoalescer(60_000, 100)
		expect(c.decide(aircraft("abc123", T0)).store).toBe(true) // rejected later: no commit
		expect(offer(c, aircraft("abc123", T0 + 1_000))).toBe(true)
	})

	it("is off with a zero window", () => {
		const c = new PositionCoalescer(0, 100)
		for (let i = 0; i < 3; i++)
			expect(offer(c, aircraft("a", T0 + i))).toBe(true)
	})

	// Feature: web-gaps-1, Property 11: Position coalescing
	// Validates: Requirements 7.6, 7.7, 7.9
	it("stores first sightings, identity changes, informative fields and one update per window, within the entity bound", () => {
		const step = fc.record({
			dt: fc.integer({ min: 0, max: 30_000 }),
			icao: fc.constantFrom("a1", "a2", "a3", "a4", "a5"),
			callsign: fc.option(fc.constantFrom("UAL1", "DLH2"), { nil: undefined }),
			extra: fc.boolean(),
		})
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 4 }),
				fc.array(step, { maxLength: 150 }),
				(maxEntities, steps) => {
					const window = 60_000
					const c = new PositionCoalescer(window, maxEntities)
					// Reference model with the same LRU bound.
					const model = new Map<string, { at: number; callsign?: string }>()
					let t = T0
					for (const s of steps) {
						t += s.dt
						const extra: Record<string, string | number> = {
							...(s.callsign === undefined ? {} : { callsign: s.callsign }),
							...(s.extra ? { nic: 7 } : {}),
						}
						const got = offer(c, aircraft(s.icao, t, extra))
						const prev = model.get(s.icao)
						const expected =
							prev === undefined ||
							s.extra ||
							t - prev.at >= window ||
							(s.callsign !== undefined && s.callsign !== prev.callsign)
						expect(got).toBe(expected)
						if (expected) {
							model.delete(s.icao)
							model.set(s.icao, {
								at: t,
								...((s.callsign ?? prev?.callsign) !== undefined
									? { callsign: (s.callsign ?? prev?.callsign) as string }
									: {}),
							})
							for (const k of model.keys()) {
								if (model.size <= maxEntities) break
								model.delete(k)
							}
						}
						expect(c.size()).toBeLessThanOrEqual(maxEntities)
					}
				},
			),
			{ numRuns: 100 },
		)
	})
})
