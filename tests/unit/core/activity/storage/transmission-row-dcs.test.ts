import { DatabaseSync } from "node:sqlite"
import { DCS_STANDARD_CODES } from "@wavekit/api-types"
import { describe, expect, it } from "vitest"
import { ACTIVITY_RECORD_VERSION } from "../../../../../src/core/activity/storage/contract.js"
import type { AnalogTransmissionPayload } from "../../../../../src/core/activity/storage/contract.js"
import {
	buildActivityRow,
	parseStoredRecord,
	parseStoredSummary,
} from "../../../../../src/core/activity/storage/row.js"
import { WaveKitError } from "../../../../../src/utils/errors.js"

type Dcs = { code: string; polarity: "normal" | "inverted" }

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

const withDcs = (dcs: Dcs | null): AnalogTransmissionPayload =>
	payload({ tone: { ctcssHz: null, dtmf: null, dcs } })

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

const bytes = (text: string): number => Buffer.byteLength(text, "utf8")
/** Everything the row persists for the transmission. */
const rowBytes = (built: ReturnType<typeof store>["built"]): number =>
	bytes(built.recordJson) + bytes(built.summaryJson) + bytes(built.ftsText)

describe("analog transmission rows with DCS", () => {
	it("stores, shows and indexes a DCS code with its twin", () => {
		const { built, row } = store(withDcs({ code: "023", polarity: "normal" }))
		const summary = parseStoredSummary(row)
		expect(summary.fields.map(field => field.key)).toEqual([
			"durationMs",
			"modulation",
			"peakChannelPowerDbfs",
			"dcs",
		])
		expect(summary.fields.find(field => field.key === "dcs")).toEqual({
			key: "dcs",
			label: "DCS",
			value: "023N",
		})
		expect(built.ftsText).toContain("DCS 023N")
		expect(built.ftsText).toContain("DCS 047I")
		const parsed = parseStoredRecord(row)
		expect(
			parsed.kind === "analog-transmission" && parsed.payload.tone,
		).toEqual({
			ctcssHz: null,
			dtmf: null,
			dcs: { code: "023", polarity: "normal" },
		})
		const inverted = store(withDcs({ code: "047", polarity: "inverted" }))
		expect(inverted.built.ftsText).toContain("DCS 047I")
		expect(inverted.built.ftsText).toContain("DCS 023N")
	})

	it("places DCS after DTMF", () => {
		const { row } = store(
			payload({
				tone: {
					ctcssHz: 100,
					dtmf: "12",
					dcs: { code: "023", polarity: "inverted" },
				},
			}),
		)
		expect(parseStoredSummary(row).fields.map(field => field.key)).toEqual([
			"durationMs",
			"modulation",
			"peakChannelPowerDbfs",
			"ctcssHz",
			"dtmf",
			"dcs",
		])
	})

	it("gives every standard code a twin that points back", () => {
		for (const code of DCS_STANDARD_CODES) {
			const normal = store(withDcs({ code, polarity: "normal" })).built.ftsText
			const lines = normal.split("\n").filter(line => line.startsWith("DCS "))
			expect(lines, code).toHaveLength(2)
			const twin = lines[1]?.slice(4, 7) ?? ""
			expect(DCS_STANDARD_CODES, code).toContain(twin)
			expect(lines[1]?.endsWith("I")).toBe(true)
			const back = store(withDcs({ code: twin, polarity: "inverted" })).built
				.ftsText
			expect(back).toContain(`DCS ${code}N`)
		}
	})

	it("finds the row under either spelling through FTS5", () => {
		const { built } = store(withDcs({ code: "023", polarity: "normal" }))
		const db = new DatabaseSync(":memory:")
		db.exec(
			"CREATE VIRTUAL TABLE f USING fts5 (text, content = '', contentless_delete = 1, tokenize = 'unicode61 remove_diacritics 2')",
		)
		db.prepare("INSERT INTO f (rowid, text) VALUES (1, ?)").run(built.ftsText)
		for (const q of ['"023N"', '"047I"', '"DCS 023N"', '"DCS 047I"']) {
			const hits = db.prepare("SELECT rowid FROM f WHERE f MATCH ?").all(q) as {
				rowid: number
			}[]
			expect(
				hits.map(h => h.rowid),
				q,
			).toEqual([1])
		}
		expect(
			db.prepare("SELECT rowid FROM f WHERE f MATCH ?").all('"023I"'),
		).toEqual([])
		db.close()
	})

	it("reads old rows without a dcs key back unchanged", () => {
		const old = store(payload({ tone: { ctcssHz: 100, dtmf: "1" } }))
		const parsed = parseStoredRecord(old.row)
		expect(
			parsed.kind === "analog-transmission" && parsed.payload.tone,
		).toEqual({ ctcssHz: 100, dtmf: "1" })
		expect(
			parsed.kind === "analog-transmission" &&
				Object.keys(parsed.payload.tone ?? {}),
		).toEqual(["ctcssHz", "dtmf"])
		const none = store(withDcs(null))
		const plain = store(payload())
		expect(none.built.summaryJson).toBe(plain.built.summaryJson)
		expect(none.built.ftsText).toBe(plain.built.ftsText)
		const nullParsed = parseStoredRecord(none.row)
		expect(
			nullParsed.kind === "analog-transmission" && nullParsed.payload.tone,
		).toEqual({ ctcssHz: null, dtmf: null, dcs: null })
	})

	it("rejects malformed dcs as corrupt without echoing the value", () => {
		const { built } = store(payload())
		const parsed = JSON.parse(built.recordJson) as {
			payload: Record<string, unknown>
		}
		const secret = "SECRET-8xx"
		const dcsCases: unknown[] = [
			{ code: "8xx", polarity: "normal" },
			{ code: "23", polarity: "normal" },
			{ code: "0123", polarity: "normal" },
			{ code: "024", polarity: "normal" },
			{ code: "023", polarity: "normal", extra: 1 },
			{ code: "023" },
			{ code: "023", polarity: "reversed" },
			{ code: "023", polarity: secret },
			{ code: 23, polarity: "normal" },
			{ code: secret, polarity: "normal" },
			["023", "normal"],
			"023N",
			undefined,
		]
		for (const dcs of dcsCases) {
			const tone = { ctcssHz: null, dtmf: null, dcs }
			const body = { ...parsed.payload, tone }
			const recordJson = JSON.stringify({ ...parsed, payload: body })
			const attempts = [
				() =>
					parseStoredRecord({
						seq: "1",
						event_id: built.eventId,
						kind: "analog-transmission",
						summary_json: built.summaryJson,
						record_json: recordJson,
					}),
				() =>
					buildActivityRow({
						version: ACTIVITY_RECORD_VERSION,
						eventId: "tx-446",
						commitSeq: "0",
						producedAt: "2026-10-13T12:00:02.500Z",
						receivedAt: "2026-10-13T12:00:02.600Z",
						kind: "analog-transmission",
						payload: { ...body, tone } as AnalogTransmissionPayload,
					}),
			]
			for (const attempt of attempts) {
				let caught: unknown
				try {
					attempt()
				} catch (error) {
					caught = error
				}
				// `undefined` serializes to a missing key on the read side (valid old shape).
				if (dcs === undefined) continue
				expect(caught).toBeInstanceOf(WaveKitError)
				expect(
					JSON.stringify(caught) + String((caught as Error).message),
				).not.toContain("SECRET")
			}
		}
	})
})

describe("DCS row golden bytes (requirement 4.10)", () => {
	const none = store(payload()).built
	const nullDcs = store(
		payload({ tone: { ctcssHz: null, dtmf: null, dcs: null } }),
	).built
	const noKey = store(payload({ tone: { ctcssHz: null, dtmf: null } })).built
	const coded = store(withDcs({ code: "023", polarity: "normal" })).built
	const longest = store(
		withDcs({ code: DCS_STANDARD_CODES.at(-1) ?? "", polarity: "inverted" }),
	).built

	it("pins the growth of a null dcs over an absent key", () => {
		const delta = rowBytes(nullDcs) - rowBytes(noKey)
		expect(delta).toBe(11)
		expect(delta).toBeLessThanOrEqual(12)
		expect(nullDcs.summaryJson).toBe(none.summaryJson)
	})

	it("pins the growth of a coded row over an absent key", () => {
		const delta = rowBytes(coded) - rowBytes(noKey)
		// record 41 + summary field 43 + FTS 18 (two lines of "\nDCS 023N")
		expect(delta).toBe(102)
		expect(delta).toBeLessThanOrEqual(128)
		expect(rowBytes(longest) - rowBytes(noKey)).toBe(104)
	})
})
