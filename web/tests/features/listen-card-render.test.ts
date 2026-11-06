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
		squelch: 0,
		offsetHz: 0,
		audioFormat: "s16le",
		highPass: 0,
		noiseReduction: "off",
	},
} as unknown as LiveAudioStatus

function setup(over: {
	phase?: ListenPhase
	audio?: Partial<AudioHealth>
	level?: Partial<LiveAudioLevel>
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
		status: STATUS,
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

	it("says a clean Listening while the audio is fine", () => {
		const html = head({ audio: { heardPct: 100 } })
		expect(html).toContain("<b>Listening</b>")
		expect(html).not.toContain("Breaking up")
	})

	it("a closed squelch has nothing to break up", () => {
		const html = head({ audio: BREAKING, level: { squelchOpen: false } })
		expect(html).toContain("<b>Squelched</b>")
		expect(html).not.toContain("Breaking up")
	})

	it("Connecting… is not also breaking up", () => {
		const html = head({ audio: BREAKING, phase: "connecting" })
		expect(html).toContain("<b>Connecting…</b>")
		expect(html).not.toContain("Breaking up")
	})
})
