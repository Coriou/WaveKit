import { describe, expect, it } from "vitest"
import type { ActivitySummary } from "@wavekit/api-types"
import {
	durationText,
	fieldText,
	groupLabel,
	listEntries,
	rowView,
} from "../../src/features/activity/rows.ts"
import {
	buildQuery,
	frequencyToken,
	parseFrequency,
	searchTitle,
	suggest,
	token,
} from "../../src/features/activity/search.ts"
import {
	indexAt,
	prefixOffsets,
	virtualWindow,
} from "../../src/features/activity/virtual.ts"

const at = (
	iso: string,
	over: Partial<ActivitySummary> = {},
): ActivitySummary => ({
	eventId: `e-${iso}`,
	commitSeq: "1",
	kind: "decoder-reception",
	producedAt: iso,
	receivedAt: iso,
	decoderId: "d",
	sourceId: "s",
	protocol: "pocsag",
	category: "paging",
	frequencyHz: 160_450_000,
	entityKey: null,
	title: "Capcode 1234567",
	fields: [],
	...over,
})

describe("activity search", () => {
	it("reads frequencies with and without units", () => {
		expect(parseFrequency("145.6375")).toBe(145_637_500)
		expect(parseFrequency("433920 kHz")).toBe(433_920_000)
		expect(parseFrequency("161,15 MHz")).toBe(161_150_000)
		expect(parseFrequency("2081")).toBeNull()
		expect(parseFrequency("12 Hz")).toBeNull()
	})

	it("suggests typed meanings, best first, and always Anywhere", () => {
		expect(suggest("tg 2081")).toEqual([token("talkgroup", "2081")])
		expect(suggest("ctcss 88.5").map(t => t.label)).toEqual(["CTCSS 88.5 Hz"])
		expect(suggest("dcs 023")[0]).toMatchObject({ kind: "dcs", value: "023" })
		expect(suggest("88.5").map(t => t.kind)).toEqual([
			"ctcss",
			"frequency",
			"text",
		])
		expect(suggest("145.6375").map(t => t.kind)).toEqual(["frequency", "text"])
		expect(suggest("1234567").map(t => t.kind)).toEqual([
			"capcode",
			"talkgroup",
			"text",
		])
		expect(suggest("227006760")[0]?.kind).toBe("mmsi")
		expect(suggest("3944ef")[0]).toMatchObject({
			kind: "icao",
			value: "3944EF",
		})
		expect(suggest("f4abc-9")[0]).toMatchObject({
			kind: "callsign",
			value: "F4ABC-9",
		})
		expect(suggest("berth four").map(t => t.kind)).toEqual(["text"])
		expect(suggest("  ")).toEqual([])
	})

	it("builds one core query: words AND-ed, categories narrowed, a frequency range", () => {
		expect(buildQuery([], null)).toEqual({})
		expect(buildQuery([token("capcode", "1234567")], null)).toEqual({
			categories: ["paging"],
			text: "1234567",
		})
		expect(
			buildQuery(
				[frequencyToken(160_450_000), token("text", "test page")],
				"paging",
			),
		).toEqual({
			categories: ["paging"],
			frequencyHz: { min: 160_443_750, max: 160_456_250 },
			text: "test page",
		})
		expect(buildQuery([token("dcs", "023N")], null)?.text).toBe("023")
		expect(
			buildQuery([token("entity", "mmsi:1", { label: "Kerlouan" })], null),
		).toEqual({
			entityKey: "mmsi:1",
		})
		expect(
			buildQuery([token("icao", "3944EF")], "aircraft")?.categories,
		).toEqual(["aircraft", "aviation-data"])
	})

	it("refuses searches that cannot match", () => {
		expect(buildQuery([token("capcode", "1")], "marine")).toBeNull()
		expect(
			buildQuery([frequencyToken(1e8), frequencyToken(2e8)], null),
		).toBeNull()
	})

	it("titles a search for pins and the list header", () => {
		expect(searchTitle([], null)).toBe("All activity")
		expect(searchTitle([token("talkgroup", "2081")], "voice")).toBe(
			"Voice · TG 2081",
		)
	})
})

describe("activity rows", () => {
	it("shows a pager message in full and the protocol in the subtitle", () => {
		const v = rowView(
			at("2026-10-17T08:00:00Z", {
				fields: [
					{ key: "capcode", label: "Capcode", value: 1234567 },
					{ key: "function", label: "Function", value: 3 },
					{ key: "message", label: "Message", value: "Test page" },
				],
			}),
		)
		expect(v).toMatchObject({
			icon: "paging",
			title: "Capcode 1234567",
			subtitle: "POCSAG · Function 3",
			message: "Test page",
			readings: null,
		})
	})

	it("does not repeat in the subtitle who the title already names", () => {
		const v = rowView(
			at("2026-10-17T08:00:00Z", {
				protocol: "dmr",
				category: "voice",
				title: "TG 2081 · radio 2081045",
				fields: [
					{ key: "talkgroup", label: "Talkgroup", value: 2081 },
					{ key: "source", label: "Radio", value: 2081045 },
					{ key: "slot", label: "Slot", value: 1 },
				],
			}),
		)
		expect(v.subtitle).toBe("DMR · 160.450 MHz")
		expect(v.readings).toBe("Slot 1")
	})

	it("formats readings with units", () => {
		expect(
			fieldText({ key: "alt", label: "Altitude", value: 36000, unit: "ft" }),
		).toBe("36 000 ft")
		expect(fieldText({ key: "t", label: "Track", value: 284, unit: "°" })).toBe(
			"284°",
		)
		expect(
			fieldText({ key: "h", label: "Humidity", value: 61, unit: "%" }),
		).toBe("61 %")
		expect(fieldText({ key: "b", label: "Battery", value: true })).toBe("Yes")
	})

	it("reads the core's analog transmission summary", () => {
		const v = rowView(
			at("2026-10-17T08:00:00Z", {
				kind: "analog-transmission",
				protocol: "analog",
				category: "voice",
				decoderId: null,
				title: "NFM 160.625 MHz",
				fields: [
					{ key: "durationMs", label: "Duration", value: 9400, unit: "ms" },
					{ key: "modulation", label: "Modulation", value: "nfm" },
					{ key: "ctcssHz", label: "CTCSS", value: 88.5, unit: "Hz" },
				],
			}),
		)
		expect(v).toMatchObject({
			icon: "voice",
			title: "NFM 160.625 MHz",
			subtitle: "NFM · Analog voice · CTCSS 88.5 Hz",
			readings: "9 s",
		})
		expect(durationText(72_000)).toBe("1 min 12 s")
	})

	it("turns an ingestion gap into a plain notice", () => {
		const v = rowView(
			at("2026-10-17T08:00:00Z", {
				kind: "ingestion-gap",
				category: "other",
				title: "Ingestion gap (rate-limited)",
				fields: [{ key: "dropped", label: "Dropped", value: 37 }],
			}),
		)
		expect(v).toMatchObject({
			notice: true,
			title: "37 events not kept",
			subtitle: "Activity skipped them: too many at once",
		})
	})

	it("groups by minute with Just now for the last minute", () => {
		const now = Date.parse("2026-10-17T08:05:30Z")
		expect(groupLabel("2026-10-17T08:05:00Z", now)).toBe("Just now")
		const items = [
			at("2026-10-17T08:05:10Z"),
			at("2026-10-17T08:03:10Z"),
			at("2026-10-17T08:03:05Z"),
		]
		const entries = listEntries(items, now)
		expect(entries.map(e => e.type)).toEqual([
			"group",
			"row",
			"group",
			"row",
			"row",
		])
	})
})

describe("activity list window", () => {
	const offsets = prefixOffsets([28, 60, 60, 60, 60, 60])

	it("finds the entry under a y offset", () => {
		expect(indexAt(offsets, 0)).toBe(0)
		expect(indexAt(offsets, 29)).toBe(1)
		expect(indexAt(offsets, 10_000)).toBe(5)
	})

	it("mounts only what is in view plus overscan", () => {
		expect(virtualWindow(offsets, 0, 100, 0)).toEqual({
			start: 0,
			end: 3,
			offset: 0,
			total: 328,
		})
		expect(virtualWindow(offsets, 150, 60, 0)).toMatchObject({
			start: 3,
			end: 5,
			offset: 148,
		})
		expect(virtualWindow(prefixOffsets([]), 0, 100)).toEqual({
			start: 0,
			end: 0,
			offset: 0,
			total: 0,
		})
	})

	it("stays cheap for thousands of rows", () => {
		const many = prefixOffsets(Array.from({ length: 5000 }, () => 70))
		const w = virtualWindow(many, 200_000, 800, 400)
		expect(w.end - w.start).toBeLessThan(30)
	})
})
