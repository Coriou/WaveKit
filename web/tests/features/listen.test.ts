import { describe, expect, it } from "vitest"
import type { LiveAudioConfig, LiveAudioStatus } from "@wavekit/api-types"
import {
	audioAttachKey,
	levelFraction,
	squelchSetting,
	squelchThreshold,
	streamUrl,
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
		wavUrl: "http://localhost:3102/stream.wav",
		clientCount: 0,
		config: {
			modulation: "nfm",
			bandwidth: 12_500,
			squelch: 0,
			offsetHz: 0,
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
	it("resolves the stream URL, relative or absolute", () => {
		expect(streamUrl(status(), BASE)).toBe("http://localhost:3102/stream.wav")
		expect(streamUrl(status({ wavUrl: "/stream.wav" }), BASE)).toBe(
			"http://localhost:5173/stream.wav",
		)
		expect(streamUrl({ ...status(), wavUrl: "" }, BASE)).toBeNull()
		expect(streamUrl(null, BASE)).toBeNull()
	})

	it("has nothing to attach while live audio is stopped", () => {
		expect(
			audioAttachKey(status({ running: false }), 161_150_000, BASE),
		).toBeNull()
		expect(audioAttachKey(null, 161_150_000, BASE)).toBeNull()
	})

	it("changes the attach key when the tuning, URL or sample rate changes, not otherwise", () => {
		const a = audioAttachKey(status(), 161_150_000, BASE)
		expect(a).not.toBeNull()
		expect(
			audioAttachKey(
				status({ clientCount: 3 }, { squelch: -60 }),
				161_150_000,
				BASE,
			),
		).toBe(a)
		expect(audioAttachKey(status(), 161_175_000, BASE)).not.toBe(a)
		expect(
			audioAttachKey(
				status({ effectiveSampleRate: 48_000 }),
				161_150_000,
				BASE,
			),
		).not.toBe(a)
		expect(
			audioAttachKey(
				status({ wavUrl: "http://pi:8081/stream.wav" }),
				161_150_000,
				BASE,
			),
		).not.toBe(a)
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
