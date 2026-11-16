// Listen: the squelch (Auto, Manual, Open) and the Source are core settings. These tests pin the send rules
// on every path (Listen, Q, the palette and its Undo), the old-core fallback and that no change reattaches.
import fc from "fast-check"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { LiveAudioConfig, LiveAudioStatus } from "@wavekit/api-types"

import type { LiveAudioStore } from "../../src/data/index.ts"
import { runAction } from "../../src/features/palette/actions.ts"
import { shortcutFor } from "../../src/features/palette/keys.ts"
import {
	flatten,
	PaletteModel,
	type PaletteContext,
} from "../../src/features/palette/model.ts"
import { parseCommand } from "../../src/features/palette/parse.ts"
import {
	audioAttachKey,
	autoRouteSource,
} from "../../src/features/listen/audio.ts"
import {
	ListenController,
	type ListenPlayer,
} from "../../src/features/listen/controller.ts"
import {
	openSquelch,
	playAnyway,
	rememberedClosed,
	resetOpenMemory,
	toggleOpen,
} from "../../src/features/listen/squelch-actions.ts"
import { appToast } from "../../src/shell/toast.ts"
import { INITIAL_SHELL } from "../../src/shell/store.ts"
import { DEFAULT_THEME } from "../../src/shell/theme.ts"

const LISTEN_CONFIG = {
	enabled: true,
	httpPort: 3102,
	modulation: "nfm",
	bandwidth: 12_500,
	squelch: -60,
	squelchMode: "auto",
	voiceOnly: true,
	listenMode: "auto",
	autoMarginDb: 9,
	audioFormat: "s16le",
} as LiveAudioConfig

const OLD_CONFIG = {
	enabled: true,
	httpPort: 3102,
	modulation: "nfm",
	bandwidth: 12_500,
	squelch: -60,
	squelchMode: "auto",
	audioFormat: "s16le",
} as LiveAudioConfig

const AUTO_ROUTE = {
	active: "none",
	since: "2026-11-16T00:00:00Z",
	httpUrl: "http://localhost:3102/auto",
	wavUrl: "http://localhost:3102/auto.wav",
	clientCount: 1,
	digitalAvailable: true,
	underruns: 0,
	droppedMs: 0,
	clockRebases: 0,
	latencyMs: 60,
} as const

function status(config: LiveAudioConfig): LiveAudioStatus {
	return {
		running: true,
		sourceId: "rtl-0",
		effectiveSampleRate: 16_000,
		httpUrl: "http://localhost:3102/stream",
		wavUrl: "http://localhost:3102/stream.wav",
		clientCount: 1,
		config,
		autoRoute: { ...AUTO_ROUTE },
	} as unknown as LiveAudioStatus
}

/** A live-audio store that applies each PATCH as the core stores it (the Listen migration). */
function fakeStore(initial: LiveAudioConfig) {
	let current = status(initial)
	const patches: Partial<LiveAudioConfig>[] = []
	const store = {
		get: () => ({ status: current, level: null, error: null }),
		setConfig: vi.fn((patch: Partial<LiveAudioConfig>) => {
			patches.push(patch)
			const next = { ...current.config, ...patch }
			if (patch.squelchMode === "auto" && patch.voiceOnly === undefined)
				next.voiceOnly = true
			current = { ...current, config: next }
			return Promise.resolve(current)
		}),
	} as unknown as LiveAudioStore
	return { store, patches, config: () => current.config }
}

function fakeListen(wanted = false) {
	const start = vi.fn(() => Promise.resolve())
	return {
		listen: {
			get: () => ({ wanted }),
			start,
		} as unknown as ListenController,
		start,
	}
}

afterEach(() => {
	resetOpenMemory()
	appToast.set(null)
})

describe("Q: Open and back", () => {
	it("is the Q key (no longer the Squelch scope)", () => {
		expect(
			shortcutFor(
				{ key: "q", meta: false, ctrl: false, alt: false, typing: false },
				false,
			),
		).toEqual({ kind: "squelchOpen" })
		expect(
			shortcutFor(
				{ key: "Q", meta: false, ctrl: false, alt: false, typing: true },
				false,
			),
		).toBeNull()
	})

	it("opens (starting Listen here), then goes back to Auto with Voice only off as it was", async () => {
		const { store, patches } = fakeStore({ ...LISTEN_CONFIG, voiceOnly: false })
		const { listen, start } = fakeListen(false)
		await toggleOpen(store, listen)
		expect(start).toHaveBeenCalledTimes(1)
		expect(rememberedClosed()).toEqual({ kind: "auto", voiceOnly: false })
		await toggleOpen(store, listen)
		// going back never starts or stops Listen
		expect(start).toHaveBeenCalledTimes(1)
		expect(patches).toEqual([
			{ squelchMode: "open" },
			{ squelchMode: "auto", voiceOnly: false },
		])
	})

	it("goes back to Manual at its level", async () => {
		const { store, patches } = fakeStore({
			...LISTEN_CONFIG,
			squelchMode: "manual",
			squelch: -72,
		})
		const { listen } = fakeListen(true)
		await toggleOpen(store, listen)
		await toggleOpen(store, listen)
		expect(patches[1]).toEqual({ squelchMode: "manual", squelch: -72 })
	})

	it("from default to hearing noise is one key: Q starts Listen and opens", async () => {
		const { store, patches } = fakeStore(LISTEN_CONFIG)
		const { listen, start } = fakeListen(false)
		await toggleOpen(store, listen)
		expect(start).toHaveBeenCalledTimes(1)
		expect(patches).toEqual([{ squelchMode: "open" }])
	})

	it("on an old core opens as manual at 0 and goes back to plain auto", async () => {
		const { store, patches } = fakeStore(OLD_CONFIG)
		const { listen } = fakeListen(true)
		await toggleOpen(store, listen)
		await toggleOpen(store, listen)
		expect(patches).toEqual([
			{ squelchMode: "manual", squelch: 0 },
			{ squelchMode: "auto" },
		])
	})

	it("Open from the panel remembers the squelch it replaced", async () => {
		const { store } = fakeStore({
			...LISTEN_CONFIG,
			squelchMode: "manual",
			squelch: -80,
		})
		const { listen, start } = fakeListen(false)
		await openSquelch(store, listen)
		expect(start).toHaveBeenCalledTimes(1)
		expect(rememberedClosed()).toEqual({ kind: "manual", dbfs: -80 })
	})
})

describe("Play anyway", () => {
	it("turns Voice only off, keeps Auto, and Undo turns it back on", async () => {
		const { store, patches } = fakeStore(LISTEN_CONFIG)
		expect(await playAnyway(store)).toBe(true)
		const toast = appToast.get()
		expect(toast?.text).toMatch(/Voice only is off/)
		toast?.undo?.()
		await Promise.resolve()
		expect(patches).toEqual([
			{ squelchMode: "auto", voiceOnly: false },
			{ squelchMode: "auto", voiceOnly: true },
		])
	})

	it("a refused PATCH shows no toast and never rejects", async () => {
		const store = {
			get: () => ({ status: status(LISTEN_CONFIG), level: null, error: null }),
			setConfig: () => Promise.reject(new Error("403")),
		} as unknown as LiveAudioStore
		expect(await playAnyway(store)).toBe(false)
		expect(appToast.get()).toBeNull()
	})
})

function ctx(config: LiveAudioConfig | null): PaletteContext {
	return {
		tunedHz: 161_150_000,
		config,
		listening: true,
		volume: 0.5,
		stepHz: 12_500,
		chosenStepHz: null,
		receiver: null,
		readOnly: false,
		accessMode: null,
		theme: DEFAULT_THEME,
		saved: null,
		bandplan: null,
		discoveries: [],
		presets: [],
		sweep: null,
		shell: INITIAL_SHELL,
		recent: [],
		boost: () => 0,
	}
}

describe("palette: squelch and Source", () => {
	it("Squelch offers Auto, Manual, Open and Voice only, never Noise or Off", () => {
		const items = flatten(new PaletteModel(ctx(LISTEN_CONFIG)).build("sq", ""))
		const titles = items.map(i => i.title)
		expect(titles.slice(0, 5)).toEqual([
			"Auto",
			"Manual",
			"Open",
			"Voice only",
			"Every carrier",
		])
		expect(titles).not.toContain("Noise")
		expect(titles).not.toContain("Off")
		const patch = (title: string) => {
			const action = items.find(i => i.title === title)?.action
			return action?.kind === "audio" ? action.patch : null
		}
		expect(patch("Auto")).toEqual({ squelchMode: "auto", voiceOnly: true })
		expect(patch("Manual")).toEqual({ squelchMode: "manual", squelch: -60 })
		expect(patch("Open")).toEqual({ squelchMode: "open" })
		expect(patch("Every carrier")).toEqual({
			squelchMode: "auto",
			voiceOnly: false,
		})
		expect(patch("−80 dB") ?? patch("-80 dB")).toEqual({
			squelchMode: "manual",
			squelch: -80,
		})
		// an old core: no Voice only rows, Open is manual at 0
		const old = flatten(new PaletteModel(ctx(OLD_CONFIG)).build("sq", ""))
		expect(old.map(i => i.title)).not.toContain("Voice only")
		const openOld = old.find(i => i.title === "Open")?.action
		expect(openOld).toEqual({
			kind: "audio",
			patch: { squelchMode: "manual", squelch: 0 },
		})
	})

	it("reads `sq open` and the old `sq off` as Open", () => {
		expect(parseCommand("sq open")).toEqual({ kind: "squelch", value: "open" })
		expect(parseCommand("sq off")).toEqual({ kind: "squelch", value: "off" })
		const off = flatten(
			new PaletteModel(ctx(LISTEN_CONFIG)).build(null, "sq off"),
		)[0]
		expect(off?.title).toBe("Squelch › Open")
		expect(off?.action).toEqual({
			kind: "audio",
			patch: { squelchMode: "open" },
		})
	})

	it("the root has Open the squelch on Q, and Source on a Listen core only", () => {
		const root = flatten(new PaletteModel(ctx(LISTEN_CONFIG)).build(null, ""))
		const open = root.find(i => i.id === "tog:open")
		expect(open?.kbd).toEqual(["Q"])
		expect(open?.title).toBe("Open the squelch")
		expect(open?.action).toEqual({ kind: "squelchOpen" })
		expect(root.find(i => i.id === "scope:sq")?.kbd).toBeUndefined()
		expect(root.find(i => i.id === "scope:src")?.value).toBe("Auto")
		const opened = flatten(
			new PaletteModel(ctx({ ...LISTEN_CONFIG, squelchMode: "open" })).build(
				null,
				"",
			),
		)
		expect(opened.find(i => i.id === "tog:open")?.title).toBe(
			"Close the squelch",
		)
		const old = flatten(new PaletteModel(ctx(OLD_CONFIG)).build(null, ""))
		expect(old.find(i => i.id === "scope:src")).toBeUndefined()
		expect(new PaletteModel(ctx(OLD_CONFIG)).build("src", "")).toEqual([])
	})

	it("Source sets the core's listenMode", () => {
		const items = flatten(
			new PaletteModel(ctx({ ...LISTEN_CONFIG, listenMode: "analog" })).build(
				"src",
				"",
			),
		)
		expect(items.map(i => [i.title, i.cur])).toEqual([
			["Auto", false],
			["Analog", true],
			["Digital", false],
		])
		expect(items[2]?.action).toEqual({
			kind: "audio",
			patch: { listenMode: "digital" },
		})
	})

	it("Undo keeps the send rules: Auto with its voiceOnly, Manual with its level", async () => {
		const run = async (
			config: LiveAudioConfig,
			patch: Partial<LiveAudioConfig>,
		) => {
			const { store, patches } = fakeStore(config)
			const s = { data: { liveAudio: store } } as unknown as Parameters<
				typeof runAction
			>[0]
			const result = await runAction(s, { kind: "audio", patch }, "done")
			result.undo?.()
			return patches
		}
		expect(
			await run(
				{ ...LISTEN_CONFIG, voiceOnly: false },
				{ squelchMode: "open" },
			),
		).toEqual([
			{ squelchMode: "open" },
			{ squelchMode: "auto", voiceOnly: false },
		])
		expect(
			await run(
				{ ...LISTEN_CONFIG, squelchMode: "manual", squelch: -77 },
				{ squelchMode: "open" },
			),
		).toEqual([
			{ squelchMode: "open" },
			{ squelchMode: "manual", squelch: -77 },
		])
	})
})

describe("a Source or squelch change never reattaches the stream", () => {
	const BASE = "http://localhost:5173/"
	const listenStatus = fc.record({
		squelchMode: fc.constantFrom<"auto" | "manual" | "open">(
			"auto",
			"manual",
			"open",
		),
		voiceOnly: fc.boolean(),
		listenMode: fc.constantFrom<"auto" | "analog" | "digital">(
			"auto",
			"analog",
			"digital",
		),
		squelch: fc.integer({ min: -120, max: -1 }),
		autoMarginDb: fc.integer({ min: 0, max: 40 }),
	})

	it("keeps the attach key for every squelch and Source (property)", () => {
		// Feature: listen squelch, Property 3: the played stream does not depend on squelch or Source
		// Validates: Requirements 4
		const key = audioAttachKey(autoRouteSource(status(LISTEN_CONFIG), BASE))
		expect(key).not.toBeNull()
		fc.assert(
			fc.property(listenStatus, over => {
				const s = status({ ...LISTEN_CONFIG, ...over })
				return audioAttachKey(autoRouteSource(s, BASE)) === key
			}),
			{ numRuns: 200 },
		)
	})

	it("attaches once across a run of changes, Source through all three and Q twice", async () => {
		const { store, config } = fakeStore(LISTEN_CONFIG)
		const plays: string[] = []
		const player: ListenPlayer = {
			unlock: () => undefined,
			play: s => void plays.push(s.url),
			stop: () => undefined,
			setVolume: () => undefined,
			dispose: () => undefined,
		}
		const liveAudio = {
			...store,
			get: store.get,
			setConfig: store.setConfig,
			load: () => Promise.resolve(),
			start: () => Promise.resolve(),
			stop: () => Promise.resolve(),
			readAutoRoute: () => Promise.resolve(null),
		} as unknown as LiveAudioStore
		const c = new ListenController(liveAudio, { createPlayer: () => player })
		const feed = () => {
			const src = autoRouteSource(status(config()), BASE)
			c.setSource(audioAttachKey(src), src)
		}
		feed()
		await c.start()
		expect(c.attachCount).toBe(1)
		for (const listenMode of ["analog", "digital", "auto"] as const) {
			await liveAudio.setConfig({ listenMode })
			feed()
		}
		await toggleOpen(liveAudio, c)
		feed()
		await toggleOpen(liveAudio, c)
		feed()
		await playAnyway(liveAudio)
		feed()
		expect(c.attachCount).toBe(1)
		expect(plays).toEqual(["http://localhost:3102/auto"])
		c.dispose()
	})
})
