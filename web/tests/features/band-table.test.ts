import fc from "fast-check"
import { describe, expect, it } from "vitest"
import type { DecoderInfo } from "@wavekit/api-types"
import { DECODER_VERDICT_CODES } from "@wavekit/api-types"

import {
	activityChipFor,
	bandStateLine,
	bandTable,
	cardIdentity,
	detailOf,
	NAME_MAX_LENGTH,
	parseSummary,
	relevant,
	settingsTarget,
	stateOf,
	STATE_WORD,
	summaryPath,
	type BandTableRow,
} from "../../src/features/tuned/band-table.ts"
import { TUNED_CASE_NOW, TUNED_CASES } from "../../mock/tuned-cases.ts"

const NO_SCAN = { scanJobId: null, budget: null }

const caseById = (id: string) => {
	const c = TUNED_CASES.find(x => x.id === id)
	if (!c) throw new Error(`no case ${id}`)
	return c
}
const rowsOf = (id: string) => {
	const c = caseById(id)
	return bandTable(
		parseSummary(c.summary),
		c.decoders,
		c.hz,
		NO_SCAN,
		TUNED_CASE_NOW,
	)
}

describe("tuned card cases", () => {
	it.each(TUNED_CASES.map(c => [c.id, c] as const))(
		"%s: lists only the decoders whose band holds the frequency",
		(_id, c) => {
			const rows = bandTable(
				parseSummary(c.summary),
				c.decoders,
				c.hz,
				NO_SCAN,
				TUNED_CASE_NOW,
			)
			expect(rows.map(r => [r.id, r.stateWord])).toEqual(c.expect.rows)
			const identity = cardIdentity({
				heard: null,
				named: c.named,
				rows,
				band: c.band?.name ?? null,
				channel: null,
				modeLabel: "NFM",
			})
			expect(identity.proto).toBe(c.expect.proto)
		},
	)

	it("never names the pager at 1090 MHz, though its VFO channel sits there", () => {
		for (const id of ["adsb-paused", "adsb-running"]) {
			const rows = rowsOf(id)
			expect(rows.map(r => r.name)).toEqual(["ADS-B"])
			expect(bandStateLine(rows)).toMatch(/^ADS-B · /)
		}
	})

	it("offers the budget raise for a paused ADS-B, never a Settings link in the row", () => {
		const [row] = rowsOf("adsb-paused")
		expect(row).toMatchObject({
			state: "paused",
			detail: "CPU budget full",
			action: { kind: "raise-budget", label: "Raise CPU budget" },
		})
		expect(row?.lastDecode.startsWith("at ")).toBe(true)
		expect(row?.activityChip).toBe("aircraft")
	})

	it("says how much a decoding decoder decoded, and links its last decode to Activity", () => {
		const [row] = rowsOf("adsb-running")
		expect(row).toMatchObject({
			state: "decoding",
			detail: "1,204 messages so far",
			lastDecode: "2 s ago",
			activityChip: "aircraft",
			action: null,
		})
	})

	it("offers no Restart while the core restarts a decoder on its own", () => {
		const [row] = rowsOf("pager-restarting")
		expect(row).toMatchObject({
			state: "failed",
			detail: "Restarting on its own",
			action: null,
			lastDecode: "Never",
			activityChip: null,
		})
	})

	it("lists nothing on an unknown frequency; a proven discovery still names it", () => {
		expect(rowsOf("unknown")).toEqual([])
		expect(rowsOf("discovery-proof")).toEqual([])
		const c = caseById("discovery-proof")
		expect(
			cardIdentity({
				heard: null,
				named: c.named,
				rows: [],
				band: null,
				channel: null,
				modeLabel: "NFM",
			}),
		).toEqual({ proto: "DMR", sub: "CC 1 · slot 2" })
	})
})

describe("header identity", () => {
	const base = {
		heard: null,
		named: null,
		rows: [],
		band: null,
		channel: null,
		modeLabel: null,
	}
	it("prefers what was heard, then what was named, then the covering decoder, then the band", () => {
		const rows = [{ name: "ADS-B", state: "decoding" as const }]
		expect(
			cardIdentity({ ...base, heard: "ADS-B", rows, band: "ADS-B 1090" }),
		).toEqual({ proto: "ADS-B", sub: "ADS-B 1090" })
		expect(
			cardIdentity({ ...base, named: { proto: "DMR", sub: "" }, rows }).proto,
		).toBe("DMR")
		expect(cardIdentity({ ...base, rows, band: "ADS-B 1090" })).toEqual({
			proto: "ADS-B",
			sub: "ADS-B 1090",
		})
		// the band names it once, not twice
		expect(
			cardIdentity({ ...base, band: "ADS-B 1090", modeLabel: "RAW" }),
		).toEqual({ proto: "ADS-B 1090", sub: "" })
		expect(cardIdentity({ ...base, modeLabel: "NFM" }).proto).toBe("NFM")
		expect(cardIdentity(base).proto).toBe("Unknown")
	})

	it("names an off decoder only without a band, and says it is off", () => {
		const off = [{ name: "Pager", state: "off" as const }]
		expect(
			cardIdentity({ ...base, rows: off, band: "Paging", channel: "Ch 1" }),
		).toEqual({ proto: "Paging", sub: "Ch 1" })
		expect(cardIdentity({ ...base, rows: off, modeLabel: "NFM" })).toEqual({
			proto: "Pager (off)",
			sub: "",
		})
		// a decoder that is on but held back still names it
		expect(
			cardIdentity({
				...base,
				rows: [{ name: "Pager", state: "paused" as const }],
				band: "Paging",
			}),
		).toEqual({ proto: "Pager", sub: "Paging" })
		// what was heard or named still comes first
		expect(
			cardIdentity({ ...base, rows: off, heard: "POCSAG", band: "Paging" })
				.proto,
		).toBe("POCSAG")
	})
})

describe("summary items", () => {
	it("reads leniently: no id, program or verdict leaves an item out; bad fields read safe", () => {
		const items = parseSummary([
			{
				id: "a",
				protocol: "readsb",
				verdict: { code: "decoding", text: "ADS-B decoding", actions: [] },
				lastOutputAt: "not a time",
				eventsOut: -3,
				coversHz: "yes",
			},
			{ id: "b", protocol: "x" },
			{ protocol: "x", verdict: { code: "decoding", text: "x", actions: [] } },
			"junk",
		])
		expect(items).toEqual([
			{
				id: "a",
				name: "ADS-B",
				protocol: "readsb",
				verdict: { code: "decoding", text: "ADS-B decoding", actions: [] },
				lastOutputAt: null,
				eventsOut: 0,
				coversHz: null,
			},
		])
		expect(parseSummary({ not: "a list" })).toBeNull()
	})

	it(`caps a name at ${NAME_MAX_LENGTH} code units`, () => {
		const item = (name: string) =>
			parseSummary([
				{
					id: "a",
					name,
					protocol: "p",
					verdict: { code: "decoding", text: "x", actions: [] },
				},
			])?.[0]?.name
		const at = "n".repeat(NAME_MAX_LENGTH)
		expect(item(at)).toBe(at)
		expect(item(`${at}x`)).toBe(at)
	})

	it("trusts the core's coversHz, and the band rule only from an older core", () => {
		const vfo: DecoderInfo = {
			id: "pager",
			type: "multimon-ng",
			running: true,
			health: "running",
			uptime: 1,
			stats: { bytesIn: 0, eventsOut: 0, errors: 0 },
			restartCount: 0,
			targetFrequenciesHz: [1_090_062_000],
			bandAssessment: { verdict: "in-band", targetsHz: [466_000_000] },
		}
		expect(relevant({ id: "pager", coversHz: false }, vfo, 1_090_062_000)).toBe(
			false,
		)
		expect(relevant({ id: "pager", coversHz: true }, null, 1_090_062_000)).toBe(
			true,
		)
		expect(relevant({ id: "pager", coversHz: null }, vfo, 1_090_062_000)).toBe(
			false,
		)
		expect(relevant({ id: "pager", coversHz: null }, vfo, 466_050_000)).toBe(
			true,
		)
		expect(relevant({ id: "gone", coversHz: null }, null, 466_050_000)).toBe(
			false,
		)
	})

	it("reads statuses when the core has no summary, without actions", () => {
		const c = caseById("adsb-paused")
		const rows = bandTable(null, c.decoders, c.hz, NO_SCAN, TUNED_CASE_NOW)
		expect(rows.map(r => r.id)).toEqual(["readsb"])
		expect(rows[0]?.action).toBeNull()
	})

	it("never lists a scanner probe", () => {
		const c = caseById("adsb-running")
		const probe = { ...c.decoders[0]!, owner: "scanner" as const }
		expect(
			bandTable(
				parseSummary(c.summary),
				[probe],
				c.hz,
				NO_SCAN,
				TUNED_CASE_NOW,
			),
		).toEqual([])
	})
})

describe("row wording", () => {
	it("gives every verdict code one state word", () => {
		for (const code of DECODER_VERDICT_CODES)
			expect(Object.keys(STATE_WORD)).toContain(stateOf(code))
		expect(stateOf("efficiency-budget")).toBe("paused")
		expect(stateOf("efficiency-waiting")).toBe("waiting")
		expect(stateOf("out-of-band")).toBe("waiting")
		expect(stateOf("stopped")).toBe("off")
	})

	it("drops the name and a repeated state word from the detail", () => {
		expect(
			detailOf("ADS-B paused: CPU budget full", "ADS-B", "paused", 0),
		).toBe("CPU budget full")
		expect(
			detailOf(
				"Pager listening: nothing decoded in the last minute",
				"Pager",
				"listening",
				0,
			),
		).toBe("Nothing decoded in the last minute")
		expect(detailOf("ADS-B decoding", "ADS-B", "decoding", 1)).toBe(
			"1 message so far",
		)
		expect(detailOf("ADS-B starting", "ADS-B", "starting", 9)).toBe("")
		expect(detailOf("ADS-B off in Settings", "ADS-B", "off", 0)).toBe(
			"Off in Settings",
		)
		expect(detailOf("Decoder status unknown", "Thing", "unknown", 0)).toBe("")
	})

	it("keeps a reason the state word runs into, and drops one that only restates the state", () => {
		expect(
			detailOf("ADS-B waiting for the source", "ADS-B", "waiting", 0),
		).toBe("Waiting for the source")
		expect(
			detailOf("ADS-B waiting for the source to settle", "ADS-B", "waiting", 0),
		).toBe("Waiting for the source to settle")
		expect(detailOf("ADS-B failed to run", "ADS-B", "failed", 0)).toBe("")
		expect(
			detailOf("ADS-B failed: restarting on its own", "ADS-B", "failed", 0),
		).toBe("Restarting on its own")
		expect(detailOf("ADS-B running", "ADS-B", "listening", 0)).toBe("")
		expect(detailOf("ADS-B running", "ADS-B", "listening", 2)).toBe(
			"2 messages so far",
		)
		expect(detailOf("ADS-B stopped", "ADS-B", "off", 0)).toBe("Stopped")
		expect(detailOf("ADS-B paused", "ADS-B", "unknown", 0)).toBe("Paused")
	})

	it("maps programs to Activity's category chips", () => {
		expect(activityChipFor("readsb")).toBe("aircraft")
		expect(activityChipFor("multimon-ng")).toBe("paging")
		expect(activityChipFor("not-a-program")).toBeNull()
	})

	it("sends the foot's link to a decoder that is off, else the first row", () => {
		const row = (id: string, state: BandTableRow["state"]) =>
			({ id, state }) as BandTableRow
		expect(settingsTarget([row("a", "decoding"), row("b", "off")])).toBe(
			"dec.b",
		)
		expect(settingsTarget([row("a", "paused")])).toBe("dec.a")
		expect(settingsTarget([])).toBe("dec.cpuBudgetCores")
	})

	it("asks the summary for a frequency only when it is a usable one", () => {
		expect(summaryPath(1_090_062_000.4)).toBe(
			"/api/decoders/summary?hz=1090062000",
		)
		expect(summaryPath(null)).toBe("/api/decoders/summary")
		expect(summaryPath(Number.NaN)).toBe("/api/decoders/summary")
		expect(summaryPath(-1)).toBe("/api/decoders/summary")
	})
})

// Feature: tuned-card-band-table, Property 1: the table lists exactly the covering decoders
// Validates: Requirements 2, 3, 7
it("lists exactly the items the core says cover the frequency, each with one known state and at most one non-Settings action", () => {
	const code = fc.oneof(
		fc.constantFrom(...DECODER_VERDICT_CODES),
		fc.string({ maxLength: 12 }),
	)
	const action = fc.oneof(
		fc.constantFrom(
			"start",
			"restart",
			"turn-on",
			"turn-off-others",
			"raise-budget",
		),
		fc.string({ maxLength: 8 }),
	)
	const item = fc.record({
		id: fc.string({ minLength: 1, maxLength: 6 }),
		protocol: fc.constantFrom("readsb", "multimon-ng", "dsd-fme", "zzz"),
		verdict: fc.record({
			code,
			text: fc.string({ minLength: 1, maxLength: 40 }),
			actions: fc.array(action, { maxLength: 4 }),
		}),
		coversHz: fc.option(fc.boolean(), { nil: undefined }),
		lastOutputAt: fc.option(
			fc.date({ noInvalidDate: true }).map(d => d.toISOString()),
			{
				nil: null,
			},
		),
		eventsOut: fc.integer({ min: -5, max: 10_000 }),
	})
	fc.assert(
		fc.property(fc.array(item, { maxLength: 8 }), body => {
			const items = parseSummary(body) ?? []
			const decoders: DecoderInfo[] = items.map(i => ({
				id: i.id,
				type: i.protocol,
				running: true,
				health: "running",
				uptime: 1,
				stats: { bytesIn: 0, eventsOut: 0, errors: 0 },
				restartCount: 0,
				targetFrequenciesHz: [1_090_000_000],
			}))
			const rows = bandTable(items, decoders, 1_090_000_000, NO_SCAN, 0)
			const covering = items.filter(i => i.coversHz === true).length
			const legacy = items.filter(i => i.coversHz === null).length
			expect(rows.length).toBeGreaterThanOrEqual(covering)
			expect(rows.length).toBeLessThanOrEqual(covering + legacy)
			for (const r of rows) {
				expect(Object.values(STATE_WORD)).toContain(r.stateWord)
				expect(r.action?.kind).not.toBe("settings")
				if (r.action?.kind === "decoder")
					expect(r.state).toBe(r.action.op === "restart" ? "failed" : "off")
			}
		}),
		{ numRuns: 200 },
	)
})
