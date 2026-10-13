import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	CTCSS_HZ,
	isCtcssToneHz,
} from "../../../../../src/core/audio-tones/ctcss.js"
import { ACTIVITY_RECORD_VERSION } from "../../../../../src/core/activity/storage/contract.js"
import type { AnalogTransmissionPayload } from "../../../../../src/core/activity/storage/contract.js"
import {
	buildActivityRow,
	parseStoredRecord,
	parseStoredSummary,
} from "../../../../../src/core/activity/storage/row.js"
import { WaveKitError } from "../../../../../src/utils/errors.js"

const SYMBOLS = [
	"0",
	"1",
	"2",
	"3",
	"4",
	"5",
	"6",
	"7",
	"8",
	"9",
	"*",
	"#",
	"A",
	"B",
	"C",
	"D",
] as const

function payload(
	patch: Partial<AnalogTransmissionPayload> = {},
): AnalogTransmissionPayload {
	return {
		transmissionId: "tx-446",
		sourceId: "rtl0",
		startedAt: "2026-10-13T12:00:00.000Z",
		endedAt: "2026-10-13T12:00:02.500Z",
		durationMs: 2_500,
		frequency: { hz: 446_006_250, tuningTrust: "commanded" },
		modulation: "nfm",
		bandwidthHz: 12_500,
		squelchMode: "manual",
		thresholdDbfs: -40,
		peakChannelPowerDbfs: -12.5,
		meanChannelPowerDbfs: -18,
		closeReason: "squelch",
		...patch,
	}
}

function store(body: AnalogTransmissionPayload) {
	const built = buildActivityRow({
		version: ACTIVITY_RECORD_VERSION,
		eventId: body.transmissionId,
		commitSeq: "0",
		producedAt: body.endedAt,
		receivedAt: "2026-10-13T12:00:02.600Z",
		kind: "analog-transmission",
		payload: body,
	})
	return {
		built,
		row: {
			seq: "9",
			event_id: built.eventId,
			kind: built.kind,
			summary_json: built.summaryJson,
			record_json: built.recordJson,
		},
	}
}

describe("analog transmission rows with tone", () => {
	it("keeps a tone-less summary and FTS byte-identical to a null tone", () => {
		const plain = store(payload())
		const nullTone = store(payload({ tone: { ctcssHz: null, dtmf: null } }))
		expect(nullTone.built.summaryJson).toBe(plain.built.summaryJson)
		expect(nullTone.built.ftsText).toBe(plain.built.ftsText)
		expect(nullTone.built.recordJson).not.toBe(plain.built.recordJson)
		expect(plain.built.recordBytes).toBe(
			Buffer.byteLength(plain.built.recordJson, "utf8"),
		)
		// A present tone is the only record-byte growth. Rows/day do not change.
		const withTone = store(payload({ tone: { ctcssHz: 100, dtmf: "12*#A" } }))
		expect(withTone.built.recordBytes - plain.built.recordBytes).toBe(38)
		expect(
			store(payload({ tone: { ctcssHz: null, dtmf: null } })).built
				.recordBytes - plain.built.recordBytes,
		).toBe(36)
	})

	it("adds CTCSS and DTMF fields and FTS terms only when present", () => {
		const { built, row } = store(
			payload({ tone: { ctcssHz: 100, dtmf: "12*#A" } }),
		)
		const summary = parseStoredSummary(row)
		expect(summary.fields.map(field => field.key)).toEqual([
			"durationMs",
			"modulation",
			"peakChannelPowerDbfs",
			"ctcssHz",
			"dtmf",
		])
		expect(summary.fields.find(field => field.key === "ctcssHz")).toEqual({
			key: "ctcssHz",
			label: "CTCSS",
			value: 100,
			unit: "Hz",
		})
		expect(summary.fields.find(field => field.key === "dtmf")).toEqual({
			key: "dtmf",
			label: "DTMF",
			value: "12*#A",
		})
		expect(built.ftsText).toContain("CTCSS 100")
		expect(built.ftsText).toContain("12*#A")
		const parsed = parseStoredRecord(row)
		expect(
			parsed.kind === "analog-transmission" && parsed.payload.tone,
		).toEqual({ ctcssHz: 100, dtmf: "12*#A" })
	})

	it("omits a null half of the tone from fields and FTS", () => {
		const ctcssOnly = store(payload({ tone: { ctcssHz: 254.1, dtmf: null } }))
		expect(
			parseStoredSummary(ctcssOnly.row).fields.map(field => field.key),
		).toEqual(["durationMs", "modulation", "peakChannelPowerDbfs", "ctcssHz"])
		expect(ctcssOnly.built.ftsText).toContain("CTCSS 254.1")
		expect(ctcssOnly.built.ftsText).not.toContain("DTMF")

		const dtmfOnly = store(payload({ tone: { ctcssHz: null, dtmf: "0" } }))
		expect(
			parseStoredSummary(dtmfOnly.row).fields.map(field => field.key),
		).toEqual(["durationMs", "modulation", "peakChannelPowerDbfs", "dtmf"])
		expect(dtmfOnly.built.ftsText).toContain("\n0")
		expect(dtmfOnly.built.ftsText).not.toContain("CTCSS")
	})

	it("rejects a malformed tone as corrupt", () => {
		const { built } = store(payload())
		const parsed = JSON.parse(built.recordJson) as {
			payload: Record<string, unknown>
		}
		const cases: unknown[] = [
			{ ...parsed.payload, tone: { ctcssHz: 100.1, dtmf: null } },
			{ ...parsed.payload, tone: { ctcssHz: 100, dtmf: "" } },
			{ ...parsed.payload, tone: { ctcssHz: 100, dtmf: "12a" } },
			{ ...parsed.payload, tone: { ctcssHz: 100, dtmf: "1".repeat(33) } },
			{ ...parsed.payload, tone: { ctcssHz: 100 } },
			{ ...parsed.payload, tone: { ctcssHz: 100, dtmf: null, extra: 1 } },
			{ ...parsed.payload, tone: null },
			{ ...parsed.payload, extra: 1 },
		]
		for (const body of cases) {
			const recordJson = JSON.stringify({ ...parsed, payload: body })
			expect(() =>
				parseStoredRecord({
					seq: "1",
					event_id: built.eventId,
					kind: "analog-transmission",
					summary_json: built.summaryJson,
					record_json: recordJson,
				}),
			).toThrow(WaveKitError)
			expect(() =>
				buildActivityRow({
					version: ACTIVITY_RECORD_VERSION,
					eventId: "tx-446",
					commitSeq: "0",
					producedAt: "2026-10-13T12:00:02.500Z",
					receivedAt: "2026-10-13T12:00:02.600Z",
					kind: "analog-transmission",
					payload: body as AnalogTransmissionPayload,
				}),
			).toThrow(WaveKitError)
		}
	})

	it("round-trips a payload with or without tone and rejects an invalid tone", () => {
		// Feature: web-gaps-2, Property 11: Transmission row with tone
		// Validates: Requirements 7.4, 7.5
		const toneArb = fc.record({
			ctcssHz: fc.option(fc.constantFrom(...CTCSS_HZ), { nil: null }),
			dtmf: fc.option(
				fc
					.array(fc.constantFrom(...SYMBOLS), {
						minLength: 1,
						maxLength: 32,
					})
					.map(chars => chars.join("")),
				{ nil: null },
			),
		})
		const baseArb = fc.record({
			transmissionId: fc.uuid(),
			sourceId: fc.string({ minLength: 1, maxLength: 24 }),
			durationMs: fc.integer({ min: 0, max: 60_000 }),
			hz: fc.option(fc.integer({ min: 1, max: 1_000_000_000 }), { nil: null }),
			modulation: fc.constantFrom(
				"nfm" as const,
				"am" as const,
				"usb" as const,
				"wfm" as const,
			),
			withTone: fc.boolean(),
			tone: toneArb,
		})
		fc.assert(
			fc.property(baseArb, value => {
				const body = payload({
					transmissionId: value.transmissionId,
					sourceId: value.sourceId,
					durationMs: value.durationMs,
					endedAt: new Date(
						Date.parse("2026-10-13T12:00:00.000Z") + value.durationMs,
					).toISOString(),
					frequency:
						value.hz === null
							? null
							: { hz: value.hz, tuningTrust: "commanded" },
					modulation: value.modulation,
					...(value.withTone ? { tone: value.tone } : {}),
				})
				const { built, row } = store(body)
				const parsed = parseStoredRecord(row)
				expect(parsed.kind).toBe("analog-transmission")
				if (parsed.kind !== "analog-transmission") return
				expect(parsed.payload).toEqual(body)
				const summary = parseStoredSummary(row)
				const ctcss = body.tone?.ctcssHz ?? null
				const dtmf = body.tone?.dtmf ?? null
				const ctcssField = summary.fields.find(field => field.key === "ctcssHz")
				const dtmfField = summary.fields.find(field => field.key === "dtmf")
				if (ctcss === null) expect(ctcssField).toBeUndefined()
				else {
					expect(ctcssField).toMatchObject({
						value: ctcss,
						unit: "Hz",
					})
					expect(built.ftsText).toContain(`CTCSS ${ctcss}`)
				}
				if (dtmf === null) expect(dtmfField).toBeUndefined()
				else {
					expect(dtmfField).toMatchObject({ value: dtmf })
					expect(built.ftsText).toContain(dtmf)
				}
			}),
			{ numRuns: 100 },
		)

		fc.assert(
			fc.property(
				fc
					.double({ min: -10, max: 400, noNaN: true })
					.filter(hz => !isCtcssToneHz(hz)),
				hz => {
					expect(() =>
						store(payload({ tone: { ctcssHz: hz, dtmf: "1" } })),
					).toThrow(WaveKitError)
				},
			),
			{ numRuns: 100 },
		)
	})
})
