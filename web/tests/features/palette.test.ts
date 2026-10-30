import fc from "fast-check"
import { describe, expect, it } from "vitest"
import type { LiveAudioConfig, SavedFrequency } from "@wavekit/api-types"

import { buildResolvedBandPlan, SCANNER_BANDPLANS } from "../../mock/data.ts"
import { presetsOf } from "../../src/features/scanner/planner/plan.ts"
import { shortcutFor } from "../../src/features/palette/keys.ts"
import {
	flatten,
	initialIndex,
	PaletteModel,
	type PaletteContext,
	type RankedItem,
} from "../../src/features/palette/model.ts"
import {
	parseCommand,
	parseFrequencyIntent,
	parseIdentifiers,
	parsePasted,
} from "../../src/features/palette/parse.ts"
import {
	frecency,
	fuzzy,
	rank,
	RECENT_KEY,
	RecentList,
} from "../../src/features/palette/rank.ts"
import { INITIAL_SHELL } from "../../src/shell/store.ts"
import { DEFAULT_THEME } from "../../src/shell/theme.ts"

const T0 = "2026-10-14T08:00:00.000Z"
function saved(
	id: string,
	name: string,
	frequencyHz: number,
	over: Partial<SavedFrequency> = {},
): SavedFrequency {
	return {
		id,
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

const config = (over: Partial<LiveAudioConfig> = {}): LiveAudioConfig =>
	({
		enabled: true,
		httpPort: 3102,
		modulation: "nfm",
		bandwidth: 12_500,
		squelch: 0,
		squelchMode: "auto",
		autoMarginDb: 6,
		...over,
	}) as LiveAudioConfig

const SAVED = [
	saved("s1", "Marine ch 16", 156_800_000, { group: "Marine" }),
	saved("s2", "DMR repeater", 161_150_000, { group: "Local" }),
]

function ctx(over: Partial<PaletteContext> = {}): PaletteContext {
	return {
		tunedHz: 161_150_000,
		config: config(),
		listening: false,
		volume: 0.72,
		stepHz: 12_500,
		chosenStepHz: null,
		receiver: {
			gainAuto: false,
			gainTenthsDb: 280,
			gainSteps: [
				0, 9, 14, 27, 37, 77, 87, 125, 144, 157, 166, 197, 207, 229, 254, 280,
				297, 328, 338, 364, 372, 386, 402, 421, 434, 439, 445, 480, 496,
			],
			sampleRateHz: 2_400_000,
			rates: [1_024_000, 2_048_000, 2_400_000, 3_200_000],
			biasTee: false,
			rtlAgc: false,
			lockReason: null,
		},
		readOnly: false,
		accessMode: null,
		theme: DEFAULT_THEME,
		saved: SAVED,
		bandplan: buildResolvedBandPlan(),
		discoveries: [],
		presets: presetsOf(SCANNER_BANDPLANS),
		sweep: null,
		shell: INITIAL_SHELL,
		recent: [],
		boost: () => 0,
		...over,
	}
}

const titles = (items: readonly RankedItem[]) => items.map(x => x.title)

describe("palette: what the field understands", () => {
	it("reads pasted frequencies in the board's forms", () => {
		const hz = (s: string) => {
			const p = parseFrequencyIntent(s, 161_150_000)
			return p.kind === "ok" ? p.hz : null
		}
		expect(hz("161.150.000")).toBe(161_150_000)
		expect(hz("161 150 000")).toBe(161_150_000)
		expect(hz("446,00625 MHz")).toBe(446_006_250)
		expect(hz("161150000")).toBe(161_150_000)
		expect(hz("161.15")).toBe(161_150_000)
		expect(hz("+25k")).toBe(161_175_000)
	})

	it("takes the mode and a trailing bandwidth from pasted text", () => {
		const p = parsePasted("Freq: 118.700 MHz AM", 0)
		expect(p).toMatchObject({
			kind: "ok",
			hz: 118_700_000,
			mode: "am",
			pasted: true,
		})
		const q = parsePasted("Ch 16: 156.800 MHz NFM 12.5 kHz", 0)
		expect(q).toMatchObject({
			hz: 156_800_000,
			mode: "nfm",
			bandwidthHz: 12_500,
		})
	})

	it("never reads command words as frequencies", () => {
		expect(parseFrequencyIntent("gain 30", 0).kind).toBe("none")
		expect(parseFrequencyIntent("step 6.25k", 0).kind).toBe("none")
		expect(parseFrequencyIntent("bw 25k", 0).kind).toBe("none")
	})

	it("parses commands with values", () => {
		expect(parseCommand("gain 30")).toEqual({ kind: "gain", db: 30 })
		expect(parseCommand("gain auto")).toEqual({ kind: "gain", db: "auto" })
		expect(parseCommand("sq 90")).toEqual({ kind: "squelch", value: -90 })
		expect(parseCommand("sq off")).toEqual({ kind: "squelch", value: "off" })
		expect(parseCommand("bw 25k")).toEqual({ kind: "bandwidth", hz: 25_000 })
		expect(parseCommand("bw 25")).toEqual({ kind: "bandwidth", hz: 25_000 })
		expect(parseCommand("step 6.25k")).toEqual({ kind: "step", hz: 6250 })
		expect(parseCommand("vol 60")).toEqual({ kind: "volume", percent: 60 })
		expect(parseCommand("rate 2.048")).toEqual({ kind: "rate", msps: 2.048 })
		expect(parseCommand("am")).toEqual({ kind: "mode", mode: "am" })
		expect(parseCommand("fm")).toEqual({ kind: "mode", mode: "nfm" })
		expect(parseCommand("amber")).toBeNull()
	})

	it("offers talkgroup, capcode and MMSI for digits by length", () => {
		expect(parseIdentifiers("2081").map(x => x.kind)).toEqual(["talkgroup"])
		expect(parseIdentifiers("1234567").map(x => x.kind)).toEqual([
			"talkgroup",
			"capcode",
		])
		expect(parseIdentifiers("227006760")).toEqual([
			{ kind: "mmsi", value: "227006760" },
		])
		expect(parseIdentifiers("tg 2081")).toEqual([
			{ kind: "talkgroup", value: "2081" },
		])
	})

	it("any frequency the Tuner shows round-trips through the grouped form", () => {
		// Feature: web-palette, Property 1: grouped digits parse back to the same Hz
		fc.assert(
			fc.property(fc.integer({ min: 24_000_000, max: 1_900_000_000 }), hz => {
				const s = String(hz).padStart(10, "0")
				const grouped = `${Number(s.slice(0, 4))}.${s.slice(4, 7)}.${s.slice(7)}`
				const p = parseFrequencyIntent(grouped, 0)
				return p.kind === "ok" && p.hz === hz
			}),
			{ numRuns: 200 },
		)
	})
})

describe("palette: ranking", () => {
	it("prefers a prefix, then a word start, then letters in order", () => {
		const a = fuzzy("gain", "Gain")
		const b = fuzzy("gain", "RTL gain")
		const c = fuzzy("gn", "Gain")
		expect(a && b && c).toBeTruthy()
		expect(a!.score).toBeGreaterThan(b!.score)
		expect(b!.score).toBeGreaterThan(c!.score)
		expect(fuzzy("zz", "Gain")).toBeNull()
	})

	it("matches keywords a little below titles", () => {
		const items = [
			{ id: "a", title: "Theme", keys: ["dark mode"] },
			{ id: "b", title: "Dark ground" },
		]
		expect(rank(items, "dark").map(x => x.id)).toEqual(["b", "a"])
	})

	it("remembers what ran, newest and most used first", () => {
		const map = new Map<string, string>()
		const storage = {
			getItem: (k: string) => map.get(k) ?? null,
			setItem: (k: string, v: string) => void map.set(k, v),
		}
		const r = new RecentList(storage)
		r.used("a", 0)
		r.used("b", 1000)
		r.used("b", 2000)
		expect(r.ids(3000)).toEqual(["b", "a"])
		expect(new RecentList(storage).ids(3000)).toEqual(["b", "a"])
		expect(map.has(RECENT_KEY)).toBe(true)
		// a week-old entry counts less than a fresh one
		expect(frecency({ id: "x", n: 2, t: 0 }, 7 * 86_400_000)).toBeLessThan(1)
	})

	it("survives a broken or blocked storage", () => {
		const bad = {
			getItem: () => "{not json",
			setItem: () => {
				throw new Error("quota")
			},
		}
		const r = new RecentList(bad)
		expect(r.ids(0)).toEqual([])
		r.used("a", 0)
		expect(r.ids(0)).toEqual(["a"])
	})
})

describe("palette: rows", () => {
	it("opens on Suggested, Saved and All commands with Tune first", () => {
		const g = new PaletteModel(ctx()).build(null, "")
		expect(g.map(x => x.label)).toEqual([
			"Suggested",
			"Saved frequencies",
			"All commands",
		])
		expect(flatten(g)[0]?.title).toBe("Tune to a frequency…")
		// tuned on a saved frequency: no Save or Identify suggestion
		expect(g[0]!.items.map(x => x.id)).not.toContain("scope:save")
	})

	it("lists saved frequencies when the tuned one is not saved", () => {
		const g = new PaletteModel(ctx({ tunedHz: 160_000_000 })).build(null, "")
		expect(g.map(x => x.label)).toEqual([
			"Suggested",
			"Saved frequencies",
			"All commands",
		])
		const sugg = g[0]!.items.map(x => x.id)
		expect(sugg).toContain("scope:save")
		expect(sugg).toContain("identify")
	})

	it("puts a typed frequency first, big, with what it changes", () => {
		const g = new PaletteModel(ctx()).build(null, "156.8")
		const first = flatten(g)[0]
		expect(g[0]?.label).toBe("Tune")
		expect(first).toMatchObject({ title: "Tune to 156.800 MHz", big: true })
		expect(first?.effects?.[0]).toEqual({
			label: "Frequency",
			from: "161.150 MHz",
			to: "156.800 MHz",
		})
	})

	it("applies a pasted mode and lists it in the effects", () => {
		const g = new PaletteModel(ctx()).build(null, "Freq: 118.700 MHz AM")
		const first = flatten(g)[0]
		expect(first?.action).toEqual({ kind: "tune", hz: 118_700_000, mode: "am" })
		expect(first?.sub).toMatch(/^From pasted text/)
		expect(first?.effects?.map(e => e.label)).toEqual(["Frequency", "Mode"])
	})

	it("snaps `gain 30` to the nearest step of the gain table", () => {
		const it = flatten(new PaletteModel(ctx()).build(null, "gain 30"))[0]
		expect(it?.title).toBe("Gain › 29.7 dB")
		expect(it?.action).toEqual({ kind: "gain", tenthsDb: 297 })
		expect(it?.sub).toMatch(/Nearest step/)
	})

	it("refuses a bandwidth out of the mode's range with a note", () => {
		const it = flatten(new PaletteModel(ctx()).build(null, "bw 100k"))[0]
		expect(it).toMatchObject({
			info: true,
			title: "NFM allows 5 kHz to 25 kHz",
		})
	})

	it("reads `sq 90` as −90 dB", () => {
		const it = flatten(new PaletteModel(ctx()).build(null, "sq 90"))[0]
		expect(it?.action).toEqual({
			kind: "audio",
			patch: { squelchMode: "manual", squelch: -90 },
		})
	})

	it("finds scope values from the root", () => {
		const items = flatten(new PaletteModel(ctx()).build(null, "graphite"))
		expect(titles(items)).toContain("Dark ground › Graphite")
		const g = items.find(x => x.title === "Dark ground › Graphite")
		expect(g?.preview).toEqual({ kind: "theme", patch: { ground: "graphite" } })
	})

	it("lists every registry setting, after its inline row", () => {
		const items = flatten(new PaletteModel(ctx()).build(null, "theme"))
		const t = titles(items)
		const inline = t.indexOf("Theme")
		expect(inline).toBeGreaterThanOrEqual(0)
		expect(t[inline + 1]).toBe("Theme — Display")
		expect(items[inline + 1]?.opens).toBe("Open in Settings ›")
	})

	it("lists Signed-in devices only on a protected core, found by sign out", () => {
		const find = (accessMode: "legacy" | "protected" | null) =>
			titles(
				flatten(new PaletteModel(ctx({ accessMode })).build(null, "sign out")),
			).includes("Signed-in devices — System")
		expect(find("protected")).toBe(true)
		expect(find("legacy")).toBe(false)
		expect(find(null)).toBe(false)
	})

	it("offers Activity lookups for digits, search last", () => {
		const g = new PaletteModel(ctx()).build(null, "2081")
		const act = g.find(x => x.label === "Activity")
		expect(act?.items.map(x => x.id)).toEqual(["find:tg2081", "search:2081"])
		expect(act?.items[0]?.action).toMatchObject({
			kind: "activity",
			tokens: [{ kind: "talkgroup", value: "2081" }],
		})
	})

	it("starts a scope's cursor on the current value", () => {
		const m = new PaletteModel(
			ctx({ config: config({ modulation: "am", bandwidth: 10_000 }) }),
		)
		const g = m.build("mode", "")
		const i = initialIndex(g, "mode")
		expect(flatten(g)[i]?.title).toBe("AM")
	})

	it("offers Decode as… with one Identify per protocol", () => {
		const m = new PaletteModel(ctx())
		const root = flatten(m.build(null, "decode as"))
		expect(root[0]).toMatchObject({ id: "scope:decode", scope: "decode" })
		const rows = m.scopeItems("decode")
		expect(rows.find(r => r.id === "decode:dmr")?.action).toEqual({
			kind: "identify",
			hz: 161_150_000,
			protocols: ["dmr"],
		})
		expect(
			new PaletteModel(ctx({ readOnly: true })).scopeItems("decode"),
		).toEqual([])
	})

	it("reads typed text in a value scope as that command", () => {
		const g = new PaletteModel(ctx()).build("bw", "20")
		expect(g[0]?.label).toBe("Set")
		expect(g[0]?.items[0]).toMatchObject({ title: "20 kHz" })
	})

	it("names a save from the field, in the band's group first", () => {
		const m = new PaletteModel(ctx({ tunedHz: 156_650_000 }))
		const rows = flatten(m.build("save", "Bridge"))
		expect(rows[0]?.action).toMatchObject({
			kind: "save",
			hz: 156_650_000,
			name: "Bridge",
		})
		expect(rows.map(r => r.title)[0]).toMatch(/^Save as “Bridge” in /)
		const already = flatten(new PaletteModel(ctx()).build("save", ""))
		expect(already[0]).toMatchObject({
			info: true,
			title: "Already saved as “DMR repeater”",
		})
	})

	it("lists the scan presets and starts them in Scan a band", () => {
		const rows = flatten(new PaletteModel(ctx()).build("scan", ""))
		expect(rows.length).toBe(presetsOf(SCANNER_BANDPLANS).length + 1)
		expect(rows[0]?.action).toMatchObject({ kind: "scanPlan" })
	})

	it("shows receiver rows as notes when the tuner is locked", () => {
		const locked = ctx({
			receiver: { ...ctx().receiver!, lockReason: "Read-only" },
		})
		const rows = flatten(new PaletteModel(locked).build("gain", ""))
		expect(rows.every(r => r.info && !r.action)).toBe(true)
	})

	it("only previews local, side-effect-free choices", () => {
		const m = new PaletteModel(ctx())
		const all = [
			...m.rootCommands(),
			...m.deepItems(),
			...m.scopeItems("gain"),
			...m.scopeItems("rate"),
			...m.scopeItems("sq"),
			...m.scopeItems("vol"),
		]
		for (const it of all.filter(x => x.preview))
			expect(["theme", "step", "volume"]).toContain(it.preview!.kind)
		expect(m.scopeItems("rate").some(x => x.preview)).toBe(false)
	})

	it("rebuilds recent rows from their ids", () => {
		const m = new PaletteModel(
			ctx({ recent: ["tune:118100000", "accent:ice", "gone"] }),
		)
		const g = m.build(null, "")
		const recent = g.find(x => x.label === "Recent")
		expect(recent?.items.map(x => x.title)).toEqual([
			"Tune to 118.100 MHz",
			"Accent › Ice",
		])
	})
})

describe("palette: single-key shortcuts", () => {
	const key = (
		k: string,
		over: Partial<Parameters<typeof shortcutFor>[0]> = {},
	) => ({
		key: k,
		meta: false,
		ctrl: false,
		alt: false,
		typing: false,
		...over,
	})

	it("maps the board's keys", () => {
		expect(shortcutFor(key("t"), false)).toEqual({
			kind: "scope",
			scope: "tune",
		})
		expect(shortcutFor(key("M"), false)).toEqual({
			kind: "scope",
			scope: "mode",
		})
		expect(shortcutFor(key("]"), false)).toEqual({ kind: "step", dir: 1 })
		expect(shortcutFor(key("?"), false)).toEqual({
			kind: "scope",
			scope: "keys",
		})
		expect(shortcutFor(key("g"), false)).toEqual({ kind: "goPrefix" })
		expect(shortcutFor(key("c"), true)).toEqual({
			kind: "drawer",
			id: "scanner",
		})
		expect(shortcutFor(key("m"), true)).toEqual({ kind: "view", id: "map" })
	})

	it("stays out of text fields and modified keys", () => {
		expect(shortcutFor(key("t", { typing: true }), false)).toBeNull()
		expect(shortcutFor(key("k", { meta: true }), false)).toBeNull()
		expect(shortcutFor(key("x"), true)).toBeNull()
	})
})

describe("palette: running rows", async () => {
	const { runAction, applyPreview } =
		await import("../../src/features/palette/actions.ts")
	const { shellStore } = await import("../../src/shell/store.ts")
	const { themeStore } = await import("../../src/shell/theme.ts")
	const { settingFocus, SETTINGS_REGISTRY } =
		await import("../../src/features/settings/registry.ts")
	const { scannerUi } = await import("../../src/features/scanner/ui-store.ts")
	const { setupStore } =
		await import("../../src/features/scanner/planner/draft-store.ts")

	function fakes() {
		const calls: unknown[] = []
		let step: number | null = null
		let volume = 0.5
		const tuner = { sourceId: "rtl-0", gainMode: "manual", gain: 280 }
		const services = {
			data: {
				tuner: { state: () => tuner },
				liveAudio: {
					get: () => ({ status: { config: config() } }),
					setConfig: async (p: unknown) => void calls.push(["audio", p]),
				},
				receiver: {
					write: async (id: string, s: unknown) => (
						calls.push(["write", id, s]),
						true
					),
					setManualGain: async (id: string, t: number) => (
						calls.push(["gain", id, t]),
						true
					),
				},
				scanner: { get: () => ({ bandplans: SCANNER_BANDPLANS, sweep: null }) },
				scanPresets: { get: () => ({ view: null }) },
			},
			tuning: {
				displayHz: () => 161_150_000,
				tune: async (hz: number) => void calls.push(["tune", hz]),
				get: () => ({ error: null }),
			},
			prefs: {
				get: () => ({ stepHz: step }),
				setStep: (hz: number | null) => void (step = hz),
			},
			listen: {
				get: () => ({ volume }),
				setVolume: (v: number) => void (volume = v),
			},
			activity: {
				setSearch: (t: unknown, c: unknown) =>
					void calls.push(["search", t, c]),
			},
		}
		return {
			services: services as never,
			calls,
			step: () => step,
			volume: () => volume,
		}
	}

	it("sets the theme with Undo", async () => {
		const before = themeStore.getState()
		const f = fakes()
		const r = await runAction(
			f.services,
			{ kind: "theme", patch: { accent: "ice" } },
			"Accent Ice",
		)
		expect(r.text).toBe("Accent Ice")
		expect(themeStore.getState().accent).toBe("ice")
		r.undo?.()
		expect(themeStore.getState()).toEqual(before)
	})

	it("previews and reverts local choices", () => {
		const f = fakes()
		const off = applyPreview(f.services, { kind: "volume", value: 0.9 })
		expect(f.volume()).toBe(0.9)
		off()
		expect(f.volume()).toBe(0.5)
		const off2 = applyPreview(f.services, { kind: "step", hz: 25_000 })
		expect(f.step()).toBe(25_000)
		off2()
		expect(f.step()).toBeNull()
	})

	it("snaps a manual gain and undoes to the gain before", async () => {
		const f = fakes()
		const r = await runAction(
			f.services,
			{ kind: "gain", tenthsDb: 297 },
			"Gain 29.7 dB",
		)
		r.undo?.()
		expect(f.calls).toEqual([
			["gain", "rtl-0", 297],
			["gain", "rtl-0", 280],
		])
	})

	it("opens Activity on a talkgroup", async () => {
		const f = fakes()
		await runAction(
			f.services,
			{
				kind: "activity",
				tokens: [{ kind: "talkgroup", value: "2081" }],
				label: "x",
			},
			null,
		)
		expect(shellStore.getState().drawer).toBe("activity")
		expect(f.calls[0]).toEqual([
			"search",
			[{ kind: "talkgroup", value: "2081", label: "TG 2081" }],
			null,
		])
	})

	it("opens a setting where it lives and asks it to highlight", async () => {
		const f = fakes()
		const entry = SETTINGS_REGISTRY.find(e => e.id === "dev.accent")!
		await runAction(f.services, { kind: "setting", entry }, null)
		expect(shellStore.getState().drawer).toBe("settings")
		expect(settingFocus.get().id).toBe("dev.accent")
		const saved = SETTINGS_REGISTRY.find(e => e.id === "tn.saved")!
		await runAction(f.services, { kind: "setting", entry: saved }, null)
		expect(shellStore.getState().panel).toBe("tuner")
	})

	it("starts Scan a band with the chosen preset", async () => {
		const f = fakes()
		const preset = presetsOf(SCANNER_BANDPLANS)[0]!
		await runAction(f.services, { kind: "scanPlan", presetId: preset.id }, null)
		expect(shellStore.getState().drawer).toBe("scanner")
		expect(scannerUi.get().planOpen).toBe(true)
		expect(
			setupStore.get().draft.ranges.every(r => r.preset === preset.id),
		).toBe(true)
		expect(setupStore.get().draft.ranges.length).toBeGreaterThan(0)
	})
})

describe("palette: cursor in lists", () => {
	it("starts list scopes on their first row", () => {
		const g = new PaletteModel(ctx()).build("keys", "")
		expect(initialIndex(g, "keys")).toBe(0)
	})
})

describe("palette: values from the root", () => {
	it("a value's own name beats a scope's keyword", () => {
		const first = flatten(new PaletteModel(ctx()).build(null, "light"))[0]
		expect(first?.title).toBe("Theme › Light")
		expect(first?.action).toEqual({ kind: "theme", patch: { theme: "light" } })
	})
})

describe("palette: receiver feed", () => {
	const feedRow = (over: Partial<PaletteContext>) =>
		flatten(new PaletteModel(ctx(over)).build(null, "receiver")).filter(
			x => x.id === "tog:feed",
		)
	const live = { sourceId: "rtl-0", state: "live", busy: false } as const

	it("offers Pause receiver while live and Resume receiver while paused, never both", () => {
		const [pause, ...restLive] = feedRow({ feed: live })
		expect(restLive).toHaveLength(0)
		expect(pause).toMatchObject({
			title: "Pause receiver",
			kbd: ["P"],
			action: { kind: "feed", op: "pause", sourceId: "rtl-0" },
			done: "Receiver paused",
		})
		for (const state of ["paused", "error"] as const) {
			const rows = feedRow({ feed: { ...live, state } })
			expect(rows).toHaveLength(1)
			expect(rows[0]).toMatchObject({
				title: "Resume receiver",
				action: { kind: "feed", op: "resume" },
			})
		}
		expect(feedRow({ feed: { ...live, state: "error" } })[0]?.sub).toBe(
			"The last resume failed · resume again to retry",
		)
	})

	it("finds them by what people call it", () => {
		const find = (q: string, over: Partial<PaletteContext>) =>
			flatten(new PaletteModel(ctx(over)).build(null, q)).some(
				x => x.id === "tog:feed",
			)
		expect(find("pause", { feed: live })).toBe(true)
		expect(find("freeze waterfall", { feed: live })).toBe(true)
		expect(find("resume", { feed: { ...live, state: "paused" } })).toBe(true)
	})

	it("is a note, not a command, while read-only or a call is in flight", () => {
		const ro = feedRow({ feed: live, readOnly: true })[0]
		expect(ro?.info).toBe(true)
		expect(ro?.action).toBeUndefined()
		const busy = feedRow({ feed: { ...live, busy: true } })[0]
		expect(busy).toMatchObject({ info: true, sub: "Pausing the receiver…" })
		expect(busy?.action).toBeUndefined()
		const resuming = feedRow({ feed: { ...live, state: "resuming" } })[0]
		expect(resuming).toMatchObject({
			title: "Resume receiver",
			info: true,
			sub: "Resuming the receiver…",
		})
	})

	it("has no row without a feed (a recording, no source)", () => {
		expect(feedRow({})).toHaveLength(0)
		expect(feedRow({ feed: null })).toHaveLength(0)
	})

	it("lists P among the shortcuts and maps the key", () => {
		const keys = new PaletteModel(ctx({ feed: live })).scopeItems("keys")
		expect(keys.find(x => x.id === "tog:feed")?.kbd).toEqual(["P"])
		const key = (k: string, typing = false) =>
			shortcutFor(
				{ key: k, meta: false, ctrl: false, alt: false, typing },
				false,
			)
		expect(key("p")).toEqual({ kind: "feed" })
		expect(key("P")).toEqual({ kind: "feed" })
		expect(key("p", true)).toBeNull()
	})
})
