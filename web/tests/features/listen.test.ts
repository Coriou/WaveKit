import { describe, expect, it } from "vitest"
import type { LiveAudioConfig, LiveAudioStatus } from "@wavekit/api-types"
import fc from "fast-check"
import {
	audioAttachKey,
	audioSource,
	levelFraction,
	listenContract,
	manualLevel,
	manualStart,
	meterThreshold,
	noiseSquelchFits,
	squelchForModulation,
	squelchPatch,
	squelchSetting,
	squelchThreshold,
	toggleOpenPatch,
	voiceOnlyFits,
} from "../../src/features/listen/audio.ts"

const BASE = "http://localhost:5173/"

const status = (
	over: Partial<LiveAudioStatus> = {},
	config: Partial<LiveAudioConfig> = {},
): LiveAudioStatus =>
	({
		running: true,
		sourceId: "pi",
		effectiveSampleRate: 16_000,
		httpUrl: "http://localhost:3102/stream",
		wavUrl: "http://localhost:3102/stream.wav",
		clientCount: 0,
		config: {
			modulation: "nfm",
			bandwidth: 12_500,
			squelch: 0,
			offsetHz: 0,
			audioFormat: "s16le",
			...config,
		},
		...over,
	}) as LiveAudioStatus

describe("levelFraction", () => {
	it("maps −120…−20 dBFS onto the bar and clamps", () => {
		expect(levelFraction(-120)).toBe(0)
		expect(levelFraction(-70)).toBe(0.5)
		expect(levelFraction(-20)).toBe(1)
		expect(levelFraction(-150)).toBe(0)
		expect(levelFraction(0)).toBe(1)
		expect(levelFraction(null)).toBe(0)
		expect(levelFraction(Number.NaN)).toBe(0)
	})
})

describe("audio follows tuning", () => {
	it("resolves the stream URLs, relative or absolute", () => {
		expect(audioSource(status(), BASE)).toEqual({
			httpUrl: "http://localhost:3102/stream",
			wavUrl: "http://localhost:3102/stream.wav",
			format: "s16le",
			rate: 16_000,
			credentials: false,
		})
		expect(audioSource(status(), BASE, true)?.credentials).toBe(true)
		const rel = audioSource(
			status({ httpUrl: "/stream", wavUrl: "/stream.wav" }),
			BASE,
		)
		expect(rel?.httpUrl).toBe("http://localhost:5173/stream")
		expect(rel?.wavUrl).toBe("http://localhost:5173/stream.wav")
		expect(audioSource(status({ httpUrl: "", wavUrl: "" }), BASE)).toBeNull()
		expect(
			audioSource(status({}, { audioFormat: "f32le" }), BASE)?.format,
		).toBe("f32le")
	})

	it("has nothing to attach while live audio is stopped", () => {
		expect(audioSource(status({ running: false }), BASE)).toBeNull()
		expect(audioAttachKey(audioSource(null, BASE))).toBeNull()
	})

	it("reattaches on a new URL, format or sample rate, never on tuning alone", () => {
		const key = (s: LiveAudioStatus) => audioAttachKey(audioSource(s, BASE))
		const a = key(status())
		expect(a).not.toBeNull()
		// retuning moves offsetHz (or the hardware centre): the stream follows, no reattach
		expect(key(status({}, { offsetHz: 25_000 }))).toBe(a)
		expect(key(status({ clientCount: 3 }, { squelch: -60 }))).toBe(a)
		expect(key(status({ effectiveSampleRate: 48_000 }))).not.toBe(a)
		expect(key(status({}, { audioFormat: "f32le" }))).not.toBe(a)
		expect(key(status({ httpUrl: "http://pi:8081/stream" }))).not.toBe(a)
		expect(key(status({ wavUrl: "http://pi:8081/stream.wav" }))).not.toBe(a)
	})
})

describe("squelch", () => {
	it("reads Auto, Manual and Open from the config", () => {
		expect(squelchSetting(null)).toEqual({ kind: "open" })
		expect(squelchSetting(status({}, { squelch: 0 }))).toEqual({ kind: "open" })
		expect(squelchSetting(status({}, { squelch: -72 }))).toEqual({
			kind: "manual",
			thresholdDbfs: -72,
		})
		expect(
			squelchSetting(
				status({}, { squelchMode: "auto", autoMarginDb: 8, voiceOnly: false }),
			),
		).toEqual({ kind: "auto", marginDb: 8, voiceOnly: false })
		// a core before the Listen contract: no voiceOnly, the voice check is on
		expect(squelchSetting(status({}, { squelchMode: "auto" }))).toEqual({
			kind: "auto",
			marginDb: 6,
			voiceOnly: true,
		})
		expect(
			squelchSetting(status({}, { squelchMode: "open", squelch: -60 })),
		).toEqual({ kind: "open" })
	})

	it("reads a manual squelch at 0 with a tone as Manual (a tone-only squelch), not Open", () => {
		expect(
			squelchSetting(
				status(
					{},
					{
						squelchMode: "manual",
						squelch: 0,
						toneSquelch: { kind: "ctcss", frequencyTenthsHz: 885 },
					},
				),
			),
		).toEqual({ kind: "manual", thresholdDbfs: -120 })
	})

	it("draws the spectrum line in Manual only, and marks the bar in Auto and Manual", () => {
		const manual = { kind: "manual", thresholdDbfs: -72 } as const
		const auto = { kind: "auto", marginDb: 6, voiceOnly: true } as const
		expect(squelchThreshold({ kind: "open" }, -80)).toBeNull()
		expect(squelchThreshold(manual, null)).toBe(-72)
		expect(squelchThreshold(manual, -70)).toBe(-70)
		expect(squelchThreshold(auto, -88)).toBeNull()
		expect(meterThreshold(auto, -88)).toBe(-88)
		expect(meterThreshold(auto, null)).toBeNull()
		expect(meterThreshold(manual, null)).toBe(-72)
		expect(meterThreshold({ kind: "open" }, -80)).toBeNull()
	})
})

describe("Listen contract send rules", () => {
	const cfg = (over: Partial<LiveAudioConfig>) =>
		({ ...status().config, ...over }) as LiveAudioConfig
	const listen = cfg({
		squelchMode: "auto",
		voiceOnly: true,
		listenMode: "auto",
		squelch: -60,
	})
	const old = cfg({ squelchMode: "auto", squelch: -60 })

	it("knows a Listen core by its voiceOnly, listenMode or open", () => {
		expect(listenContract(listen)).toBe(true)
		expect(listenContract(cfg({ listenMode: "analog" }))).toBe(true)
		expect(listenContract(cfg({ squelchMode: "open" }))).toBe(true)
		expect(listenContract(old)).toBe(false)
		expect(listenContract(null)).toBe(false)
	})

	it("always sends voiceOnly with Auto, keeping the current one unless told", () => {
		expect(squelchPatch(listen, { kind: "auto" })).toEqual({
			squelchMode: "auto",
			voiceOnly: true,
		})
		expect(
			squelchPatch(cfg({ ...listen, voiceOnly: false }), { kind: "auto" }),
		).toEqual({ squelchMode: "auto", voiceOnly: false })
		expect(squelchPatch(listen, { kind: "auto", voiceOnly: false })).toEqual({
			squelchMode: "auto",
			voiceOnly: false,
		})
		// from Open or Manual, Auto comes back with the voice check
		expect(
			squelchPatch(cfg({ ...listen, squelchMode: "open", voiceOnly: false }), {
				kind: "auto",
			}),
		).toEqual({ squelchMode: "auto", voiceOnly: true })
		// never the margin (Settings › More owns it)
		expect(squelchPatch(listen, { kind: "auto" })).not.toHaveProperty(
			"autoMarginDb",
		)
	})

	it("sends Open as open, or as manual at 0 to a core before the contract", () => {
		expect(squelchPatch(listen, { kind: "open" })).toEqual({
			squelchMode: "open",
		})
		expect(squelchPatch(old, { kind: "open" })).toEqual({
			squelchMode: "manual",
			squelch: 0,
		})
		// an old core never gets voiceOnly
		expect(squelchPatch(old, { kind: "auto", voiceOnly: false })).toEqual({
			squelchMode: "auto",
		})
	})

	// Bound: manual levels are whole dB in −120…−1 (0 means Open on the core).
	it("clamps Manual at −1 and −120 dBFS, at and past both bounds", () => {
		expect(manualLevel(-1)).toBe(-1)
		expect(manualLevel(-0.4)).toBe(-1)
		expect(manualLevel(0)).toBe(-1)
		expect(manualLevel(12)).toBe(-1)
		expect(manualLevel(-120)).toBe(-120)
		expect(manualLevel(-120.4)).toBe(-120)
		expect(manualLevel(-500)).toBe(-120)
		expect(manualLevel(Number.NaN)).toBe(-60)
		expect(manualLevel(null)).toBe(-60)
		expect(manualStart(cfg({ squelch: -72 }), -90)).toBe(-72)
		expect(manualStart(cfg({ squelch: 0 }), -90.6)).toBe(-91)
		expect(manualStart(cfg({ squelch: 0 }), null)).toBe(-60)
	})

	it("never sends Manual at 0 or above, whatever the level (property)", () => {
		// Feature: listen squelch, Property 1: Manual is always a non-zero threshold
		// Validates: Requirements 5
		fc.assert(
			fc.property(
				fc.oneof(
					fc.double({ noNaN: false }),
					fc.integer({ min: -1000, max: 1000 }),
				),
				fc.boolean(),
				(dbfs, newCore) => {
					const patch = squelchPatch(newCore ? listen : old, {
						kind: "manual",
						dbfs,
					})
					return (
						patch.squelchMode === "manual" &&
						typeof patch.squelch === "number" &&
						patch.squelch <= -1 &&
						patch.squelch >= -120 &&
						Number.isInteger(patch.squelch)
					)
				},
			),
			{ numRuns: 200 },
		)
	})

	it("Q opens and goes back to what was on before (property)", () => {
		// Feature: listen squelch, Property 2: Q twice returns to the squelch before Open
		// Validates: Requirements 3
		fc.assert(
			fc.property(
				fc.oneof(
					fc.record({
						squelchMode: fc.constant<"auto">("auto"),
						voiceOnly: fc.boolean(),
						squelch: fc.constant(-60),
					}),
					fc.record({
						squelchMode: fc.constant<"manual">("manual"),
						voiceOnly: fc.boolean(),
						squelch: fc.integer({ min: -120, max: -1 }),
					}),
				),
				over => {
					const before = status({}, { ...over, listenMode: "auto" })
					const first = toggleOpenPatch(before, null)
					if (first.patch.squelchMode !== "open" || first.remember === null)
						return false
					const opened = status(
						{},
						{ ...over, listenMode: "auto", squelchMode: "open" },
					)
					const back = toggleOpenPatch(opened, first.remember)
					return (
						back.remember === null &&
						back.patch.squelchMode === over.squelchMode &&
						(over.squelchMode === "auto"
							? back.patch.voiceOnly === over.voiceOnly
							: back.patch.squelch === over.squelch)
					)
				},
			),
			{ numRuns: 100 },
		)
	})

	it("Q from an Open nobody here chose goes back to Auto with the voice check", () => {
		const opened = status({}, { squelchMode: "open", listenMode: "auto" })
		expect(toggleOpenPatch(opened, null)).toEqual({
			patch: { squelchMode: "auto", voiceOnly: true },
			remember: null,
		})
		// an old core: Open is manual at 0, and back is plain auto
		const oldOpen = status({}, { squelchMode: "manual", squelch: 0 })
		expect(toggleOpenPatch(oldOpen, null).patch).toEqual({
			squelchMode: "auto",
		})
		expect(
			toggleOpenPatch(status({}, { squelchMode: "auto" }), null).patch,
		).toEqual({ squelchMode: "manual", squelch: 0 })
	})

	it("offers Voice only on NFM on a Listen core only", () => {
		expect(voiceOnlyFits(listen)).toBe(true)
		expect(voiceOnlyFits(cfg({ ...listen, modulation: "am" }))).toBe(false)
		expect(voiceOnlyFits(old)).toBe(false)
		expect(voiceOnlyFits(null)).toBe(false)
	})
})

describe("WG7 noise squelch (deprecated)", () => {
	it("reads noise as Auto without the voice check, with no power line", () => {
		const noise = squelchSetting(
			status({}, { squelchMode: "noise", noiseQuietingDb: 9, squelch: -40 }),
		)
		expect(noise).toEqual({ kind: "auto", marginDb: 6, voiceOnly: false })
		expect(squelchThreshold(noise, 0)).toBeNull()
	})

	it("fits FM only", () => {
		expect(noiseSquelchFits("nfm")).toBe(true)
		expect(noiseSquelchFits("wfm")).toBe(true)
		expect(noiseSquelchFits("am")).toBe(false)
		expect(noiseSquelchFits("usb")).toBe(false)
	})

	it("falls back to Auto and clears a tone gate on a modulation the core would refuse", () => {
		const cfg = (over: Partial<LiveAudioConfig>) =>
			({ ...status().config, ...over }) as LiveAudioConfig
		expect(
			squelchForModulation(
				cfg({ squelchMode: "noise", autoMarginDb: 8 }),
				"am",
			),
		).toEqual({ squelchMode: "auto", autoMarginDb: 8 })
		expect(squelchForModulation(cfg({ squelchMode: "noise" }), "wfm")).toEqual(
			{},
		)
		expect(
			squelchForModulation(
				cfg({ toneSquelch: { kind: "ctcss", frequencyTenthsHz: 885 } }),
				"wfm",
			),
		).toEqual({ toneSquelch: { kind: "none" } })
		expect(
			squelchForModulation(
				cfg({ toneSquelch: { kind: "ctcss", frequencyTenthsHz: 885 } }),
				"nfm",
			),
		).toEqual({})
		expect(squelchForModulation(cfg({ squelchMode: "auto" }), "am")).toEqual({})
		expect(squelchForModulation(undefined, "am")).toEqual({})
	})
})
