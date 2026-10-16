import { describe, expect, it } from "vitest"
import type { LiveAudioConfig, LiveAudioStatus } from "@wavekit/api-types"
import {
	audioAttachKey,
	audioSource,
	levelFraction,
	squelchSetting,
	squelchThreshold,
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
		})
		const rel = audioSource(
			status({ httpUrl: "/stream", wavUrl: "/stream.wav" }),
			BASE,
		)
		expect(rel?.httpUrl).toBe("http://localhost:5173/stream")
		expect(rel?.wavUrl).toBe("http://localhost:5173/stream.wav")
		expect(
			audioSource(status({ httpUrl: "", wavUrl: "" }), BASE),
		).toBeNull()
		expect(audioSource(status({}, { audioFormat: "f32le" }), BASE)?.format).toBe(
			"f32le",
		)
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
	it("reads off, auto and manual from the config", () => {
		expect(squelchSetting(null)).toEqual({ kind: "off" })
		expect(squelchSetting(status({}, { squelch: 0 }))).toEqual({ kind: "off" })
		expect(squelchSetting(status({}, { squelch: -72 }))).toEqual({
			kind: "manual",
			thresholdDbfs: -72,
		})
		expect(
			squelchSetting(status({}, { squelchMode: "auto", autoMarginDb: 8 })),
		).toEqual({ kind: "auto", marginDb: 8 })
		expect(squelchSetting(status({}, { squelchMode: "auto" }))).toEqual({
			kind: "auto",
			marginDb: 6,
		})
	})

	it("draws the live threshold, else the configured one", () => {
		expect(squelchThreshold({ kind: "off" }, -80)).toBeNull()
		expect(squelchThreshold({ kind: "manual", thresholdDbfs: -72 }, null)).toBe(
			-72,
		)
		expect(squelchThreshold({ kind: "manual", thresholdDbfs: -72 }, -70)).toBe(
			-70,
		)
		expect(squelchThreshold({ kind: "auto", marginDb: 6 }, -88)).toBe(-88)
		expect(squelchThreshold({ kind: "auto", marginDb: 6 }, null)).toBeNull()
	})
})
