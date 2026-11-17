import { readFileSync } from "node:fs"
import fc from "fast-check"
import { afterEach, describe, expect, it } from "vitest"
import type {
	ActivitySummary,
	Discovery,
	RecordingInventoryItem,
	ResolvedBandPlanView,
} from "@wavekit/api-types"

import { rowView } from "../../src/features/activity/rows.ts"
import type { SearchToken } from "../../src/features/activity/search.ts"
import {
	recordingMeta,
	recordingTitle,
} from "../../src/features/recordings/model.ts"
import {
	bandPlanView,
	channelMHz,
	channelName,
	channelToken,
	channelWindow,
	confidenceWord,
	followBandPlan,
	followSavedNames,
	halfWidthText,
	historyLabel,
	NO_FREQUENCY,
	protocolSpelling,
	rasterHz,
	savedNameAt,
	savedNames,
	showChannel,
	stepAt,
	transmissionSubtitle,
	transmissionTitle,
	type ChannelHistory,
	type ChannelNameParts,
} from "../../src/features/naming.ts"
import { Store } from "../../src/data/store.ts"
import { shellStore } from "../../src/shell/store.ts"

afterEach(() => {
	savedNames.set([])
	bandPlanView.set(null)
})

describe("channel name", () => {
	it.each<[string, ChannelNameParts, string]>([
		[
			"the saved name wins",
			{ saved: "Club net", label: "x", proven: "dstar" },
			"Club net",
		],
		[
			"then the operator label",
			{ label: "Club net", proven: "dmr" },
			"Club net",
		],
		["a blank saved name counts as none", { saved: "  ", label: "Net" }, "Net"],
		["a proven protocol, spelled", { proven: "dstar" }, "D-STAR"],
		["a proven protocol and its role", { proven: "pocsag" }, "POCSAG pager"],
		["analog FM reads as content", { proven: "analog-fm" }, "FM voice"],
		["a composed proven title stays", { proven: "DMR · CC 1" }, "DMR · CC 1"],
		["a likely protocol", { likely: "dmr" }, "Likely DMR"],
		["a likely title is not doubled", { likely: "Likely DMR" }, "Likely DMR"],
		["the shape", { shape: "FM ~25 kHz" }, "Unidentified · FM ~25 kHz"],
		["nothing known", {}, "Unidentified"],
	])("%s", (_case, parts, name) => {
		expect(channelName(parts)).toBe(name)
	})
})

describe("protocol spelling", () => {
	it.each<[string | null, string | null]>([
		["dstar", "D-STAR"],
		["DSTAR", "D-STAR"],
		["d_star", "D-STAR"],
		["dmr", "DMR"],
		["p25p1", "P25"],
		["nxdn96", "NXDN"],
		["dpmr", "dPMR"],
		["adsb", "ADS-B"],
		["lora", "LoRa"],
		["nfm", "NFM"],
		["analog-fm", "FM voice"],
		["something-new", null],
		[null, null],
	])("%s → %s", (id, spelled) => {
		expect(protocolSpelling(id)).toBe(spelled)
	})
})

const disc = (patch: Partial<Discovery>): Discovery =>
	({
		protocol: "dmr",
		confidence: "classified",
		...patch,
	}) as Discovery
const proof = (kind: string) =>
	({ kind, protocol: "dmr" }) as unknown as NonNullable<Discovery["proof"]>

describe("confidence word", () => {
	it.each<[string, Partial<Discovery>, string]>([
		[
			"a proven decoded proof",
			{ evidenceLevel: "proven", proof: proof("decoded") },
			"Decoded",
		],
		[
			"a proven analog voice proof",
			{
				evidenceLevel: "proven",
				proof: proof("analog-voice"),
				protocol: "analog-fm",
			},
			"Voice heard",
		],
		[
			"a proven tone proof",
			{
				evidenceLevel: "proven",
				proof: proof("analog-tone"),
				protocol: "analog-fm",
			},
			"Voice heard",
		],
		[
			"a weak decoded proof is only likely",
			{ evidenceLevel: "weak", proof: proof("decoded") },
			"Likely",
		],
		["a core without proofs, decoded", { confidence: "decoded" }, "Decoded"],
		[
			"a proof without an evidence level is never decoded",
			{ confidence: "decoded", proof: proof("decoded") },
			"Likely",
		],
		["a classified guess", { confidence: "classified" }, "Likely"],
		["a candidate guess", { confidence: "candidate" }, "Likely"],
		["only activity", { confidence: "activity" }, "Unidentified"],
		[
			"no protocol named",
			{ protocol: "unknown", confidence: "classified" },
			"Unidentified",
		],
		[
			"a carrier",
			{ protocol: "carrier", confidence: "decoded" },
			"Unidentified",
		],
	])("%s", (_case, patch, word) => {
		expect(confidenceWord(disc(patch))).toBe(word)
	})
})

describe("channel frequency", () => {
	it.each<[number, number, string]>([
		[145_600_000, 12_500, "145.6000"],
		// a measured carrier off the raster reads as its channel
		[145_599_792, 12_500, "145.6000"],
		[145_612_048, 12_500, "145.6125"],
		// a 6.25 kHz channel is not pulled onto the 12.5 kHz raster
		[145_640_625, 12_500, "145.6406"],
		[145_640_625, 6_250, "145.6406"],
		// off channel (more than a quarter step away): the frequency itself
		[145_617_000, 12_500, "145.6170"],
		// a step that is not usable falls back to 12.5 kHz
		[145_562_800, 0, "145.5625"],
	])("%d Hz on a %d Hz raster reads %s", (hz, step, text) => {
		expect(channelMHz(hz, step)).toBe(text)
	})

	it.each<[number, string]>([
		[6_250, "±6.25 kHz"],
		[3_125, "±3.125 kHz"],
		[1_000, "±1 kHz"],
		[12_500, "±12.5 kHz"],
		[500, "±500 Hz"],
	])("half width %d reads %s", (hz, text) => {
		expect(halfWidthText(hz)).toBe(text)
	})
})

describe("transmission title", () => {
	it.each<[Parameters<typeof transmissionTitle>[0], string]>([
		[{ from: "N0CALL", to: "CQ" }, "N0CALL → CQ"],
		[{ from: "N0CALL" }, "N0CALL"],
		[{ to: "TG 9" }, "TG 9"],
		[{ what: "FM voice" }, "FM voice"],
		[{ from: " ", what: "Page" }, "Page"],
		[{}, "Transmission"],
	])("%o → %s", (parts, title) => {
		expect(transmissionTitle(parts)).toBe(title)
	})

	it("drops the channel from the subtitle when it is the title", () => {
		expect(
			transmissionSubtitle({
				title: "FM voice",
				channel: "FM voice",
				frequency: "145.6000",
				duration: "0:04",
			}),
		).toBe("145.6000 · 0:04")
		expect(
			transmissionSubtitle({
				title: "Club net",
				channel: "FM voice",
				frequency: "145.6125",
				duration: "1:30",
			}),
		).toBe("FM voice · 145.6125 · 1:30")
	})
})

describe("saved names", () => {
	const saved = [
		{ frequencyHz: 145_612_500, name: "Club net" },
		{ frequencyHz: 145_625_000, name: "Next door" },
		{ frequencyHz: 145_500_000, name: "  " },
	]

	it.each<[number | null, string | null]>([
		[145_612_500, "Club net"],
		// the measured carrier 0.6 kHz off still finds it
		[145_611_900, "Club net"],
		// nearer the neighbour: the neighbour's name
		[145_623_000, "Next door"],
		// exactly between the two channels: neither
		[145_618_750, null],
		// a carrier 4 kHz off its 12.5 kHz channel still finds it
		[145_616_500, "Club net"],
		// a channel 12.5 kHz away is not it
		[145_600_000, null],
		// a blank name names nothing
		[145_500_000, null],
		[null, null],
	])("%s → %s", (hz, name) => {
		expect(savedNameAt(hz, saved)).toBe(name)
	})

	it("matches on the band's raster: half its step, never a fixed width", () => {
		// 4 kHz off: its channel on a 12.5 kHz band, nothing on a 6.25 kHz one
		expect(savedNameAt(145_616_500, saved, 12_500)).toBe("Club net")
		expect(savedNameAt(145_616_500, saved, 6_250)).toBeNull()
		// a 25 kHz band reaches 12.4 kHz either side
		expect(savedNameAt(145_600_100, saved, 25_000)).toBe("Club net")
		expect(savedNameAt(Number.NaN, saved)).toBeNull()
	})

	it("follows the saved-frequency store", () => {
		const store = new Store({ items: saved })
		const stop = followSavedNames(store)
		expect(savedNameAt(145_612_500)).toBe("Club net")
		store.set({ items: [{ frequencyHz: 145_612_500, name: "Renamed" }] })
		expect(savedNameAt(145_612_500)).toBe("Renamed")
		stop()
		store.set({ items: [] })
		expect(savedNameAt(145_612_500)).toBe("Renamed")
	})
})

describe("the channel door", () => {
	it.each<[number, number, number, number]>([
		// [hz, step, channel, half width]
		[145_612_048, 12_500, 145_612_500, 6_250],
		[145_640_625, 6_250, 145_640_625, 3_125],
		[161_150_400, 25_000, 161_150_000, 12_500],
		// never the signal's bandwidth: the window is the raster's alone
		[145_612_500, 12_500, 145_612_500, 6_250],
	])("%d on %d → %d ±%d", (hz, step, channel, half) => {
		expect(channelWindow(hz, step)).toEqual({
			channelHz: channel,
			spanHz: half,
		})
	})

	it("opens Activity on the channel, its chip naming the channel and stating the width", () => {
		savedNames.set([{ frequencyHz: 145_612_500, name: "Club net" }])
		const calls: { tokens: readonly SearchToken[] }[] = []
		let state = { editing: "col-1", view: "map" }
		const activity = {
			update: (fn: (s: typeof state) => typeof state) => {
				state = fn(state)
			},
			setSearch: (tokens: readonly SearchToken[]) => calls.push({ tokens }),
		} as unknown as ChannelHistory
		showChannel(activity, 145_611_776, 12_500)
		expect(state).toEqual({ editing: null, view: "all" })
		expect(calls).toHaveLength(1)
		expect(calls[0]?.tokens).toEqual([
			{
				kind: "frequency",
				value: "145612500",
				spanHz: 6_250,
				label: "Club net · 145.6125 ±6.25 kHz",
			},
		])
		expect(shellStore.getState().drawer).toBe("activity")
	})

	it("names its door by where it goes", () => {
		expect(historyLabel(145_611_776, 12_500, null)).toBe("History of 145.6125")
		expect(historyLabel(145_611_776, 12_500, "Club net")).toBe(
			"History of Club net",
		)
		expect(channelToken(145_600_000, 12_500, null).label).toBe(
			"145.6000 ±6.25 kHz",
		)
	})
})

describe("a scanner recording's Activity row", () => {
	const row = (patch: Partial<ActivitySummary> = {}): ActivitySummary => ({
		eventId: "evt_1",
		commitSeq: "1",
		kind: "recording-change",
		producedAt: "2026-11-16T10:00:00.000Z",
		receivedAt: "2026-11-16T10:00:00.000Z",
		decoderId: null,
		sourceId: "src",
		protocol: "analog",
		category: "voice",
		frequencyHz: 145_599_792,
		entityKey: null,
		title: "Recording 145.599792 MHz",
		fields: [{ key: "durationMs", label: "Duration", value: 4000, unit: "ms" }],
		recording: { id: "scan:d1~a.wav", durationMs: 4000 },
		...patch,
	})

	it("reads as a transmission, never as a recording of a frequency", () => {
		const v = rowView(row())
		expect(v.title).toBe("FM voice")
		expect(v.subtitle).toBe("145.6000 · 0:04")
		expect(`${v.title} ${v.subtitle}`).not.toMatch(/Recording/)
		expect(v.readings).toBeNull()
	})

	it("takes its channel's saved name, matched by raster frequency", () => {
		savedNames.set([{ frequencyHz: 145_600_000, name: "Club net" }])
		const v = rowView(row({ recording: { id: "x", durationMs: 90_000 } }))
		expect(v.title).toBe("Club net")
		expect(v.subtitle).toBe("FM voice · 145.6000 · 1:30")
	})

	it("keeps the title and subtitle without a frequency or a length", () => {
		const bare = row({ frequencyHz: null, fields: [] })
		delete bare.recording
		const v = rowView(bare)
		expect(v.title).toBe("FM voice")
		expect(v.subtitle).toBe("")
	})
})

describe("naming properties", () => {
	// Feature: app-coherence, Property 3: a frequency never reads NaN
	// Validates: app-coherence naming rule
	it("a frequency that is not finite reads as the placeholder, never NaN or Infinity", () => {
		fc.assert(
			fc.property(
				fc.oneof(fc.double(), fc.constantFrom(Number.NaN, Infinity, -Infinity)),
				fc.oneof(fc.double(), fc.constantFrom(12_500, 6_250)),
				(hz, step) => {
					const texts = [
						channelMHz(hz, step),
						historyLabel(hz, step, null),
						halfWidthText(step / 2),
					]
					if (!Number.isFinite(hz) && channelMHz(hz, step) !== NO_FREQUENCY)
						return false
					return texts.every(t => !/NaN|Infinity/.test(t))
				},
			),
			{ numRuns: 300 },
		)
	})

	// Feature: app-coherence, Property 1: every channel name is non-empty
	// Validates: app-coherence naming rule
	it("every channel name is non-empty, whatever is known", () => {
		const part = fc.option(fc.string({ maxLength: 12 }), { nil: null })
		fc.assert(
			fc.property(
				fc.record({
					saved: part,
					label: part,
					proven: part,
					likely: part,
					shape: part,
				}),
				parts => channelName(parts).trim().length > 0,
			),
			{ numRuns: 300 },
		)
	})

	// Feature: app-coherence, Property 2: the channel frequency format is stable
	// Validates: app-coherence naming rule
	it("the channel frequency is 4 decimals and idempotent on its own raster", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 100_000, max: 6_000_000_000 }),
				fc.constantFrom(5_000, 6_250, 8_333, 12_500, 25_000, 100_000),
				(hz, step) => {
					const once = rasterHz(hz, step)
					const text = channelMHz(hz, step)
					return (
						rasterHz(once, step) === once &&
						channelMHz(once, step) === text &&
						/^\d+\.\d{4}$/.test(text)
					)
				},
			),
			{ numRuns: 300 },
		)
	})
})

describe("the channel door in components", () => {
	// the palette and the spectrum menu are checked by behaviour (palette.test.ts, signal-menu.test.ts); these
	// React call sites cannot render without a DOM here, so they are held to the one seam by their source
	const read = (path: string) =>
		readFileSync(new URL(`../../src/${path}`, import.meta.url), "utf8")

	it.each([
		["features/tuned/TunedCard.tsx"],
		["plot/DiscoveryTags.tsx"],
		["features/recordings/RecordingsDrawer.tsx"],
	])("%s opens a channel's history through showChannel", path => {
		const src = read(path)
		expect(src).toContain("showChannel(")
		expect(src).not.toMatch(/showFrequency\(/)
		expect(src).not.toContain("Show in")
	})
})

// A synthetic plan: a 5 kHz band and a 6.25 kHz band (made-up edges).
const rasterPlan = {
	bands: [
		{ startHz: 150_000_000, endHz: 151_000_000, stepHz: 5_000 },
		{ startHz: 152_000_000, endHz: 153_000_000, stepHz: 6_250 },
	].map((b, i) => ({
		key: `band-${i}`,
		layer: 0,
		band: { ...b },
		segments: [{ startHz: b.startHz, endHz: b.endHz }],
	})),
} as unknown as ResolvedBandPlanView

describe("the band plan's raster, followed", () => {
	const rec = (frequencyHz: number): RecordingInventoryItem => ({
		id: "scan:d1~a.wav",
		kind: "scanner-analog",
		decoderId: null,
		discoveryId: "d1",
		startedAtLocal: null,
		modifiedAt: "2026-11-16T10:00:00.000Z",
		bytes: 1000,
		durationMs: 4000,
		callType: null,
		talkgroup: null,
		source: null,
		frequencyHz,
	})

	it("follows the band-plan store and reads its step at a frequency", () => {
		const store = new Store<{ view: ResolvedBandPlanView | null }>({
			view: null,
		})
		const off = followBandPlan(store)
		expect(stepAt(150_005_000)).toBe(12_500)
		store.set({ view: rasterPlan })
		expect(stepAt(150_005_000)).toBe(5_000)
		expect(stepAt(152_006_250)).toBe(6_250)
		expect(stepAt(160_000_000)).toBe(12_500)
		off()
	})

	it.each<[string, number, string]>([
		["a 5 kHz channel stays on its raster", 150_005_000, "150.0050"],
		["a 5 kHz carrier a little off snaps to it", 150_005_900, "150.0050"],
		["a 6.25 kHz channel stays on its raster", 152_018_750, "152.0188"],
		["off any band: the default raster", 160_011_000, "160.0125"],
	])("frequency text: %s", (_case, hz, text) => {
		bandPlanView.set(rasterPlan)
		expect(channelMHz(hz)).toBe(text)
	})

	it("matches a saved name within half the band's step, never a neighbour", () => {
		bandPlanView.set(rasterPlan)
		savedNames.set([
			{ frequencyHz: 152_006_250, name: "Net six" },
			{ frequencyHz: 150_005_000, name: "Net five" },
		])
		expect(savedNameAt(152_006_250)).toBe("Net six")
		expect(savedNameAt(152_008_000)).toBe("Net six")
		// 4 kHz away on a 6.25 kHz raster is the next channel over (the default 12.5 kHz would have matched)
		expect(savedNameAt(152_010_250)).toBeNull()
		expect(savedNameAt(150_008_000)).toBeNull()
		expect(historyLabel(152_006_250)).toBe("History of Net six")
		expect(historyLabel(152_011_000)).toBe("History of 152.0125")
	})

	it("Recordings name and place a row on the band's raster", () => {
		bandPlanView.set(rasterPlan)
		savedNames.set([{ frequencyHz: 150_005_000, name: "Net five" }])
		expect(recordingTitle(rec(150_005_000))).toBe("Net five")
		expect(recordingMeta(rec(150_005_000))).toContain("150.0050")
		expect(recordingTitle(rec(150_010_000))).toBe("FM voice")
		expect(recordingMeta(rec(150_010_000))).toContain("150.0100")
	})

	it("the channel door opens the band's raster and half its step", () => {
		bandPlanView.set(rasterPlan)
		const t = channelToken(150_005_000)
		expect(t.value).toBe("150005000")
		expect(t.spanHz).toBe(2_500)
	})
})
