import { describe, expect, it } from "vitest"
import fc from "fast-check"
import type {
	ActivitySummary,
	DecoderInfo,
	DigitalVoiceStatus,
	LiveAudioConfig,
	LiveAudioStatus,
} from "@wavekit/api-types"
import {
	autoRouteSource,
	voiceSource,
} from "../../src/features/listen/audio.ts"
import {
	recordClock,
	recordFileName,
	RECORD_MAX_S,
	WavRecorder,
} from "../../src/features/listen/recorder.ts"
import {
	agcOf,
	autoRouteNow,
	autoSquelchNow,
	coreRouteHint,
	coreRoutes,
	deemphOf,
	evidenceText,
	deemphPatch,
	hearHint,
	liveTone,
	offeredTone,
	playsDigital,
	routeProtocol,
	sameTone,
	toneOfSummary,
	toneSquelchFits,
	toneSquelchPatch,
	toneText,
	transmissionKind,
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

	it("Auto follows the transmission: a call is digital, a live tone is analog, else the last proof", () => {
		const idle = voiceRoute([dsd()], voice(), 161_150_000, 6250)
		const now = Date.parse("2026-10-22T10:00:05.000Z")
		const tone = { ctcssHz: 88.5, dcs: null, at: "2026-10-22T10:00:00.000Z" }
		const base = { route: idle, open: true, tone, last: null, now }
		expect(transmissionKind(base)).toBe("analog")
		expect(transmissionKind({ ...base, open: false })).toBeNull()
		expect(
			transmissionKind({ ...base, now: now + 60_000, last: "digital" }),
		).toBe("digital")
		expect(transmissionKind({ ...base, tone: undefined, last: "analog" })).toBe(
			"analog",
		)
		expect(
			transmissionKind({ ...base, tone: { ...tone, ctcssHz: null } }),
		).toBeNull()
		const calling = voiceRoute(
			[dsd()],
			voice({
				decoderId: "dsd-fme",
				callId: "c1",
				protocol: "dmr",
				talkgroup: 2081,
				source: 2081045,
				slot: 1,
				encrypted: false,
				active: true,
				startedAt: "2026-10-17T17:00:00Z",
			} as DigitalVoiceStatus["call"]),
			161_152_000,
			6250,
		)
		expect(transmissionKind({ ...base, route: calling })).toBe("digital")

		expect(playsDigital("auto", idle, "analog")).toBe(false)
		expect(playsDigital("auto", idle, null)).toBe(true)
		expect(playsDigital("digital", idle, "analog")).toBe(true)
		expect(hearHint("auto", idle, "NFM", "analog")).toBe(
			"This transmission is analog. Playing NFM audio, back to decoded voice when a call comes.",
		)
	})

	it("offers the live tone over the Activity rows (WG12), and the rows on older cores", () => {
		const live = { ctcssHz: 103.5, dcs: null, at: "2026-10-22T10:00:00.000Z" }
		expect(liveTone(undefined)).toBeUndefined()
		expect(liveTone({ ...live, ctcssHz: null })).toBeNull()
		expect(offeredTone(undefined, [], live)).toEqual({
			kind: "ctcss",
			frequencyTenthsHz: 1035,
		})
		expect(
			offeredTone(undefined, [], {
				ctcssHz: null,
				dcs: { code: "023", polarity: "normal" },
				at: live.at,
			}),
		).toEqual({ kind: "dcs", code: "023", polarity: "normal" })
		expect(offeredTone(undefined, [], undefined)).toBeNull()
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

describe("Listen › Auto listen route (/auto)", () => {
	const route = {
		active: "analog",
		since: "2026-10-24T00:00:00Z",
		httpUrl: "http://localhost:8081/auto",
		wavUrl: "http://localhost:8081/auto.wav",
		clientCount: 1,
		digitalAvailable: true,
		underruns: 0,
		droppedMs: 0,
		clockRebases: 0,
		latencyMs: 60,
	} as const
	const running = (over: Record<string, unknown> = {}): LiveAudioStatus =>
		({
			running: true,
			config: config(),
			autoRoute: route,
			...over,
		}) as unknown as LiveAudioStatus

	it("Auto hands the choice to the core only when it serves /auto while running", () => {
		expect(coreRoutes("auto", running())).toBe(true)
		expect(coreRoutes("analog", running())).toBe(false)
		expect(coreRoutes("digital", running())).toBe(false)
		expect(coreRoutes("auto", running({ autoRoute: undefined }))).toBe(false)
		expect(coreRoutes("auto", running({ running: false }))).toBe(false)
		expect(coreRoutes("auto", null)).toBe(false)
	})

	it("plays /auto at 48 kHz s16le, a loopback host following the page", () => {
		expect(autoRouteSource(running(), "http://pi.local:3000/", true)).toEqual({
			httpUrl: "http://pi.local:8081/auto",
			wavUrl: "http://pi.local:8081/auto.wav",
			format: "s16le",
			rate: 48_000,
			credentials: true,
		})
		expect(autoRouteSource(running({ running: false }), "http://x/")).toBeNull()
		expect(
			autoRouteSource(running({ autoRoute: undefined }), "http://x/"),
		).toBeNull()
	})

	it("reads the source from the level event, the status as fallback", () => {
		expect(autoRouteNow(running(), null)).toEqual({ active: "analog" })
		const level = {
			autoRoute: { active: "digital", protocol: "dmr" },
		} as unknown as Parameters<typeof autoRouteNow>[1]
		expect(autoRouteNow(running(), level)).toEqual({
			active: "digital",
			protocol: "dmr",
		})
		expect(autoRouteNow(running({ autoRoute: undefined }), level)).toBeNull()
		expect(routeProtocol({ active: "digital", protocol: "p25" }, null)).toBe(
			"P25",
		)
	})

	it("words the hint from what the core plays", () => {
		const r = voiceRoute([dsd()], voice(), 161_150_000, 6250)
		expect(
			coreRouteHint({
				now: { active: "digital", protocol: "dmr" },
				digitalAvailable: true,
				route: r,
				modeLabel: "NFM",
			}),
		).toBe("DMR call. Playing decoded voice.")
		expect(
			coreRouteHint({
				now: { active: "analog" },
				digitalAvailable: true,
				route: { ...r!, protocol: "DMR" },
				modeLabel: "NFM",
			}),
		).toBe("Playing NFM audio, decoded DMR voice when a call comes.")
		expect(
			coreRouteHint({
				now: { active: "none" },
				digitalAvailable: false,
				route: r,
				modeLabel: "NFM",
			}),
		).toBe("This core plays analog audio only on Auto. Playing NFM audio.")
		expect(
			coreRouteHint({
				now: { active: "none" },
				digitalAvailable: true,
				route: null,
				modeLabel: "AM",
			}),
		).toBe("No digital voice decoder on this channel. Playing AM audio.")
	})
})

describe("Listen › Evidence squelch", () => {
	const st = (autoSquelch?: unknown, isRunning = true) =>
		({ running: isRunning, autoSquelch }) as unknown as LiveAudioStatus

	it("prefers the level event, falls back to the status, null when stopped or absent", () => {
		const level = {
			autoSquelch: { state: "open", evidence: "voice" },
		} as unknown as Parameters<typeof autoSquelchNow>[1]
		expect(autoSquelchNow(st({ state: "waiting" }), level)).toEqual({
			state: "open",
			evidence: "voice",
		})
		expect(autoSquelchNow(st({ state: "waiting" }), null)).toEqual({
			state: "waiting",
		})
		expect(autoSquelchNow(st(undefined), null)).toBeNull()
		expect(autoSquelchNow(st({ state: "open" }, false), null)).toBeNull()
	})

	it("names the evidence that opened the gate", () => {
		expect(evidenceText({ state: "open", evidence: "voice" })).toBe(
			"Open on voice",
		)
		expect(evidenceText({ state: "open", evidence: "ctcss" })).toBe(
			"Open on CTCSS",
		)
		expect(evidenceText({ state: "open", evidence: "dcs" })).toBe("Open on DCS")
		expect(evidenceText({ state: "open" })).toBe("Open")
		expect(evidenceText({ state: "waiting" })).toBeNull()
		expect(evidenceText(null)).toBeNull()
	})
})
