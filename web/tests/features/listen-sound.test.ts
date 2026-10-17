import { describe, expect, it } from "vitest"
import fc from "fast-check"
import type {
	ActivitySummary,
	DecoderInfo,
	DigitalVoiceStatus,
	LiveAudioConfig,
	LiveAudioStatus,
} from "@wavekit/api-types"
import { voiceSource } from "../../src/features/listen/audio.ts"
import {
	recordClock,
	recordFileName,
	RECORD_MAX_S,
	WavRecorder,
} from "../../src/features/listen/recorder.ts"
import {
	agcOf,
	deemphOf,
	deemphPatch,
	hearHint,
	offeredTone,
	playsDigital,
	sameTone,
	toneOfSummary,
	toneSquelchFits,
	toneSquelchPatch,
	toneText,
	voiceRoute,
} from "../../src/features/listen/sound.ts"

const config = (over: Partial<LiveAudioConfig> = {}): LiveAudioConfig =>
	({
		modulation: "nfm",
		bandwidth: 12_500,
		squelch: 0,
		deEmphasis: false,
		deEmphasisTau: 50,
		highPass: 0,
		lowPass: 0,
		noiseReduction: "off",
		...over,
	}) as LiveAudioConfig

const tx = (
	fields: ActivitySummary["fields"],
	kind: ActivitySummary["kind"] = "analog-transmission",
): ActivitySummary =>
	({
		eventId: `e${Math.random()}`,
		kind,
		frequencyHz: 160_625_000,
		fields,
	}) as unknown as ActivitySummary

const dsd = (over: Partial<DecoderInfo> = {}): DecoderInfo =>
	({
		id: "dsd-fme",
		type: "dsd-fme",
		running: true,
		targetFrequenciesHz: [161_150_000],
		...over,
	}) as DecoderInfo

const voice = (call: DigitalVoiceStatus["call"] = null): DigitalVoiceStatus =>
	({
		enabled: true,
		running: true,
		sampleRate: 8000,
		httpUrl: "http://localhost:8082/stream",
		wavUrl: "http://localhost:8082/stream.wav",
		decoders: [
			{
				decoderId: "dsd-fme",
				httpUrl: "http://localhost:8082/dsd-fme",
				wavUrl: "http://localhost:8082/dsd-fme.wav",
				call,
			},
		],
		call,
	}) as unknown as DigitalVoiceStatus

describe("Listen › Sound", () => {
	it("reads the level control from the running chain, then config, then the modulation default", () => {
		const st = (over: Partial<LiveAudioStatus>, c: Partial<LiveAudioConfig>) =>
			({ ...over, config: config(c) }) as LiveAudioStatus
		expect(agcOf(st({ agc: "slow" }, { agc: "fast" }))).toBe("slow")
		expect(agcOf(st({}, { agc: "fast" }))).toBe("fast")
		expect(agcOf(st({}, { modulation: "am" }))).toBe("fast")
		expect(agcOf(st({}, { modulation: "nfm" }))).toBe("off")
	})

	it("round-trips de-emphasis through the patch", () => {
		for (const v of ["off", "50", "75"] as const)
			expect(deemphOf(config(deemphPatch(v) as Partial<LiveAudioConfig>))).toBe(
				v,
			)
	})
})

describe("Listen › Tone squelch", () => {
	it("reads CTCSS and DCS from a transmission summary", () => {
		expect(
			toneOfSummary(tx([{ key: "ctcssHz", label: "CTCSS", value: 88.5 }])),
		).toEqual({
			kind: "ctcss",
			frequencyTenthsHz: 885,
		})
		expect(
			toneOfSummary(tx([{ key: "dcs", label: "DCS", value: "023I" }])),
		).toEqual({
			kind: "dcs",
			code: "023",
			polarity: "inverted",
		})
		expect(
			toneOfSummary(tx([{ key: "dcs", label: "DCS", value: "9x" }])),
		).toBeNull()
		expect(
			toneOfSummary(
				tx([{ key: "ctcssHz", label: "CTCSS", value: 88.5 }], "call-lifecycle"),
			),
		).toBeNull()
	})

	it("offers the gate's tone first, else the latest transmission's", () => {
		const items = [
			tx([{ key: "ctcssHz", label: "CTCSS", value: 77 }]),
			tx([{ key: "ctcssHz", label: "CTCSS", value: 88.5 }]),
		]
		expect(offeredTone(undefined, items)).toEqual({
			kind: "ctcss",
			frequencyTenthsHz: 770,
		})
		expect(
			offeredTone({ kind: "dcs", code: "023", polarity: "normal" }, items),
		).toEqual({ kind: "dcs", code: "023", polarity: "normal" })
		// the latest transmission had no tone: nothing to offer
		expect(offeredTone({ kind: "none" }, [tx([]), ...items])).toBeNull()
		expect(offeredTone(undefined, [])).toBeNull()
	})

	it("words tones and limits the gate to NFM", () => {
		expect(toneText({ kind: "ctcss", frequencyTenthsHz: 1230 })).toBe(
			"123.0 Hz",
		)
		expect(toneText({ kind: "dcs", code: "023", polarity: "normal" })).toBe(
			"DCS 023N",
		)
		expect(toneSquelchFits("nfm")).toBe(true)
		expect(toneSquelchFits("am")).toBe(false)
		expect(
			toneSquelchPatch(false, { kind: "ctcss", frequencyTenthsHz: 885 }),
		).toEqual({
			toneSquelch: { kind: "none" },
		})
	})

	it("compares tones by value", () => {
		// Feature: web-listen, Property 1: a tone equals itself and its text tells tones apart
		fc.assert(
			fc.property(
				fc.integer({ min: 600, max: 3000 }),
				fc.integer({ min: 600, max: 3000 }),
				(a, b) => {
					const ta = { kind: "ctcss" as const, frequencyTenthsHz: a }
					const tb = { kind: "ctcss" as const, frequencyTenthsHz: b }
					expect(sameTone(ta, ta)).toBe(true)
					expect(sameTone(ta, tb)).toBe(toneText(ta) === toneText(tb))
				},
			),
			{ numRuns: 100 },
		)
	})
})

describe("Listen › What you hear", () => {
	it("routes decoded voice from a running dsd-fme decoder on the channel", () => {
		const call = {
			decoderId: "dsd-fme",
			callId: "c1",
			protocol: "dmr",
			talkgroup: 2081,
			source: 2081045,
			slot: 1,
			encrypted: false,
			active: true,
			startedAt: "2026-10-17T17:00:00Z",
		}
		const route = voiceRoute([dsd()], voice(call), 161_152_000, 6250)
		expect(route).toMatchObject({
			decoderId: "dsd-fme",
			protocol: "DMR",
			httpUrl: "http://localhost:8082/dsd-fme",
			rate: 8000,
			active: true,
			call: "TG 2081 · radio 2081045",
		})
		expect(voiceRoute([dsd()], voice(), 162_000_000, 6250)).toBeNull()
		expect(
			voiceRoute([dsd({ running: false })], voice(), 161_150_000, 6250),
		).toBeNull()
		expect(voiceRoute([dsd()], null, 161_150_000, 6250)).toBeNull()
	})

	it("plays decoded voice only with a route, and says what plays", () => {
		const route = voiceRoute([dsd()], voice(), 161_150_000, 6250)
		expect(playsDigital("auto", route)).toBe(true)
		expect(playsDigital("analog", route)).toBe(false)
		expect(playsDigital("digital", null)).toBe(false)
		expect(hearHint("auto", null, "NFM")).toBe(
			"No digital voice decoder on this channel. Playing NFM audio.",
		)
		expect(hearHint("analog", route, "NFM")).toBe(
			"Playing demodulated NFM audio.",
		)
		expect(hearHint("digital", route, "NFM")).toBe(
			"Digital voice decoder on this channel. Playing decoded voice.",
		)
	})

	it("makes the voice stream reachable from the page", () => {
		const src = voiceSource(
			{
				httpUrl: "http://localhost:8082/x",
				wavUrl: "http://localhost:8082/x.wav",
				rate: 8000,
			},
			"http://wavekit.lan:5173/",
		)
		expect(src).toEqual({
			httpUrl: "http://wavekit.lan:8082/x",
			wavUrl: "http://wavekit.lan:8082/x.wav",
			format: "s16le",
			rate: 8000,
			credentials: false,
		})
	})
})

describe("Listen › Record audio", () => {
	it("writes a 16-bit mono WAV of what it was given", async () => {
		const rec = new WavRecorder(0)
		expect(rec.push(new Float32Array([0, 1, -1, 0.5]), 8000)).toBe(true)
		expect(rec.seconds).toBeCloseTo(4 / 8000)
		const buf = new DataView(await rec.toWav().arrayBuffer())
		expect(buf.byteLength).toBe(44 + 8)
		expect(buf.getUint32(24, true)).toBe(8000)
		expect(buf.getUint32(40, true)).toBe(8)
		expect(buf.getInt16(46, true)).toBe(0x7fff)
		expect(buf.getInt16(48, true)).toBe(-0x8000)
	})

	it("ends on a rate change and at the length cap", () => {
		const rec = new WavRecorder(0)
		rec.push(new Float32Array(10), 8000)
		expect(rec.push(new Float32Array(10), 16000)).toBe(false)
		const big = new WavRecorder(0)
		expect(big.push(new Float32Array(RECORD_MAX_S * 10 + 5), 10)).toBe(false)
		expect(big.seconds).toBe(RECORD_MAX_S)
	})

	it("names the file and the clock", () => {
		expect(recordClock(7.9)).toBe("0:07")
		expect(recordClock(750)).toBe("12:30")
		const name = recordFileName(
			161_150_000,
			new Date(2026, 9, 17, 17, 5, 9).getTime(),
		)
		expect(name).toBe("WaveKit 161.150 MHz 2026-10-17 17-05-09.wav")
	})
})
