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
	deemphOf,
	evidenceText,
	deemphPatch,
	liveTone,
	offeredTone,
	routeProtocol,
	sameTone,
	toneOfSummary,
	toneSquelchFits,
	toneSquelchPatch,
	toneText,
	LEGACY_HEAR_KEY,
	listenHeadline,
	listenModeOf,
	migrateHearKey,
	sourceHint,
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

	it("plays /auto at 48 kHz s16le, a loopback host following the page", () => {
		expect(autoRouteSource(running(), "http://pi.local:3000/", true)).toEqual({
			route: "auto",
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

	it("carries the route's reason from the status when no level event has it", () => {
		expect(
			autoRouteNow(
				running({ autoRoute: { ...route, reason: "no-decoder" } }),
				null,
			),
		).toEqual({ active: "analog", reason: "no-decoder" })
	})
})

describe("Listen › Source (the core's listenMode)", () => {
	it("reads the Source, Auto on an old core or a value it does not know", () => {
		expect(listenModeOf(config({ listenMode: "digital" }))).toBe("digital")
		expect(listenModeOf(config({ listenMode: "analog" }))).toBe("analog")
		expect(listenModeOf(config())).toBe("auto")
		expect(
			listenModeOf(
				config({
					listenMode: "decoded" as unknown as NonNullable<
						LiveAudioConfig["listenMode"]
					>,
				}),
			),
		).toBe("auto")
		expect(listenModeOf(null)).toBe("auto")
	})

	it("words the hint from what the core plays and why", () => {
		const r = voiceRoute([dsd()], voice(), 161_150_000, 6250)
		const hint = (
			mode: "auto" | "analog" | "digital",
			now: Parameters<typeof sourceHint>[0]["now"],
			route = r,
		) => sourceHint({ mode, now, route, modeLabel: "NFM" })
		expect(hint("auto", { active: "digital", protocol: "dmr" })).toBe(
			"DMR call. Playing decoded voice.",
		)
		expect(
			hint("digital", { active: "none", reason: "no-decoder" }, null),
		).toBe("No digital voice decoder on this channel: nothing plays.")
		expect(hint("auto", { active: "analog", reason: "squelch-open" })).toBe(
			"Open plays the NFM audio as it is.",
		)
		expect(hint("analog", { active: "analog" })).toBe(
			"Playing demodulated NFM audio only.",
		)
		expect(hint("digital", { active: "none" })).toBe(
			"Decoded digital voice only, silence between calls.",
		)
		expect(hint("auto", { active: "none" }, null)).toBe(
			"Playing NFM audio. Decoded voice when a decoder covers the channel.",
		)
	})
})

describe("Listen › head states", () => {
	const base = {
		squelch: "auto" as const,
		carrier: false,
		gate: null,
		toneWaiting: false,
		now: null,
	}
	it("says Quiet, Waiting for voice, Open or Listening", () => {
		expect(listenHeadline(base).title).toBe("Quiet")
		expect(
			listenHeadline({ ...base, carrier: true, gate: { state: "waiting" } })
				.title,
		).toBe("Waiting for voice")
		expect(
			listenHeadline({ ...base, carrier: true, gate: { state: "open" } }).title,
		).toBe("Listening")
		// Voice only off or Manual: the voice check is off and the carrier plays
		expect(
			listenHeadline({ ...base, carrier: true, gate: { state: "off" } }).title,
		).toBe("Listening")
		expect(
			listenHeadline({ ...base, squelch: "manual", carrier: true }).title,
		).toBe("Listening")
		// Open stays Open, whatever is on the air
		expect(listenHeadline({ ...base, squelch: "open" }).title).toBe("Open")
		expect(
			listenHeadline({
				...base,
				squelch: "open",
				now: { active: "analog", reason: "squelch-open" },
			}).title,
		).toBe("Open")
	})

	it("a decoded call is Listening (the sub says DMR voice · TG …); Digital with no decoder and a tone gate are Quiet", () => {
		expect(
			listenHeadline({
				...base,
				carrier: true,
				gate: { state: "waiting" },
				now: { active: "digital", protocol: "dmr" },
			}).title,
		).toBe("Listening")
		expect(
			listenHeadline({
				...base,
				carrier: true,
				now: { active: "none", reason: "no-decoder" },
			}).title,
		).toBe("Quiet")
		expect(
			listenHeadline({ ...base, carrier: true, toneWaiting: true }).title,
		).toBe("Quiet")
	})

	it("an old core (no voice check reported) keeps today's states", () => {
		expect(listenHeadline({ ...base, carrier: true }).title).toBe("Listening")
		expect(listenHeadline(base).title).toBe("Quiet")
	})
})

describe("Listen › the old per-browser What you hear", () => {
	const store = (value: string | null) => {
		const items = new Map<string, string>()
		if (value !== null) items.set(LEGACY_HEAR_KEY, value)
		return {
			items,
			getItem: (k: string) => items.get(k) ?? null,
			removeItem: (k: string) => void items.delete(k),
		}
	}
	const listen = config({ voiceOnly: true, listenMode: "auto" })

	it("keeps Analog or Digital as the core's Source once, and deletes the key", () => {
		for (const v of ["analog", "digital"] as const) {
			const s = store(v)
			expect(migrateHearKey(s, listen, true)).toEqual({ listenMode: v })
			expect(s.items.has(LEGACY_HEAR_KEY)).toBe(false)
			// read once: nothing left to migrate
			expect(migrateHearKey(s, listen, true)).toBeNull()
		}
	})

	it("drops it without a write when not sensible: auto, junk, a chosen Source, read-only, an old core", () => {
		const cases: [string, LiveAudioConfig | null, boolean][] = [
			["auto", listen, true],
			["decoded", listen, true],
			["analog", config({ voiceOnly: true, listenMode: "digital" }), true],
			["analog", listen, false],
			["analog", config(), true],
			["analog", null, true],
		]
		for (const [value, cfg, canWrite] of cases) {
			const s = store(value)
			expect(migrateHearKey(s, cfg, canWrite)).toBeNull()
			expect(s.items.has(LEGACY_HEAR_KEY)).toBe(false)
		}
	})

	it("blocked storage reads as nothing to migrate", () => {
		const blocked = {
			getItem: () => {
				throw new Error("SecurityError")
			},
			removeItem: () => undefined,
		}
		expect(migrateHearKey(blocked, listen, true)).toBeNull()
		expect(migrateHearKey(undefined, listen, true)).toBeNull()
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
			"Voice heard",
		)
		expect(evidenceText({ state: "open", evidence: "ctcss" })).toBe(
			"CTCSS heard",
		)
		expect(evidenceText({ state: "open", evidence: "dcs" })).toBe("DCS heard")
		expect(evidenceText({ state: "open" })).toBe("Passing")
		expect(evidenceText({ state: "waiting" })).toBeNull()
		expect(evidenceText(null)).toBeNull()
	})
})
