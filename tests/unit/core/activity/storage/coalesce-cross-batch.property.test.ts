import fc from "fast-check"
import pino from "pino"
import { describe, expect, it } from "vitest"
import { ActivityIngress } from "../../../../../src/core/activity/storage/ingress.js"
import { ACTIVITY_LIMIT_DEFAULTS } from "../../../../../src/core/activity/storage/limits.js"
import type { DecodeEnvelope } from "../../../../../src/core/activity/types.js"
import { envelope } from "./helpers.js"

const WINDOW_MS = 60_000
const T0 = Date.parse("2026-10-13T00:00:00.000Z")

function ingress(): ActivityIngress {
	return new ActivityIngress(
		{
			...ACTIVITY_LIMIT_DEFAULTS,
			positionCoalesceMs: WINDOW_MS,
			positionCoalesceMaxEntities: 1_000,
			globalRatePerSec: 1e9,
			globalBurst: 1e9,
			decoderRatePerSec: 1e9,
			decoderBurst: 1e9,
			queueMaxItems: 1e6,
			queueMaxBytes: 1e12,
			gapQuietMs: 1e12,
			gapMaxIntervalMs: 1e12,
		},
		() => T0,
		pino({ level: "silent" }),
	)
}

function aircraft(
	eventId: string,
	at: number,
	icao: string,
	callsign: string | undefined,
	informative: boolean,
): DecodeEnvelope {
	const decodedData: Record<string, string | number> = { icao, lat: 51, lon: 4 }
	if (callsign !== undefined) decodedData["callsign"] = callsign
	if (informative) decodedData["registration"] = "G-ABCD"
	return envelope({
		eventId,
		receivedAt: new Date(at).toISOString(),
		decodedData,
	})
}

type Status = "pending" | "stored" | "failed"
interface ModelRow {
	eventId: string
	icao: string
	at: number
	callsign: string | undefined
	status: Status
}

/** WG1 rule over the rows that have not failed (stored, queued or in flight). */
function modelStores(
	rows: readonly ModelRow[],
	icao: string,
	at: number,
	callsign: string | undefined,
	informative: boolean,
): boolean {
	const kept = rows.filter(row => row.icao === icao && row.status !== "failed")
	const last = kept.at(-1)
	if (last === undefined) return true
	const known = kept.filter(row => row.callsign !== undefined).at(-1)?.callsign
	const changed = callsign !== undefined && callsign !== known
	const due = at - last.at >= WINDOW_MS || at < last.at
	return informative || changed || due
}

const admitArb = fc.record({
	icao: fc.constantFrom("abcdef", "abcdef", "123456"),
	callsign: fc.constantFrom(undefined, "BAD", "GOOD"),
	informative: fc.boolean(),
	dt: fc.oneof(
		fc.integer({ min: 0, max: 5_000 }),
		fc.integer({ min: -5_000, max: 70_000 }),
	),
})

/**
 * One writer round: take the next batch, admit receptions while it is in
 * flight (they queue behind it, the cross-batch case), then settle the batch.
 */
const roundArb = fc.record({
	admits: fc.array(admitArb, { maxLength: 3 }),
	outcome: fc.oneof(
		fc.constant({ kind: "succeed" as const }),
		fc.constant({ kind: "fail" as const }),
		fc.constant({ kind: "keep" as const }),
		fc.record({
			kind: fc.constant("partial" as const),
			mask: fc.array(fc.boolean(), { minLength: 1, maxLength: 4 }),
		}),
	),
})

function flightRows(
	store: ActivityIngress,
): Parameters<ActivityIngress["noteSkipped"]>[0] {
	return (
		store as unknown as {
			inFlight: Parameters<ActivityIngress["noteSkipped"]>[0]
		}
	).inFlight
}

describe("coalescing rollback across batches", () => {
	it("does not let a failed row's identity return through a later row's undo", () => {
		const store = ingress()
		const a = aircraft("a", T0, "abcdef", "BAD", false)
		expect(store.admit(a).admitted).toBe(true)
		expect(store.takeBatch(10, 1e9).map(row => row.eventId)).toEqual(["a"])
		const c = aircraft("c", T0 + 1_000, "abcdef", "BAD", true)
		expect(store.admit(c).admitted).toBe(true)
		store.nack()
		expect(store.takeBatch(10, 1e9).map(row => row.eventId)).toEqual(["c"])
		store.nack()
		const retry = aircraft("r", T0 + 2_000, "abcdef", "BAD", false)
		expect(store.admit(retry).admitted).toBe(true)
	})

	// Feature: web-gaps-2, Property 4: APRS and mesh coalescing (failed writes roll back as in WG1 7.9)
	// Validates: Requirements 2.4 (WG1 7.6, 7.9)
	it("coalesces a reception only when a row of that entity that has not failed covers it", () => {
		fc.assert(
			fc.property(
				fc.array(roundArb, { minLength: 1, maxLength: 12 }),
				rounds => {
					const store = ingress()
					const rows: ModelRow[] = []
					let inFlight: string[] = []
					let at = T0
					let seq = 0
					const mark = (ids: readonly string[], status: Status) => {
						for (const row of rows)
							if (ids.includes(row.eventId)) row.status = status
					}
					for (const round of rounds) {
						const batch = store.takeBatch(4, 1e12)
						if (batch.length > 0) inFlight = batch.map(row => row.eventId)
						for (const s of round.admits) {
							at += s.dt
							const eventId = `e-${seq++}`
							const expected = modelStores(
								rows,
								s.icao,
								at,
								s.callsign,
								s.informative,
							)
							const result = store.admit(
								aircraft(eventId, at, s.icao, s.callsign, s.informative),
							)
							expect(result.admitted).toBe(expected)
							if (result.admitted) {
								rows.push({
									eventId,
									icao: s.icao,
									at,
									callsign: s.callsign,
									status: "pending",
								})
								continue
							}
							expect(result.reason).toBe("coalesced")
							// Coalesced only when a row of the entity that has not failed
							// (written, queued or in flight) is inside the window.
							expect(
								rows.some(
									row =>
										row.icao === s.icao &&
										row.status !== "failed" &&
										at >= row.at &&
										at - row.at < WINDOW_MS,
								),
							).toBe(true)
						}
						const outcome = round.outcome
						if (outcome.kind === "keep" || inFlight.length === 0) continue
						if (outcome.kind === "succeed") {
							store.ack(new Set(inFlight))
							mark(inFlight, "stored")
						} else if (outcome.kind === "fail") {
							store.nack()
							mark(inFlight, "failed")
						} else {
							const failed = inFlight.filter(
								(_id, i) => outcome.mask[i] === true,
							)
							const written = inFlight.filter(id => !failed.includes(id))
							store.noteSkipped(
								batch.length > 0 ? batch : flightRows(store),
								failed,
							)
							store.ack(new Set(written))
							mark(failed, "failed")
							mark(written, "stored")
						}
						inFlight = []
					}
				},
			),
			{
				numRuns: 300,
				examples: [
					[
						[
							{
								admits: [
									{
										icao: "abcdef",
										callsign: "BAD",
										informative: false,
										dt: 0,
									},
								],
								outcome: { kind: "keep" },
							},
							{
								admits: [
									{
										icao: "abcdef",
										callsign: "BAD",
										informative: true,
										dt: 1_000,
									},
								],
								outcome: { kind: "fail" },
							},
							{ admits: [], outcome: { kind: "fail" } },
							{
								admits: [
									{
										icao: "abcdef",
										callsign: "BAD",
										informative: false,
										dt: 1_000,
									},
								],
								outcome: { kind: "keep" },
							},
						],
					],
				],
			},
		)
	})
})
