import { readFileSync } from "node:fs"

import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it } from "vitest"
import type {
	DecoderInfo,
	DigitalVoiceStatus,
	LiveAudioLevel,
	LiveAudioStatus,
	TunerState,
} from "@wavekit/api-types"

import { ServicesContext } from "../../src/app/context.ts"
import { createServices, type AppServices } from "../../src/app/services.ts"
import { listenSlot } from "../../src/features/listen/ListenIsland.tsx"
import {
	HEARD_HINT,
	PLAY_ANYWAY_TEXT,
	SOURCE_HINT,
	SQUELCH_HINT,
	VOICE_ONLY_HINT,
} from "../../src/features/listen/hints.ts"
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

/** A DMR call on the dsd-fme decoder the tuned 161.150 MHz is a target of. */
type CallOver = { encrypted?: boolean; encryptionKnown?: boolean }

function withCall(made: AppServices, call: CallOver): void {
	made.data.tuner.update(s => ({
		...s,
		bySource: {
			"rtl-0": { frequency: 161_150_000 } as unknown as TunerState,
		},
	}))
	made.decoders.update(s => ({
		...s,
		decoders: [
			{
				id: "dsd-fme",
				type: "dsd-fme",
				running: true,
				targetFrequenciesHz: [161_150_000],
			} as unknown as DecoderInfo,
		],
	}))
	const live = {
		decoderId: "dsd-fme",
		callId: "c1",
		protocol: "dmr",
		talkgroup: 2081,
		source: 2081045,
		slot: 1,
		encrypted: false,
		active: true,
		startedAt: "2026-11-16T00:00:00Z",
		...call,
	}
	made.data.digitalVoice.update(s => ({
		...s,
		status: {
			enabled: true,
			running: true,
			sampleRate: 8000,
			httpUrl: "http://localhost:3102/voice",
			wavUrl: "http://localhost:3102/voice.wav",
			decoders: [
				{
					decoderId: "dsd-fme",
					httpUrl: "http://localhost:3102/voice/dsd-fme",
					wavUrl: "http://localhost:3102/voice/dsd-fme.wav",
					call: live,
				},
			],
			call: live,
		} as unknown as DigitalVoiceStatus,
	}))
}

function setup(over: {
	phase?: ListenPhase
	audio?: Partial<AudioHealth>
	level?: Partial<LiveAudioLevel>
	status?: LiveAudioStatus
	call?: CallOver
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
	if (over.call) withCall(made, over.call)
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
		// what Play anyway does is its description, out of the reading flow
		const button = /<button[^>]*wkf-play-anyway[^>]*>/.exec(html)?.[0] ?? ""
		const id = /aria-describedby="([^"]+)"/.exec(button)?.[1]
		expect(id).toBeTruthy()
		// beside the button, not inside it: the button's name stays "Play anyway"
		expect(html).toMatch(
			new RegExp(
				`wkf-play-anyway[^>]*>Play anyway</button><span id="${id}" hidden="">`,
			),
		)
		expect(html).toContain(
			`<span id="${id}" hidden="">${PLAY_ANYWAY_TEXT}</span>`,
		)
	})

	it("says Live audio is off on a read-only browser while the core's live audio is stopped", () => {
		const made = setup({ status: { ...STATUS, running: false } })
		made.data.access.update(s => ({
			...s,
			access: { mode: "protected" } as unknown as typeof s.access,
			session: null,
		}))
		made.listen.update(s => ({ ...s, wanted: false, phase: "off" }))
		const ctx = { open: false, trigger: {} } as unknown as IslandContext
		const html = renderToStaticMarkup(
			createElement(
				ServicesContext.Provider,
				{ value: made },
				listenSlot.head(ctx),
			),
		)
		const id = /<button[^>]*disabled=""[^>]*aria-describedby="([^"]+)"/.exec(
			html,
		)?.[1]
		expect(id).toBeTruthy()
		expect(html).toContain(
			`<span class="wk-shell-sub" id="${id}">Live audio is off.</span>`,
		)
	})

	it("the disabled reason wins over the sweep line, so the description always points at a shown line", () => {
		// Listen on, a sweep running (the head would say "Following the scan"), and the core's status gone
		const made = setup({})
		made.data.scanner.update(s => ({
			...s,
			sweep: {
				id: "j1",
				state: "running",
				progress: { hopCount: 4 },
			} as unknown as typeof s.sweep,
		}))
		made.data.liveAudio.update(s => ({ ...s, status: null }))
		const ctx = { open: false, trigger: {} } as unknown as IslandContext
		const html = renderToStaticMarkup(
			createElement(
				ServicesContext.Provider,
				{ value: made },
				listenSlot.head(ctx),
			),
		)
		const id = /<button[^>]*disabled=""[^>]*aria-describedby="([^"]+)"/.exec(
			html,
		)?.[1]
		expect(id).toBeTruthy()
		expect(html).toContain(
			`<span class="wk-shell-sub" id="${id}">This WaveKit has no live audio.</span>`,
		)
		expect(html).not.toContain("Following the scan")
	})

	it("says why Listen is disabled, beside the button it describes", () => {
		const made = setup({})
		made.data.liveAudio.update(s => ({ ...s, status: null }))
		made.listen.update(s => ({ ...s, wanted: false, phase: "off" }))
		const ctx = { open: false, trigger: {} } as unknown as IslandContext
		const html = renderToStaticMarkup(
			createElement(
				ServicesContext.Provider,
				{ value: made },
				listenSlot.head(ctx),
			),
		)
		const id = /<button[^>]*disabled=""[^>]*aria-describedby="([^"]+)"/.exec(
			html,
		)?.[1]
		expect(id).toBeTruthy()
		expect(html).toContain(
			`<span class="wk-shell-sub" id="${id}">This WaveKit has no live audio.</span>`,
		)
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

	// the core never routes a call whose encryption is unknown or that is encrypted: `active` is not digital
	const HELD = {
		squelchOpen: true,
		autoSquelch: { state: "waiting" },
		autoRoute: { active: "none" },
	} as const

	it("says DMR voice · checking… while the call's encryption is not known, with no Play anyway", () => {
		const html = head({
			status: LISTEN_CORE,
			level: HELD,
			call: { encryptionKnown: false },
		})
		expect(html).toContain("DMR voice · checking…")
		expect(html).not.toContain("TG 2081")
		// turning Voice only off would only play the call's buzz
		expect(html).not.toContain("Play anyway")
		const digital = head({
			status: withConfig(LISTEN_CORE, { listenMode: "digital" }),
			level: HELD,
			call: { encryptionKnown: false },
		})
		expect(digital).toContain("<b>Quiet</b>")
		expect(digital).toContain("DMR voice · checking…")
	})

	it("says the DMR call is encrypted, with no Play anyway", () => {
		const html = head({
			status: LISTEN_CORE,
			level: HELD,
			call: { encrypted: true },
		})
		expect(html).toContain(">Encrypted DMR call<")
		expect(html).not.toContain("Play anyway")
	})

	it("says decoded voice is not played while the analog channel plays an encrypted call", () => {
		const html = head({
			status: LISTEN_CORE,
			level: {
				squelchOpen: true,
				autoSquelch: { state: "open" },
				autoRoute: { active: "analog" },
			},
			call: { encrypted: true },
		})
		expect(html).toContain("<b>Listening</b>")
		expect(html).toContain("Encrypted DMR call · analog only")
		expect(html).not.toContain("nothing to play")
	})

	it("names no held call where it could not play: Source Analog or Open", () => {
		for (const config of [
			{ listenMode: "analog" as const },
			{ squelchMode: "open" as const },
		]) {
			const html = head({
				status: withConfig(LISTEN_CORE, config),
				level: { ...HELD, autoSquelch: { state: "open", evidence: "voice" } },
				call: { encryptionKnown: false },
			})
			expect(html).not.toContain("checking…")
			expect(html).toContain("NFM · 161.150")
		}
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
		expect(html).toContain(VOICE_ONLY_HINT.text)
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
		expect(html).toMatch(
			/data-wk-source-hint="">.*No digital voice decoder here, so nothing plays\..*Use Auto/,
		)
	})

	it("says the call is encrypted or being checked under Source", () => {
		expect(
			panel({
				status: LISTEN_CORE,
				level: { autoRoute: { active: "none" } },
				call: { encrypted: true },
			}),
		).toContain("Encrypted DMR call: nothing to play.")
		expect(
			panel({
				status: LISTEN_CORE,
				level: { autoRoute: { active: "none" } },
				call: { encryptionKnown: false },
			}),
		).toContain("Checking DMR call…")
	})

	it("tags the squelch Quiet when the head says Quiet under Source Digital", () => {
		const level = {
			squelchOpen: true,
			autoSquelch: { state: "open", evidence: "voice" },
			autoRoute: { active: "none" },
		} as const
		const html = panel({
			status: withConfig(LISTEN_CORE, { listenMode: "digital" }),
			level,
		})
		expect(html).toMatch(/data-wk-squelch-state="">Quiet</)
		expect(html).not.toContain("Voice heard")
		// under Auto the same carrier passes as before
		expect(panel({ status: LISTEN_CORE, level })).toMatch(
			/data-wk-squelch-state="">Voice heard</,
		)
		expect(
			head({
				status: withConfig(LISTEN_CORE, { listenMode: "digital" }),
				level,
			}),
		).toContain("<b>Quiet</b>")
	})

	it("an old core gets no Source and no Voice only, and never crashes", () => {
		const old = withConfig(STATUS, { squelchMode: "auto" })
		const html = panel({ status: old })
		expect(html).toContain(">Auto<")
		expect(html).not.toContain(">Source<")
		expect(html).not.toContain("Voice only")
		// a manual squelch at 0 on an old core reads as Open
		expect(panel({ status: withConfig(STATUS, { squelch: 0 }) })).toContain(
			"Everything plays",
		)
	})

	it("wires every hint to its control: aria-describedby names the hidden sentence", () => {
		const html = panel({ status: LISTEN_CORE })
		const describedText = (id: string) =>
			new RegExp(`<span id="${id}" hidden="">([^<]*)</span>`).exec(html)?.[1]
		const groups = [
			["Squelch", SQUELCH_HINT.text],
			["Source", SOURCE_HINT.text],
		] as const
		for (const [name, text] of groups) {
			const id = new RegExp(
				`role="radiogroup" aria-label="${name}" aria-describedby="([^"]+)"`,
			).exec(html)?.[1]
			expect(id, name).toBeTruthy()
			expect(describedText(id ?? "")).toBe(text)
			expect(html).toContain(`aria-label="About ${name}"`)
		}
		const voice = /aria-describedby="([^"]+)"[^>]*role="switch"/.exec(html)
		expect(describedText(voice?.[1] ?? "")).toBe(VOICE_ONLY_HINT.text)
		// closed hints: the mark says so, and no bubble is in the page
		expect(html).toContain('aria-expanded="false"')
		expect(html).not.toContain('role="tooltip"')
	})

	it("leaves no title attributes in the Listen card", () => {
		const level = {
			squelchOpen: true,
			autoSquelch: { state: "waiting" },
		} as const
		for (const html of [
			panel({ status: LISTEN_CORE, audio: { missingMs: 4000, heardPct: 71 } }),
			head({ status: LISTEN_CORE, level }),
			head({ audio: { breaking: true, heardPct: 71 } }),
		])
			expect(html).not.toMatch(/\stitle="/)
	})

	it("says dB, Record and the delay, and drops the stream line", () => {
		const made = setup({ status: LISTEN_CORE })
		made.listen.update(s => ({ ...s, latencyMs: 180 }))
		// a browser that can record: the footer shows the delay, not why Record is off
		Object.defineProperty(made.listen, "canRecord", { get: () => true })
		const render = listenSlot.panel
		if (!render) throw new Error("the Listen island has a panel")
		const html = renderToStaticMarkup(
			createElement(
				ServicesContext.Provider,
				{ value: made },
				render({ open: true, trigger: {} } as unknown as IslandContext),
			),
		)
		expect(html).not.toContain("dBFS")
		expect(html).toMatch(/Opens above (the noise|−?\d+ dB)/)
		expect(html).toContain("Record<")
		expect(html).not.toContain("Record audio")
		expect(html).toContain("180 ms delay")
		expect(html).not.toContain("Not in this browser")
		expect(html).not.toContain("Latency")
		expect(html).not.toContain("audio · 1 listening")
		expect(html).not.toContain("This browser only")
		// Sound is folded and says what is behind it
		expect(html).toContain("Level, de-emphasis, filters")
		expect(html).not.toContain(">Level control<")
	})

	it("names the evidence in two words: Tone heard, Playing", () => {
		expect(
			panel({
				status: LISTEN_CORE,
				level: {
					squelchOpen: true,
					autoSquelch: { state: "open", evidence: "ctcss" },
					autoRoute: { active: "analog" },
				},
			}),
		).toMatch(/data-wk-squelch-state="">Tone heard</)
		expect(
			panel({
				status: LISTEN_CORE,
				level: {
					squelchOpen: true,
					autoSquelch: { state: "open" },
					autoRoute: { active: "analog" },
				},
			}),
		).toMatch(/data-wk-squelch-state="">Playing</)
	})

	it("shows the heard note with its hint only while audio went missing", () => {
		expect(panel({ status: LISTEN_CORE })).not.toContain("missing")
		const html = panel({
			status: LISTEN_CORE,
			audio: { missingMs: 17_400, heardPct: 71 },
		})
		expect(html).toContain("71% heard · 17.4 s missing")
		expect(html).toContain('aria-label="About the heard figure"')
		// the note itself is plain text: the mark carries the sentence
		expect(html).toContain("<span>71% heard · 17.4 s missing</span>")
		expect(html).toMatch(
			new RegExp(
				`aria-label="About the heard figure"[^>]*aria-describedby="[^"]+"[^>]*>[\\s\\S]*?hidden="">${HEARD_HINT.text}<`,
			),
		)
	})

	it("shows the settings link's short label wherever the long one hides", () => {
		const css = readFileSync(
			new URL("../../src/features/listen/listen.css", import.meta.url),
			"utf8",
		)
		// each media block's rules: whatever hides the long label shows the short one
		const blocks = css.split(/@media\s*/).slice(1)
		const hides = (b: string) =>
			/\.wkf-ls-long[^{]*\{\s*display:\s*none/.test(b)
		const shows = (b: string) =>
			/\.wkf-ls-short\s*\{\s*display:\s*inline/.test(b)
		const hiding = blocks.filter(hides)
		expect(hiding.length).toBeGreaterThan(0)
		for (const b of blocks) expect(shows(b), b.slice(0, 40)).toBe(hides(b))
	})

	it("names the settings link the same at every width", () => {
		const html = panel({ status: LISTEN_CORE })
		expect(html).toMatch(
			/<button[^>]*class="[^"]*wkf-listen-more[^"]*"[^>]*aria-label="All audio settings"|<button[^>]*aria-label="All audio settings"[^>]*class="[^"]*wkf-listen-more/,
		)
	})

	it("says Tone squelch is waiting for its tone while the gate holds the audio", () => {
		const tone = { kind: "ctcss", frequencyTenthsHz: 885 } as const
		const gated = {
			...withConfig(LISTEN_CORE, { toneSquelch: tone }),
			toneSquelch: { state: "waiting" },
		} as unknown as LiveAudioStatus
		expect(panel({ status: gated })).toMatch(
			/class="wkf-ls-now wkf-ls-tone">Waiting for 88\.5 Hz</,
		)
		const heard = {
			...gated,
			toneSquelch: { state: "open" },
		} as unknown as LiveAudioStatus
		expect(panel({ status: heard })).toMatch(
			/class="wkf-ls-now wkf-ls-tone">88\.5 Hz heard</,
		)
	})
})
