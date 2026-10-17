import { describe, expect, it, vi } from "vitest"
import type {
	LiveAudioConfig,
	ResolvedBandPlanView,
	SavedFrequency,
} from "@wavekit/api-types"
import { parseFrequency } from "../../src/features/tuner/frequency.ts"
import {
	activeSuggestion,
	defaultGroup,
	defaultSaveName,
	entrySuggestions,
	entryTarget,
	recallPatch,
	recallSaved,
	saveInput,
	saveSummary,
	savedMeta,
	savedSuggestions,
} from "../../src/features/tuner/saved.ts"

const T0 = "2026-10-14T08:00:00.000Z"
let n = 0
function saved(
	name: string,
	frequencyHz: number,
	over: Partial<SavedFrequency> = {},
): SavedFrequency {
	n += 1
	return {
		id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
		createdAt: T0,
		updatedAt: T0,
		name,
		frequencyHz,
		mode: "nfm",
		bandwidthHz: 12_500,
		tone: { kind: "none" },
		...over,
	}
}

const ITEMS = [
	saved("Marine ch 16", 156_800_000, { group: "Marine" }),
	saved("DMR repeater", 161_150_000, { group: "Local" }),
	saved("AIS channel A", 161_975_000, { group: "Marine", bandwidthHz: 25_000 }),
	saved("PMR446 ch 1", 446_006_250, {
		group: "Local",
		tone: { kind: "ctcss", frequencyTenthsHz: 770 },
	}),
]

const config = (over: Partial<LiveAudioConfig> = {}): LiveAudioConfig =>
	({
		enabled: true,
		httpPort: 3102,
		modulation: "nfm",
		bandwidth: 12_500,
		squelch: -60,
		...over,
	}) as LiveAudioConfig

describe("saved names in typed entry", () => {
	it("lists every saved frequency for an empty entry", () => {
		expect(savedSuggestions(ITEMS, "").map(s => s.saved.name)).toHaveLength(4)
		expect(savedSuggestions(ITEMS, "", 2)).toHaveLength(2)
	})

	it("matches names (exact, prefix, word, inside), then groups", () => {
		expect(savedSuggestions(ITEMS, "dmr").map(s => s.saved.name)).toEqual([
			"DMR repeater",
		])
		// word matches tie, then by frequency
		expect(savedSuggestions(ITEMS, "ch").map(s => s.saved.name)).toEqual([
			"Marine ch 16",
			"AIS channel A",
			"PMR446 ch 1",
		])
		expect(savedSuggestions(ITEMS, "peat").map(s => s.saved.name)).toEqual([
			"DMR repeater",
		])
		expect(savedSuggestions(ITEMS, "local").map(s => s.saved.name)).toEqual([
			"DMR repeater",
			"PMR446 ch 1",
		])
	})

	it("matches MHz digit prefixes for numbers, never steps", () => {
		expect(savedSuggestions(ITEMS, "161").map(s => s.saved.name)).toEqual([
			"DMR repeater",
			"AIS channel A",
		])
		expect(savedSuggestions(ITEMS, "161.9").map(s => s.saved.name)).toEqual([
			"AIS channel A",
		])
		expect(savedSuggestions(ITEMS, "1")).toEqual([])
		expect(savedSuggestions(ITEMS, "+25")).toEqual([])
	})

	it("puts saved frequencies before plan channels, without the same frequency twice", () => {
		const view = {
			bands: [
				{
					key: "cept/marine",
					band: {
						name: "Marine VHF",
						group: "marine",
						channels: [
							{
								id: "16",
								name: "Ch 16",
								aliases: ["ch 16", "distress"],
								frequencyHz: 156_800_000,
							},
							{
								id: "13",
								name: "Ch 13",
								aliases: ["ch 13"],
								frequencyHz: 156_650_000,
							},
						],
					},
				},
			],
		} as unknown as ResolvedBandPlanView
		const list = entrySuggestions(view, ITEMS, "ch 1")
		expect(list.map(s => [s.kind, s.label])).toEqual([
			["saved", "Marine ch 16"],
			["saved", "PMR446 ch 1"],
			["channel", "Ch 13"],
		])
		expect(list[0]?.sub).toBe("Marine")
	})

	it("tunes a typed number unless a suggestion was chosen with the arrows", () => {
		const list = entrySuggestions(null, ITEMS, "161")
		const parsed = parseFrequency("161", 161_500_000)
		expect(entryTarget(parsed, list, 0, false)).toEqual({
			kind: "hz",
			hz: 161_000_000,
		})
		expect(activeSuggestion(parsed, 0, false)).toBe(-1)
		expect(entryTarget(parsed, list, 1, true)).toMatchObject({
			kind: "saved",
			saved: { name: "AIS channel A" },
		})
		const text = parseFrequency("dmr", 0)
		expect(
			entryTarget(text, entrySuggestions(null, ITEMS, "dmr"), 0, false),
		).toMatchObject({ kind: "saved", saved: { name: "DMR repeater" } })
		expect(entryTarget(text, [], 0, false)).toBeNull()
	})
})

describe("saving and recalling", () => {
	it("saves the tuned frequency with the live mode, bandwidth and tone", () => {
		const input = saveInput(
			{
				hz: 446_006_250.4,
				config: config({
					toneSquelch: { kind: "ctcss", frequencyTenthsHz: 770 },
				}),
				bandMode: null,
			},
			"PMR",
			"Local",
		)
		expect(input).toEqual({
			name: "PMR",
			frequencyHz: 446_006_250,
			mode: "nfm",
			bandwidthHz: 12_500,
			tone: { kind: "ctcss", frequencyTenthsHz: 770 },
			group: "Local",
		})
		expect(saveSummary(input)).toBe(
			"446.00625 MHz · NFM · 12.5 kHz · CTCSS 77.0",
		)
		// a tone only belongs to NFM; RAW stores no bandwidth; no live audio: the band's mode
		expect(
			saveInput(
				{
					hz: 118_100_000,
					config: config({
						modulation: "am",
						bandwidth: 8330,
						toneSquelch: { kind: "ctcss", frequencyTenthsHz: 770 },
					}),
					bandMode: null,
				},
				"Tower",
				null,
			),
		).toEqual({
			name: "Tower",
			frequencyHz: 118_100_000,
			mode: "am",
			bandwidthHz: 8330,
			tone: { kind: "none" },
		})
		expect(
			saveInput(
				{ hz: 1e8, config: config({ modulation: "raw" }), bandMode: null },
				"x",
				null,
			).bandwidthHz,
		).toBe(0)
		expect(
			saveInput({ hz: 1e8, config: null, bandMode: "wfm" }, "x", null),
		).toMatchObject({ mode: "wfm", bandwidthHz: 150_000 })
	})

	it("names and groups a new save from the band plan", () => {
		expect(defaultSaveName(156_800_000, "Ch 16", "Marine VHF")).toBe("Ch 16")
		expect(defaultSaveName(156_800_000, null, "Marine VHF")).toBe("Marine VHF")
		expect(defaultSaveName(161_150_000, null, null)).toBe("Saved 161.150")
		expect([
			defaultGroup("marine"),
			defaultGroup("air"),
			defaultGroup(null),
		]).toEqual(["Marine", "Aviation", "Local"])
		expect(savedMeta(ITEMS[3] as SavedFrequency)).toBe(
			"Local · NFM · 12.5 kHz · CTCSS 77.0",
		)
	})

	it("recalls mode, bandwidth and tone, keeping the squelch valid", () => {
		expect(recallPatch(config(), ITEMS[1] as SavedFrequency)).toEqual({})
		expect(recallPatch(config(), ITEMS[2] as SavedFrequency)).toEqual({
			bandwidth: 25_000,
		})
		expect(recallPatch(config(), ITEMS[3] as SavedFrequency)).toEqual({
			toneSquelch: { kind: "ctcss", frequencyTenthsHz: 770 },
		})
		const tower = saved("Tower", 118_100_000, { mode: "am", bandwidthHz: 8330 })
		expect(
			recallPatch(
				config({
					squelchMode: "noise",
					toneSquelch: { kind: "ctcss", frequencyTenthsHz: 770 },
				}),
				tower,
			),
		).toEqual({
			squelchMode: "auto",
			autoMarginDb: 6,
			toneSquelch: { kind: "none" },
			modulation: "am",
			bandwidth: 8330,
		})
		expect(recallPatch(null, tower)).toEqual({})
	})

	it("changes the mode before tuning, and still tunes when the change is refused", async () => {
		const steps: string[] = []
		const ports = {
			config: () => config(),
			setConfig: vi.fn(async () => {
				steps.push("mode")
				throw new Error("refused")
			}),
			tune: vi.fn(async (hz: number) => {
				steps.push(`tune ${hz}`)
			}),
		}
		await recallSaved(ports, ITEMS[2] as SavedFrequency)
		expect(steps).toEqual(["mode", "tune 161975000"])
		steps.length = 0
		await recallSaved(ports, ITEMS[1] as SavedFrequency)
		expect(steps).toEqual(["tune 161150000"])
	})
})
