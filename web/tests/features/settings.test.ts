import { describe, expect, it } from "vitest"
import type {
	DecoderInfo,
	DecoderSettingsView,
	DecoderTypeInfo,
	StationIdentity,
	TunerState,
} from "@wavekit/api-types"

import {
	decoderRows,
	humanKey,
} from "../../src/features/settings/decoder-rows.ts"
import { crumbOf, settingsItems } from "../../src/features/settings/items.ts"
import {
	filterSuggestion,
	haystack,
	isChanged,
	matches,
	pendingSummary,
	yamlLine,
	type SettingRow,
} from "../../src/features/settings/model.ts"
import { SETTINGS_REGISTRY } from "../../src/features/settings/registry.ts"
import {
	buildRows,
	formatLocation,
	parseLocation,
	type SettingsActions,
	type SettingsSnapshot,
} from "../../src/features/settings/rows.ts"

const ok = () => Promise.resolve({ ok: true as const })

function actions(): SettingsActions & { calls: unknown[][] } {
	const calls: unknown[][] = []
	const rec =
		(name: string) =>
		(...args: unknown[]) => {
			calls.push([name, ...args])
			return ok()
		}
	return {
		calls,
		setTheme: p => void calls.push(["theme", p]),
		setDevice: p => void calls.push(["device", p]),
		setStep: hz => void calls.push(["step", hz]),
		setCardAt: id => void calls.push(["cardAt", id]),
		setVolume: v => void calls.push(["volume", v]),
		receiver: rec("receiver"),
		manualGain: rec("manualGain"),
		audio: rec("audio"),
		station: rec("station"),
		preference: rec("preference"),
		decoder: rec("decoder"),
		openTuner: () => void calls.push(["openTuner"]),
		openShortcuts: () => void calls.push(["openShortcuts"]),
		openBandPlans: () => void calls.push(["openBandPlans"]),
	}
}

const v = <T>(
	value: T | null,
	provenance: "default" | "yaml" | "env" | "ui" = "default",
) => ({
	value,
	provenance,
})

const STATION: StationIdentity = {
	name: v("Roscoff station", "ui"),
	lat: v(48.727, "ui"),
	lon: v(-3.985, "ui"),
	altM: v(null),
	callsign: v(null),
	country: v("FR", "env"),
	effectiveCountry: "FR",
	region: "EU",
	revision: 3,
	writable: true,
}

const TUNER = {
	sourceId: "rtl-0",
	sampleRate: 2_400_000,
	gainMode: "manual",
	gain: 297,
	ppm: 3,
	biasTee: false,
	directSampling: "off",
	offsetTuning: false,
	agcMode: false,
} as unknown as TunerState

const POCSAG: DecoderInfo = {
	id: "pocsag-1",
	type: "multimon-ng",
	running: true,
	health: "running",
	uptime: 3600,
	stats: { bytesIn: 1, eventsOut: 42, errors: 0 },
	restartCount: 0,
	version: "1.3",
	desiredRunning: true,
	targetFrequenciesHz: [160_450_000],
	rateHistory: [10, 14, 3],
}

const TYPES: Record<string, DecoderTypeInfo> = {
	"multimon-ng": {
		type: "multimon-ng",
		caps: {} as DecoderTypeInfo["caps"],
		options: [
			{
				key: "modes",
				type: "string-list",
				enumValues: ["POCSAG512", "POCSAG1200", "FLEX"],
				default: null,
				secret: false,
				effect: "restart",
				patchable: true,
				description: "Speeds to decode",
			},
			{
				key: "charset",
				type: "enum",
				enumValues: ["US", "FR", "DE", "SE", "SI"],
				default: "US",
				secret: false,
				effect: "restart",
				patchable: true,
				description: "Character set",
			},
			{
				key: "frequenciesHz",
				type: "number-list",
				unit: "Hz",
				default: null,
				secret: false,
				effect: "restart",
				patchable: true,
				description: "Frequencies",
			},
			{
				key: "extraArgs",
				type: "string",
				default: null,
				secret: false,
				effect: "restart",
				description: "Never in the UI",
			},
			{
				key: "apiKey",
				type: "string",
				default: null,
				secret: true,
				effect: "restart",
				description: "A key",
			},
		],
	},
}

const VIEW: DecoderSettingsView = {
	decoderId: "pocsag-1",
	type: "multimon-ng",
	revision: 1,
	enabled: { value: true, source: "config" },
	options: [
		{
			key: "modes",
			source: "config",
			patchable: true,
			secret: false,
			present: true,
			value: ["POCSAG1200"],
		},
		{
			key: "charset",
			source: "default",
			patchable: true,
			secret: false,
			present: false,
			value: null,
		},
		{
			key: "frequenciesHz",
			source: "config",
			patchable: true,
			secret: false,
			present: true,
			value: [160_450_000],
		},
		{
			key: "extraArgs",
			source: "config",
			patchable: false,
			secret: false,
			present: true,
		},
		{
			key: "apiKey",
			source: "config",
			patchable: false,
			secret: true,
			present: true,
		},
	],
	undocumentedKeys: 0,
	pendingRestart: false,
}

function snapshot(over: Partial<SettingsSnapshot> = {}): SettingsSnapshot {
	return {
		readOnly: false,
		theme: { theme: "dark", ground: "black", accent: "mono" },
		device: { density: "comfy", motion: "system" },
		stepHz: null,
		cardAt: "al",
		volume: 0.8,
		tuner: TUNER,
		source: undefined,
		caps: null,
		controls: {},
		relay: null,
		live: null,
		station: STATION,
		preferences: {
			units: "metric",
			timeFormat: "local-24h",
			waterfallPalette: "phosphor",
			showSavedFrequencyLabels: false,
		},
		preferenceDefaults: {
			units: "metric",
			timeFormat: "local-24h",
			waterfallPalette: "phosphor",
			showSavedFrequencyLabels: true,
		},
		savedCount: 3,
		bandplanEdits: 3,
		decoders: [POCSAG],
		decoderTypes: TYPES,
		decoderViews: { "pocsag-1": VIEW },
		decoderSettings: true,
		version: "0.14.2",
		accessMode: "protected",
		storage: null,
		exportUrl: "/api/config/export",
		...over,
	}
}

const byId = (rows: readonly SettingRow[], id: string) => {
	const r = rows.find(x => x.id === id)
	if (!r) throw new Error(`no row ${id}`)
	return r
}

describe("Settings rows", () => {
	it("has a row for every registry entry the drawer owns", () => {
		const rows = buildRows(
			snapshot({
				live: {
					enabled: true,
					running: true,
					sourceId: "rtl-0",
					sourceConnected: true,
					sourceIqSampleRate: 2_400_000,
					effectiveSampleRate: 48_000,
					config: {
						enabled: true,
						httpPort: 8081,
						modulation: "nfm",
						bandwidth: 12_500,
						squelch: 0,
						noiseReduction: "off",
						lowPass: 0,
						highPass: 0,
						gain: 2,
						deEmphasis: false,
						deEmphasisTau: 50,
						audioFormat: "s16le",
						iqDcBlock: false,
					},
				} as unknown as SettingsSnapshot["live"],
				storage: {
					generatedAt: "",
					cachedUntil: "",
					filesystem: null,
					kept: null,
					lowSpace: {
						policy: "scanner-evidence-stops-writing",
						minFreeBytes: null,
						state: "unknown",
					},
					areas: [
						{
							id: "activity",
							class: "automatic",
							bytes: 0,
							files: 0,
							exists: true,
							partial: false,
							partialReason: null,
							cap: null,
							retention: {
								policy: "fair-share",
								effective: null,
								maxRows: 250_000,
								maxDbBytes: 256 * 1024 * 1024,
								maxAgeMs: 3 * 86_400_000,
								rows: 10,
								oldestReceivedAt: null,
								shares: [],
								sharesTruncated: false,
							},
						},
					],
				},
			}),
			actions(),
		)
		const ids = new Set(rows.map(r => r.id))
		for (const e of SETTINGS_REGISTRY)
			if (e.place.kind === "settings") expect(ids, e.id).toContain(e.id)
		expect(byId(rows, "st.activity").text).toBe(
			"3 days · 250,000 messages · 256 MB",
		)
	})

	it("locks station fields set by env or YAML and marks UI ones changed", () => {
		const rows = buildRows(snapshot(), actions())
		const country = byId(rows, "station.country")
		expect(country.lock).toBe(
			"Set by WAVEKIT_COUNTRY · change it in the environment",
		)
		expect(isChanged(country)).toBe(false)
		expect(isChanged(byId(rows, "station.name"))).toBe(true)
		expect(byId(rows, "station.location").text).toBe("48.727° N, 3.985° W")
		expect(byId(rows, "station.location").effect?.kind).toBe("restart")
	})

	it("keeps the station read-only on an open-access core", () => {
		const rows = buildRows(
			snapshot({ station: { ...STATION, writable: false } }),
			actions(),
		)
		const name = byId(rows, "station.name")
		expect(name.write).toBeUndefined()
		expect(name.lock).toContain("read-only")
	})

	it("writes a location as lat and lon together", async () => {
		const a = actions()
		const rows = buildRows(snapshot(), a)
		await byId(rows, "station.location").write?.("48.5, -4.1")
		await byId(rows, "station.location").write?.(null)
		expect(a.calls).toEqual([
			["station", { lat: 48.5, lon: -4.1 }],
			["station", { lat: null, lon: null }],
		])
	})

	it("parses locations and refuses out-of-range ones", () => {
		expect(parseLocation("48.727, -3.985")).toEqual({ value: "48.727, -3.985" })
		expect(parseLocation("48.727N 3.985W")).toEqual({ value: "48.727, -3.985" })
		expect(parseLocation("")).toEqual({ value: null })
		expect(parseLocation("91, 0")).toEqual({
			error: "Latitude goes from −90 to 90",
		})
		expect("error" in parseLocation("hello")).toBe(true)
		expect(formatLocation(null, 2)).toBe("Not set")
	})

	it("validates the callsign before saving", () => {
		const rows = buildRows(snapshot(), actions())
		const w = byId(rows, "station.callsign").widget
		if (w.kind !== "text") throw new Error("text")
		expect(w.parse("f4abc-9")).toEqual({ value: "F4ABC-9" })
		expect(w.parse("F 4")).toEqual({
			error: "Use letters and digits only, like F4ABC or F4ABC-9",
		})
	})

	it("routes receiver writes and marks hardware and restarts", async () => {
		const a = actions()
		const rows = buildRows(snapshot(), a)
		expect(byId(rows, "rx.biasT").effect?.kind).toBe("hardware")
		expect(byId(rows, "rx.rate").effect?.kind).toBe("restart")
		expect(byId(rows, "rx.gain").value).toBe("300") // nearest step of the fallback range
		expect(isChanged(byId(rows, "rx.ppm"))).toBe(true)
		await byId(rows, "rx.gain").write?.("auto")
		await byId(rows, "rx.gain").write?.("400")
		await byId(rows, "rx.ppm").write?.(0)
		expect(a.calls).toEqual([
			["receiver", { key: "gainMode", value: "agc" }],
			["manualGain", 400],
			["receiver", { key: "ppm", value: 0 }],
		])
	})

	it("disables receiver rows when the access is read-only", () => {
		const rows = buildRows(snapshot({ readOnly: true }), actions())
		expect(byId(rows, "rx.ppm").disabled).toBeDefined()
	})

	it("compares the saved-label preference with the core's default", () => {
		const rows = buildRows(snapshot(), actions())
		const tags = byId(rows, "dp.tags")
		expect(isChanged(tags)).toBe(true)
		expect(tags.def?.text).toBe("On")
	})
})

describe("Decoder pages", () => {
	it("builds widgets from the option descriptors", () => {
		const rows = decoderRows(snapshot(), actions())
		const entry = byId(rows, "dec.pocsag-1")
		expect(entry.widget.kind).toBe("page")
		expect(entry.text).toBe("14 msg/min")
		expect(byId(rows, "dec.pocsag-1.modes").widget.kind).toBe("chips")
		expect(byId(rows, "dec.pocsag-1.charset").widget.kind).toBe("select")
		expect(byId(rows, "dec.pocsag-1.charset").value).toBe("US")
		expect(byId(rows, "dec.pocsag-1.frequenciesHz").text).toBe("160.450 MHz")
		const extra = byId(rows, "dec.pocsag-1.extraArgs")
		expect(extra.widget.kind).toBe("read")
		expect(extra.lock).toBe("Set in the YAML configuration")
		expect(byId(rows, "dec.pocsag-1.apiKey").text).toBe("Set")
		expect(
			rows.every(
				r =>
					r.effect?.text === "Restarts POCSAG / FLEX" ||
					r.effect?.kind === "restart",
			),
		).toBe(true)
	})

	it("parses frequency lists in MHz and sends Hz", async () => {
		const a = actions()
		const rows = decoderRows(snapshot(), a)
		const f = byId(rows, "dec.pocsag-1.frequenciesHz")
		if (f.widget.kind !== "text") throw new Error("text")
		expect(f.widget.parse("160.450, 466.075")).toEqual({
			value: [160_450_000, 466_075_000],
		})
		expect("error" in f.widget.parse("abc")).toBe(true)
		await f.write?.([160_450_000])
		await byId(rows, "dec.pocsag-1").write?.(false)
		expect(a.calls).toEqual([
			["decoder", "pocsag-1", { options: { frequenciesHz: [160_450_000] } }],
			["decoder", "pocsag-1", { enabled: false }],
		])
	})

	it("has no editable page without the settings store", () => {
		const rows = decoderRows(
			snapshot({ decoderSettings: false, decoderViews: {} }),
			actions(),
		)
		expect(byId(rows, "dec.pocsag-1").write).toBeUndefined()
		expect(byId(rows, "dec.pocsag-1.enabled").lock).toContain(
			"open access mode",
		)
		expect(rows.some(r => r.id === "dec.pocsag-1.charset")).toBe(false)
	})

	it("names keys like people do", () => {
		expect(humanKey("sampleRate")).toBe("Sample rate")
		expect(humanKey("frequencies_hz")).toBe("Frequencies Hz")
		expect(humanKey("callTimeoutMs", "ms")).toBe("Call timeout")
		expect(humanKey("enableIqAgc")).toBe("Enable IQ AGC")
	})
})

describe("Settings items", () => {
	const rows = buildRows(snapshot(), actions())
	const base = {
		rows,
		query: "",
		filters: [],
		page: null,
		only: null,
		open: new Set<string>(),
		pageName: () => "POCSAG",
	}

	it("lists the eight groups with folds and the device block", () => {
		const items = settingsItems(base)
		expect(items.filter(i => i.kind === "head")).toHaveLength(8)
		const fold = items.find(i => i.kind === "fold" && i.key === "receiver")
		expect(fold).toMatchObject({ count: 3, open: false })
		expect(items.some(i => i.kind === "row" && i.row.id === "rx.direct")).toBe(
			false,
		)
		expect(items.some(i => i.kind === "device")).toBe(true)
		expect(items.some(i => i.kind === "nothing" && i.group === "map")).toBe(
			true,
		)
		const opened = settingsItems({ ...base, open: new Set(["receiver"]) })
		expect(opened.some(i => i.kind === "row" && i.row.id === "rx.direct")).toBe(
			true,
		)
	})

	it("shows one group on a phone and a decoder page", () => {
		const one = settingsItems({ ...base, only: "station" })
		expect(one.filter(i => i.kind === "head")).toHaveLength(0)
		expect(one.some(i => i.kind === "row" && i.row.group !== "station")).toBe(
			false,
		)
		const page = settingsItems({ ...base, page: "pocsag-1" })
		expect(page[0]).toEqual({ kind: "pagehead", page: "pocsag-1" })
		expect(page.at(-1)).toEqual({ kind: "status", page: "pocsag-1" })
	})

	it("searches names, aliases and values with breadcrumbs", () => {
		const sql = settingsItems({ ...base, query: "dongle" })
		expect(sql.some(i => i.kind === "row" && i.row.id === "rx.source")).toBe(
			true,
		)
		const fr = settingsItems({ ...base, query: "france" })
		expect(
			fr.some(i => i.kind === "row" && i.row.id === "station.country"),
		).toBe(true)
		const charset = settingsItems({ ...base, query: "charset" })
		const hit = charset.find(i => i.kind === "row")
		expect(hit && "crumb" in hit ? hit.crumb : "").toBe("Decoders › POCSAG")
		expect(settingsItems({ ...base, query: "zzzz" })).toEqual([
			{ kind: "none", q: "zzzz" },
		])
	})

	it("offers a typed filter and applies it", () => {
		expect(filterSuggestion("chang", [])).toBe("changed")
		expect(filterSuggestion("chang", ["changed"])).toBeNull()
		const changed = settingsItems({ ...base, filters: ["changed"] })
		const ids = changed.flatMap(i => (i.kind === "row" ? [i.row.id] : []))
		expect(ids).toContain("station.name")
		expect(ids).toContain("rx.ppm")
		expect(ids).not.toContain("station.country")
		const hw = settingsItems({ ...base, filters: ["hardware"] })
		expect(hw.flatMap(i => (i.kind === "row" ? [i.row.id] : []))).toEqual([
			"rx.biasT",
			"rx.direct",
			"rx.offset",
		])
	})

	it("offers the tuned card's three places, and where you left it", async () => {
		const a = actions()
		const named = byId(buildRows(snapshot(), a), "dev.card")
		expect(named.text).toBe("Above Listen")
		expect(named.device).toBe(true)
		expect(
			named.widget.kind === "select" && named.widget.options.map(o => o.label),
		).toEqual(["Above Listen", "Bottom right", "Top right"])
		const dragged = byId(buildRows(snapshot({ cardAt: "ml" }), a), "dev.card")
		expect(dragged.text).toBe("Where you left it")
		expect(
			dragged.widget.kind === "select" &&
				dragged.widget.options.map(o => o.value),
		).toEqual(["al", "br", "tr", "ml"])
		await dragged.write?.("tr")
		expect(a.calls).toContainEqual(["cardAt", "tr"])
	})

	it("keeps Density and Motion on this device, around the card position", async () => {
		const a = actions()
		const list = buildRows(
			snapshot({ device: { density: "compact", motion: "system" } }),
			a,
		)
		const ids = list.filter(r => r.device).map(r => r.id)
		expect(ids.indexOf("dev.density")).toBe(ids.indexOf("dev.card") - 1)
		expect(ids.indexOf("dev.motion")).toBe(ids.indexOf("dev.card") + 1)
		const density = byId(list, "dev.density")
		expect(density.text).toBe("Compact")
		const motion = byId(list, "dev.motion")
		expect(motion.text).toBe("Follow system")
		await motion.write?.("reduce")
		await density.write?.("comfy")
		expect(a.calls).toContainEqual(["device", { motion: "reduce" }])
		expect(a.calls).toContainEqual(["device", { density: "comfy" }])
	})

	it("crumbs device rows and matches accents loosely", () => {
		const theme = byId(rows, "dev.theme")
		expect(crumbOf(theme, () => "")).toBe("Display › On this device")
		expect(matches(haystack(theme, "Display"), "dark mode")).toBe(true)
		expect(
			matches(haystack(byId(rows, "rx.biasT"), "Receiver"), "bias t"),
		).toBe(true)
	})
})

describe("Apply", () => {
	it("sums up waiting changes and their effects", () => {
		const rows = buildRows(snapshot(), actions())
		expect(
			pendingSummary(
				[
					{ id: "rx.rate", value: "3200000" },
					{ id: "rx.biasT", value: true },
				],
				rows,
			),
		).toEqual({
			title: "2 changes waiting",
			sub: "Restarts the stream, turns on antenna power",
		})
	})

	it("copies a row as YAML", () => {
		const rows = buildRows(snapshot(), actions())
		expect(yamlLine(byId(rows, "rx.ppm"))).toBe("rx.ppm: 3")
		expect(yamlLine(byId(rows, "station.name"))).toBe(
			'station.name: "Roscoff station"',
		)
	})
})
