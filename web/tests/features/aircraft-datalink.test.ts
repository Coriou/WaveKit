// Aircraft datalink in the web app: ACARS and VDL2 rows read in plain words, link upkeep folds per channel,
// and positions reported over datalink stay off the ADS-B tracks. Identifiers are fictional.
import { describe, expect, it } from "vitest"
import type { ActivitySummary, DecodeField } from "@wavekit/api-types"

import {
	LINK_STACK_TITLE,
	explainStack,
	familyOf,
	foldActivity,
	isLinkTraffic,
} from "../../src/features/activity/fold.ts"
import { rowView } from "../../src/features/activity/rows.ts"
import {
	TRACK_CATEGORIES,
	trailsPath,
} from "../../src/data/trail-history-store.ts"
import {
	latestReports,
	reportAgeMin,
	reportedFeatures,
	reportedName,
} from "../../src/features/map/reported.ts"
import { MapUi, parseStored } from "../../src/features/map/ui-store.ts"
import {
	STORY_MAX,
	datalinkStory,
	linkedByText,
	storyKeys,
	type IdentityAnswer,
} from "../../src/features/map/datalink.ts"

const T0 = Date.parse("2026-10-17T08:00:00.000Z")
let seq = 0

function row(atMs: number, over: Partial<ActivitySummary>): ActivitySummary {
	seq += 1
	const iso = new Date(T0 + atMs).toISOString()
	return {
		eventId: `e${seq}`,
		commitSeq: String(seq),
		kind: "decoder-reception",
		producedAt: iso,
		receivedAt: iso,
		decoderId: "d",
		sourceId: "s",
		protocol: "vdl2",
		category: "aviation-data",
		frequencyHz: 136_975_000,
		entityKey: "icao:0A0B01",
		title: null,
		fields: [],
		...over,
	} as ActivitySummary
}

const f = (key: string, label: string, value: DecodeField["value"]) => ({
	key,
	label,
	value,
})

function linkFrame(atMs: number, icao: string, frame = "S"): ActivitySummary {
	return row(atMs, {
		entityKey: `icao:${icao}`,
		title: `${icao} · Link supervision`,
		fields: [
			f("frame", "Frame", frame),
			f("meaning", "Meaning", "Link supervision"),
			f("kind", "Kind", "Link"),
			f("direction", "Direction", "Air to ground"),
		],
	})
}

function acarsMessage(atMs: number): ActivitySummary {
	return row(atMs, {
		protocol: "acars",
		frequencyHz: 131_550_000,
		entityKey: "reg:N0WK01",
		title: "N0WK01 ZZ0101 · Message to or from an onboard system",
		fields: [
			f("label", "Label", "H1"),
			f("meaning", "Meaning", "Message to or from an onboard system"),
			f("kind", "Kind", "Onboard systems"),
			f("basis", "Basis", "Public label list"),
			f("direction", "Direction", "Air to ground"),
			f("text", "Text", "REQ WX ZZZZ"),
		],
	})
}

describe("aviation rows", () => {
	it("an ACARS message reads its meaning, keeps the raw label and shows its text", () => {
		const v = rowView(acarsMessage(0))
		expect(v).toMatchObject({
			icon: "aviation-data",
			title: "N0WK01 ZZ0101 · Message to or from an onboard system",
			subtitle: "ACARS · Air to ground · 131.550 MHz",
			message: "REQ WX ZZZZ",
			readings: "Label H1 · Onboard systems · Public label list",
		})
	})

	it("a VDL2 link frame names its frame type and says it is link upkeep", () => {
		const v = rowView(linkFrame(0, "0A0B01"))
		expect(v.subtitle).toBe("VDL2 · Air to ground · 136.975 MHz")
		expect(v.readings).toBe("Frame S · Link")
		expect(v.message).toBeNull()
	})
})

describe("link upkeep folds per channel", () => {
	it("link frames from several aircraft are one stack; messages stay their own rows", () => {
		const items = [
			linkFrame(0, "0A0B01"),
			linkFrame(20_000, "0A0B02"),
			linkFrame(40_000, "0A0B03", "U"),
			acarsMessage(30_000),
		]
		expect(items.map(isLinkTraffic)).toEqual([true, true, true, false])
		expect(familyOf(items[3] as ActivitySummary)).toBe("aircraft")
		const stacks = foldActivity(items)
		const link = stacks.find(s => s.family === "link")
		expect(link?.members).toHaveLength(3)
		expect(link?.view.title).toBe(LINK_STACK_TITLE)
		expect(link?.view.entityKey).toBeNull()
		expect(link?.known).toEqual({ title: null, fields: [] })
		expect(explainStack(link as NonNullable<typeof link>).headline).toBe(
			"Link upkeep: 3 frames that carry no message, over 40 s",
		)
		expect(stacks.filter(s => s.family !== "link")).toHaveLength(1)
	})

	it("another channel, or five quiet minutes, starts a new stack", () => {
		const other = {
			...linkFrame(10_000, "0A0B02"),
			frequencyHz: 136_725_000,
		}
		const stacks = foldActivity([
			linkFrame(0, "0A0B01"),
			other,
			linkFrame(301_000, "0A0B01"),
		])
		expect(stacks.map(s => s.members.length).sort()).toEqual([1, 1, 1])
	})

	it("a ground-station squitter is link upkeep too", () => {
		const squitter = row(0, {
			protocol: "acars",
			entityKey: null,
			title: "Ground station · Ground station squitter",
			fields: [f("label", "Label", "SQ"), f("kind", "Kind", "Ground station")],
		})
		expect(familyOf(squitter)).toBe("link")
	})
})

describe("reported positions", () => {
	const NOW = T0 + 3_600_000

	it("the Map's tracks never ask for aviation-data; the ACARS layer asks only for it", () => {
		expect(TRACK_CATEGORIES).not.toContain("aviation-data")
		expect(trailsPath(TRACK_CATEGORIES)).toBe(
			"/api/activity/trails?categories=aircraft,marine,voice,paging,aprs,sensors,mesh,other",
		)
		expect(trailsPath(["aviation-data"])).toBe(
			"/api/activity/trails?categories=aviation-data",
		)
	})

	it("keeps each aircraft's latest report within the hour, newest first", () => {
		const trails = new Map([
			[
				"icao:0A0B01",
				[
					{ lat: 48.5, lon: -3.5, at: NOW - 600_000 },
					{ lat: 48.6, lon: -3.4, at: NOW - 120_000 },
				],
			],
			["reg:N0WK02", [{ lat: 48.1, lon: -2.9, at: NOW - 60_000 }]],
			["icao:0A0B03", [{ lat: 47, lon: -2, at: NOW - 3_700_000 }]],
		])
		const list = latestReports(trails, NOW)
		expect(list.map(r => r.entityKey)).toEqual(["reg:N0WK02", "icao:0A0B01"])
		expect(list[1]).toMatchObject({ lat: 48.6, lon: -3.4 })
		const fc = reportedFeatures(list, NOW)
		expect(fc.features[1]?.properties).toEqual({
			id: "icao:0A0B01",
			n: "0A0B01",
			m: 2,
		})
		expect(fc.features[1]?.geometry).toEqual({
			type: "Point",
			coordinates: [-3.4, 48.6],
		})
		expect(reportedName("N0WK01")).toBe("N0WK01")
		expect(reportAgeMin(NOW + 5_000, NOW)).toBe(0)
	})

	it("the ACARS layer is on by default and its choice is remembered", () => {
		expect(parseStored(null).reported).toBe(true)
		expect(parseStored(JSON.stringify({ reported: false })).reported).toBe(
			false,
		)
		const ui = new MapUi(null, false)
		ui.toggleReported()
		expect(ui.get().reported).toBe(false)
	})
})

describe("an aircraft's datalink story", () => {
	const identity = (over: Partial<IdentityAnswer> = {}): IdentityAnswer => ({
		icao: "0A0B01",
		conflict: false,
		links: [
			{
				a: { kind: "icao", value: "0A0B01" },
				b: { kind: "reg", value: "N0WK01" },
				evidence: "observed",
				source: "vdl2",
				lastSeen: "2026-10-17T08:00:00.000Z",
			},
			{
				a: { kind: "flight", value: "ZZ0101" },
				b: { kind: "icao", value: "0A0B01" },
				evidence: "observed",
				source: "vdl2",
				lastSeen: "2026-10-17T08:00:00.000Z",
			},
		],
		entityKeys: ["icao:0A0B01", "reg:N0WK01"],
		...over,
	})

	it("follows the address and its registrations, never a flight or callsign", () => {
		expect(storyKeys("0a0b01", null)).toEqual(["icao:0A0B01"])
		expect(
			storyKeys(
				"0A0B01",
				identity({
					entityKeys: ["icao:0A0B01", "reg:N0WK01", "flight:ZZ0101"],
				}),
			),
		).toEqual(["icao:0A0B01", "reg:N0WK01"])
	})

	it("says how the registration was tied to the address", () => {
		expect(linkedByText(identity())).toBe(
			"Registration N0WK01 heard with this address on VDL2",
		)
		expect(linkedByText(identity({ icao: null, conflict: true }))).toBeNull()
		expect(linkedByText(null)).toBeNull()
	})

	it("lists messages newest first and counts link upkeep apart", () => {
		const rows = [
			linkFrame(0, "0A0B01"),
			linkFrame(10_000, "0A0B01"),
			...Array.from({ length: STORY_MAX + 1 }, (_, i) =>
				acarsMessage(20_000 + i * 1000),
			),
		]
		const story = datalinkStory([...rows, rows[2] as ActivitySummary])
		expect(story.linkCount).toBe(2)
		expect(story.messageCount).toBe(STORY_MAX + 1)
		expect(story.messages).toHaveLength(STORY_MAX)
		expect(story.messages[0]?.producedAt).toBe(
			new Date(T0 + 20_000 + STORY_MAX * 1000).toISOString(),
		)
	})
})
