import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it } from "vitest"
import type { LiveAudioLevel, LiveAudioStatus } from "@wavekit/api-types"

import { ServicesContext } from "../../src/app/context.ts"
import { createServices, type AppServices } from "../../src/app/services.ts"
import { listenSlot } from "../../src/features/listen/ListenIsland.tsx"
import type { AudioHealth } from "../../src/features/listen/audio-health.ts"
import { NO_AUDIO_HEALTH } from "../../src/features/listen/audio-health.ts"
import type { ListenPhase } from "../../src/features/listen/controller.ts"
import type { IslandContext } from "../../src/shell/ShellIsland.tsx"

let services: AppServices | null = null
afterEach(() => {
	services?.dispose()
	services = null
})

const STATUS = {
	running: true,
	sourceId: "rtl-0",
	squelchOpen: true,
	effectiveSampleRate: 25_000,
	httpUrl: "http://localhost:3102/stream",
	clientCount: 1,
	pipelineHealth: "running",
	config: {
		modulation: "nfm",
		bandwidth: 12_500,
		squelch: -60,
		squelchMode: "manual",
		offsetHz: 0,
		audioFormat: "s16le",
		highPass: 0,
		noiseReduction: "off",
	},
} as unknown as LiveAudioStatus

/** A core that speaks the Listen contract, on Auto with Voice only. */
const LISTEN_CORE = {
	...STATUS,
	config: {
		...STATUS.config,
		squelchMode: "auto",
		voiceOnly: true,
		listenMode: "auto",
	},
	autoRoute: {
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
		listenMode: "auto",
	},
} as unknown as LiveAudioStatus

function withConfig(
	status: LiveAudioStatus,
	config: Partial<LiveAudioStatus["config"]>,
): LiveAudioStatus {
	return { ...status, config: { ...status.config, ...config } }
}

function setup(over: {
	phase?: ListenPhase
	audio?: Partial<AudioHealth>
	level?: Partial<LiveAudioLevel>
	status?: LiveAudioStatus
}): AppServices {
	// no core: every read fails, nothing is fetched while rendering
	const made = createServices({
		fetch: async () => {
			throw new TypeError("offline")
		},
		createSocket: () => ({
			readyState: 0,
			onopen: null,
			onclose: null,
			onerror: null,
			onmessage: null,
			send: () => undefined,
			close: () => undefined,
		}),
	})
	services = made
	made.data.liveAudio.update(s => ({
		...s,
		status: over.status ?? STATUS,
		level: {
			squelchOpen: true,
			...over.level,
		} as LiveAudioLevel,
	}))
	made.listen.update(s => ({
		...s,
		wanted: true,
		phase: over.phase ?? "playing",
		audio: { ...NO_AUDIO_HEALTH, ...over.audio },
	}))
	return made
}

function head(over: Parameters<typeof setup>[0]): string {
	const made = setup(over)
	const ctx = { open: false, trigger: {} } as unknown as IslandContext
	return renderToStaticMarkup(
		createElement(
			ServicesContext.Provider,
			{ value: made },
			listenSlot.head(ctx),
		),
	)
}

const BREAKING = { breaking: true, heardPct: 71, missingMs: 17_400 }

describe("the Listen card", () => {
	it("says Listening and breaking up, with the figure, while it is", () => {
		const html = head({ audio: BREAKING })
		expect(html).toContain("<b>Listening</b>")
		expect(html).toContain("Breaking up · 71% heard")
		expect(html).toContain("data-breaking")
	})

	it("keeps saying breaking up, without a figure, when the core has gone unread", () => {
		const html = head({ audio: { breaking: true, heardPct: null } })
		expect(html).toContain("<b>Listening</b>")
		expect(html).toContain("Breaking up")
		expect(html).not.toContain("% heard")
	})

	it("claims no figure with nothing known", () => {
		const html = head({ audio: { heardPct: null } })
		expect(html).toContain("<b>Listening</b>")
		expect(html).not.toContain("Breaking up")
		expect(html).not.toContain("% heard")
	})

	it("says a clean Listening while the audio is fine", () => {
		const html = head({ audio: { heardPct: 100 } })
		expect(html).toContain("<b>Listening</b>")
		expect(html).not.toContain("Breaking up")
	})

	it("a closed squelch has nothing to break up", () => {
		const html = head({ audio: BREAKING, level: { squelchOpen: false } })
		expect(html).toContain("<b>Quiet</b>")
		expect(html).not.toContain("Breaking up")
	})

	it("Connecting… is not also breaking up", () => {
		const html = head({ audio: BREAKING, phase: "connecting" })
		expect(html).toContain("<b>Connecting…</b>")
		expect(html).not.toContain("Breaking up")
	})
})

describe("the Listen card's head states", () => {
	it("says Waiting for voice with Play anyway while the voice check holds a carrier", () => {
		const html = head({
			status: LISTEN_CORE,
			level: { squelchOpen: true, autoSquelch: { state: "waiting" } },
		})
		expect(html).toContain("<b>Waiting for voice</b>")
		expect(html).toContain("Play anyway")
	})

	it("says Listening once voice is heard, Quiet with nothing on the air", () => {
		expect(
			head({
				status: LISTEN_CORE,
				level: {
					squelchOpen: true,
					autoSquelch: { state: "open", evidence: "voice" },
				},
			}),
		).toContain("<b>Listening</b>")
		const quiet = head({
			status: LISTEN_CORE,
			level: { squelchOpen: false, autoSquelch: { state: "waiting" } },
		})
		expect(quiet).toContain("<b>Quiet</b>")
		expect(quiet).not.toContain("Play anyway")
	})

	it("says Open for an open squelch, whatever is on the air", () => {
		const html = head({
			status: withConfig(LISTEN_CORE, { squelchMode: "open" }),
			level: { squelchOpen: false },
		})
		expect(html).toContain("<b>Open</b>")
	})

	it("says DMR voice under Listening while a decoded call plays", () => {
		const html = head({
			status: LISTEN_CORE,
			level: {
				squelchOpen: true,
				autoSquelch: { state: "waiting" },
				autoRoute: { active: "digital", protocol: "dmr" },
			},
		})
		expect(html).toContain("<b>Listening</b>")
		expect(html).toContain("DMR voice")
		expect(html).not.toContain("Play anyway")
	})

	it("an old core (no voiceOnly) waits for voice as before, with no Play anyway", () => {
		const old = withConfig(STATUS, { squelchMode: "auto" })
		const html = head({
			status: old,
			level: { squelchOpen: true, autoSquelch: { state: "waiting" } },
		})
		expect(html).toContain("<b>Waiting for voice</b>")
		expect(html).not.toContain("Play anyway")
	})
})

function panel(over: Parameters<typeof setup>[0]): string {
	const made = setup(over)
	const ctx = { open: true, trigger: {} } as unknown as IslandContext
	const render = listenSlot.panel
	if (!render) throw new Error("the Listen island has a panel")
	return renderToStaticMarkup(
		createElement(ServicesContext.Provider, { value: made }, render(ctx)),
	)
}

describe("the Audio options panel", () => {
	it("offers Auto, Manual and Open, Voice only under Auto, and Source", () => {
		const html = panel({ status: LISTEN_CORE })
		for (const label of ["Auto", "Manual", "Open", "Analog", "Digital"])
			expect(html).toContain(`>${label}<`)
		expect(html).toContain("Voice only")
		expect(html).toContain(
			"Skips carriers, data and pagers. Voice starts about 1 s late, nothing is cut.",
		)
		expect(html).toContain(">Source<")
		// Noise left the UI (Noise reduction under Sound is another thing)
		expect(html).not.toContain(">Noise<")
		expect(html).not.toContain("Noise squelch")
		expect(html).not.toContain("6 dB")
	})

	it("hides Voice only in Manual, Open and off NFM", () => {
		for (const config of [
			{ squelchMode: "manual" as const, squelch: -70 },
			{ squelchMode: "open" as const },
			{ modulation: "am" as const },
		])
			expect(panel({ status: withConfig(LISTEN_CORE, config) })).not.toContain(
				"Voice only",
			)
	})

	it("offers Auto when Digital has no decoder on the channel", () => {
		const html = panel({
			status: withConfig(LISTEN_CORE, { listenMode: "digital" }),
			level: { autoRoute: { active: "none", reason: "no-decoder" } },
		})
		expect(html).toContain(
			"No digital voice decoder on this channel: nothing plays.",
		)
		expect(html).toContain("Use Auto")
	})

	it("an old core gets no Source and no Voice only, and never crashes", () => {
		const old = withConfig(STATUS, { squelchMode: "auto" })
		const html = panel({ status: old })
		expect(html).toContain(">Auto<")
		expect(html).not.toContain(">Source<")
		expect(html).not.toContain("Voice only")
		// a manual squelch at 0 on an old core reads as Open
		expect(panel({ status: withConfig(STATUS, { squelch: 0 }) })).toContain(
			"Open · everything plays",
		)
	})
})
