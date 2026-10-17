// Lot C7: what a real core (dist/index.js on a fake rtl_tcp) sent that the mock did not, and the
// web app's handling of it. Values below are copied from that core's answers.
import { describe, expect, it } from "vitest"
import type {
	ExtendedSourceStatus,
	LiveAudioStatus,
	TunerState,
} from "@wavekit/api-types"
import { frameGeometry, synthFrame } from "../../mock/spectrum.ts"
import { ApiClient } from "../../src/data/api-client.ts"
import { EventsClient } from "../../src/data/events-client.ts"
import { IdentifyStore } from "../../src/data/identify-store.ts"
import { identifyView } from "../../src/features/tuned/identify-view.ts"
import {
	audioSource,
	reachableAudioUrl,
} from "../../src/features/listen/audio.ts"
import { parsePositiveRate } from "../../src/features/listen/pcm.ts"
import {
	gainText,
	receiverSummary,
	switchText,
} from "../../src/features/receiver/summary.ts"
import { signalPresent } from "../../src/features/tuned/signal.ts"
import {
	autoLevels,
	snapToTrack,
	snapToTrackChannel,
	type Track,
} from "../../src/plot/maths.ts"
import {
	EMPTY_CONTEXT,
	PlotController,
	type PlotContext,
} from "../../src/plot/plot-store.ts"
import { DEFAULT_LEVELS } from "../../src/spectrum/index.ts"
import { fakeSockets } from "../data/fake-socket.ts"

const PAGE = "http://localhost:5173/"

describe("live audio from a real core", () => {
	// GET /api/live-audio/status of a legacy core: the audio server is on its own port, advertised on
	// localhost unless liveDemod.publicOrigin is set. Since WG7 (88bfc6b7) it answers CORS with `*`, so
	// the page fetches it cross-origin directly, without a dev proxy.
	const status = {
		running: true,
		sourceId: "local-iq",
		httpUrl: "http://localhost:8081/stream",
		wavUrl: "http://localhost:8081/stream.wav",
		effectiveSampleRate: 24975.60975609756,
		config: { audioFormat: "s16le" },
	} as LiveAudioStatus

	it("fetches the advertised URL directly on the core's machine", () => {
		expect(audioSource(status, PAGE)).toEqual({
			httpUrl: "http://localhost:8081/stream",
			wavUrl: "http://localhost:8081/stream.wav",
			format: "s16le",
			rate: 24975.60975609756,
			credentials: false,
		})
		expect(audioSource(status, "http://127.0.0.1:9000/")?.httpUrl).toBe(
			"http://localhost:8081/stream",
		)
	})

	it("swaps a loopback stream host for the page's host when the page is remote", () => {
		expect(
			audioSource(status, "http://receiver.lan:9000/listen")?.httpUrl,
		).toBe("http://receiver.lan:8081/stream")
		expect(
			reachableAudioUrl(
				"http://127.0.0.1:8081/stream.wav",
				"http://192.168.1.20:5173/",
			),
		).toBe("http://192.168.1.20:8081/stream.wav")
		expect(
			reachableAudioUrl("http://[::1]:8081/stream", "http://[fd00::2]:9000/"),
		).toBe("http://[fd00::2]:8081/stream")
	})

	it("keeps a configured public origin, paths and non-http URLs as they are", () => {
		const remote = "http://receiver.lan:9000/"
		expect(reachableAudioUrl("http://pi.local:8081/stream", remote)).toBe(
			"http://pi.local:8081/stream",
		)
		expect(reachableAudioUrl("https://radio.example.org/stream", remote)).toBe(
			"https://radio.example.org/stream",
		)
		expect(reachableAudioUrl("/stream", remote)).toBe(
			"http://receiver.lan:9000/stream",
		)
		expect(reachableAudioUrl("blob:x", remote)).toBe("blob:x")
		expect(reachableAudioUrl("", remote)).toBeNull()
		expect(reachableAudioUrl(undefined, remote)).toBeNull()
		expect(reachableAudioUrl("http://", remote)).toBeNull()
	})

	it("reads the core's fractional X-Sample-Rate", () => {
		expect(parsePositiveRate("24975.60975609756")).toBeCloseTo(24975.61, 2)
		expect(parsePositiveRate("16000")).toBe(16000)
		expect(parsePositiveRate("0")).toBeNull()
		expect(parsePositiveRate("NaN")).toBeNull()
		expect(parsePositiveRate(null)).toBeNull()
	})
})

describe("spectrum of a real core", () => {
	// spectrum:frame at 2.048 MS/s, bins 1024: 820 bins of 2 kHz from 445.70542 MHz, i.e. only the
	// usable 80 % of the capture, and tracks whose edges sit on the 1 kHz FFT grid from startHz.
	const centreHz = 446_524_920
	const frameSpan = { startHz: 445_705_420, endHz: 445_705_420 + 820 * 2000 }
	const tracks: Track[] = [
		{
			startHz: 446_595_420,
			endHz: 446_605_420,
			flags: { burst: false, iqImage: false, edge: false },
		},
		{
			startHz: 445_999_420,
			endHz: 446_013_420,
			flags: { burst: false, iqImage: false, edge: false },
		},
	]
	const context: PlotContext = {
		...EMPTY_CONTEXT,
		sourceId: "local-iq",
		capture: frameSpan,
		centreHz,
		sampleRateHz: 2_048_000,
		tunedHz: centreHz,
		bandwidthHz: 12_500,
		stepHz: 12_500,
		tracks,
	}
	const setup = () => {
		const calls: string[] = []
		const c = new PlotController({
			retune: (hz, id) => {
				calls.push(`retune ${id} ${hz}`)
				return Promise.resolve()
			},
			setOffset: offset => {
				calls.push(`offset ${offset}`)
				return Promise.resolve()
			},
		})
		c.setContext(context)
		return { c, calls }
	}

	it("moves the channel near the edge of the frame instead of recentring", async () => {
		// 447.3 MHz: 775 kHz from the centre, inside the core's usable window (±819.2 kHz less half a
		// channel), but in the outer tenth of the frame span the click used to treat as the edge.
		const { c, calls } = setup()
		await c.tuneTo(447_300_000)
		expect(calls).toEqual(["offset 775080"])
		await c.tuneTo(448_500_000)
		expect(calls.at(-2)).toBe("retune local-iq 448500000")
	})

	it("recentres a drag past the edge on the hardware centre, not the frame's middle", async () => {
		const { c, calls } = setup()
		c.zoom(0.5, 4) // 410 kHz around the frame's middle (446.52542 MHz: 500 Hz above the centre)
		c.beginPan()
		c.dragPan(-2000, 1000) // two view widths right: 820 kHz, past the frame's edge
		await c.endPan()
		// The next frame's middle lands on the dragged view's (447.34542 MHz); the tuned channel
		// would fall outside the new capture, so it goes to the middle.
		expect(calls).toEqual(["retune local-iq 447344920", "offset 0"])
	})

	it("snaps a click on a carrier to the channel it covers", () => {
		const view = frameSpan
		expect(snapToTrack(446_600_000, tracks, view, 1440)).toBe(446_600_420)
		expect(snapToTrackChannel(446_600_000, tracks, view, 1440, 12_500)).toBe(
			446_600_000,
		)
		// PMR446 channel 1 on a 6.25 kHz raster
		expect(snapToTrackChannel(446_006_000, tracks, view, 1440, 6250)).toBe(
			446_006_250,
		)
		// no raster channel inside the track: its measured centre
		const narrow: Track[] = [
			{
				startHz: 446_301_420,
				endHz: 446_303_420,
				flags: { burst: false, iqImage: false, edge: false },
			},
		]
		expect(snapToTrackChannel(446_302_000, narrow, view, 1440, 12_500)).toBe(
			446_302_420,
		)
		expect(snapToTrackChannel(446_400_000, tracks, view, 1440, 12_500)).toBe(
			null,
		)
	})

	it("scales the trace and waterfall to the core's noise floor", () => {
		// the real core's floorDbfs on an RTL-SDR-like stream: about −62 dBFS
		const real = autoLevels(-62.4, DEFAULT_LEVELS)
		expect(real).toEqual({ minDb: -80, maxDb: 0 })
		// jitter keeps the scale (same object: React skips the update)
		expect(autoLevels(-60.1, real)).toBe(real)
		expect(autoLevels(-66, real)).toBe(real)
		// the mock's −110 dBFS floor keeps a scale close to the default
		expect(autoLevels(-110, DEFAULT_LEVELS)).toBe(DEFAULT_LEVELS)
		expect(autoLevels(-110, real)).toEqual({ minDb: -125, maxDb: -25 })
		expect(autoLevels(null, real)).toBe(real)
		expect(autoLevels(Number.NaN, real)).toBe(real)
		// a floor near full scale still leaves 20 dB of scale
		expect(autoLevels(-5, DEFAULT_LEVELS)).toEqual({ minDb: -20, maxDb: 0 })
	})
})

describe("receiver and tuned card on a real core", () => {
	// GET /api/tuner right after the core connected to rtl_tcp: nothing commanded yet, so the values
	// are placeholders listed in unknownFields (gainMode "agc", agcMode true).
	const fresh = {
		sourceId: "local-iq",
		frequency: 446_524_920,
		sampleRate: 2_048_000,
		gainMode: "agc",
		gain: 0,
		ppm: 0,
		agcMode: true,
		biasTee: false,
		directSampling: "off",
		offsetTuning: false,
		ifGain: 0,
		testMode: false,
		controlMode: "internal",
		commandCount: 0,
		tunerIfGain: null,
		unknownFields: [
			"gainMode",
			"gain",
			"ppm",
			"agcMode",
			"biasTee",
			"directSampling",
			"offsetTuning",
			"ifGain",
			"tunerIfGain",
			"testMode",
		],
	} as TunerState
	const source = { id: "local-iq", connected: true } as ExtendedSourceStatus

	it("does not claim AGC or a gain the core never set", () => {
		expect(gainText(fresh)).toBe("Gain unknown")
		expect(receiverSummary(fresh, source)).toBe("2.048 MS/s · Gain unknown")
		expect(switchText(fresh, "agcMode")).toBe("Unknown")
		expect(switchText(fresh, "biasTee")).toBe("Unknown")
		const known = { ...fresh, unknownFields: [] } as TunerState
		expect(switchText(known, "agcMode")).toBe("On")
		expect(switchText(known, "biasTee")).toBe("Off")
		expect(gainText(known)).toBe("Auto gain")
		const gainOnly = { ...fresh, unknownFields: ["gain"] } as TunerState
		expect(gainText(gainOnly)).toBe("Auto gain")
	})

	it("says a signal is present from SNR when squelch is off, never quiet", () => {
		// live-audio:level with the core's default squelch 0: squelchOpen is always true
		const noise = {
			channelPowerDbfs: -51.5,
			noiseFloorDbfs: -51.6,
			squelchOpen: true,
			thresholdDbfs: 0,
		}
		expect(signalPresent(noise)).toBeNull()
		// a carrier keying up after the tune: power over the floor
		expect(signalPresent({ ...noise, channelPowerDbfs: -20.3 })).toBe(true)
		// a carrier already up when tuned: the core's floor equals it (-12/-12), nothing to conclude
		expect(
			signalPresent({ ...noise, channelPowerDbfs: -12, noiseFloorDbfs: -12 }),
		).toBeNull()
		expect(signalPresent({ ...noise, channelPowerDbfs: null })).toBeNull()
		// squelch on: the core decides
		expect(
			signalPresent({ ...noise, thresholdDbfs: -45, squelchOpen: false }),
		).toBe(false)
		expect(
			signalPresent({ ...noise, thresholdDbfs: -45, squelchOpen: true }),
		).toBe(true)
	})
})

describe("mock frames laid out like a real core's", () => {
	it("cover the usable 80 % with at most the bins asked for", () => {
		// real core at 2.048 MS/s, 1024 bins asked: 820 bins of 2 kHz; the mock at 2.4 MS/s likewise
		const g = frameGeometry(161_500_000, 1024)
		expect(g.binCount).toBe(820)
		expect(g.binHz).toBe(2343.75)
		expect(g.binCount * g.binHz).toBeCloseTo(2_400_000 * 0.8, -4)
		expect(frameGeometry(161_500_000, 2048).binCount).toBeLessThanOrEqual(2048)
		expect(frameGeometry(161_500_000, 128).binCount).toBeLessThanOrEqual(128)
	})

	it("put track edges on the summary grid, so a click snaps back to the channel", () => {
		const frame = synthFrame({
			sourceId: "rtl-0",
			centerHz: 161_500_000,
			bins: 1024,
			hz: 10,
			epoch: 1,
			nowMs: 0,
			random: () => 0.5,
		})
		// the steady carrier on 160.900 MHz (2.5 kHz wide)
		const carrier = frame.tracks.find(
			t => t.startHz <= 160_900_000 && t.endHz >= 160_900_000,
		)
		expect(carrier).toBeDefined()
		const centre = ((carrier?.startHz ?? 0) + (carrier?.endHz ?? 0)) / 2
		expect(centre).not.toBe(160_900_000)
		const view = {
			startHz: frame.startHz,
			endHz: frame.startHz + frame.binCount * frame.binHz,
		}
		expect(
			snapToTrackChannel(160_900_300, frame.tracks, view, 1440, 12_500),
		).toBe(160_900_000)
	})
})

describe("identify across a core restart", () => {
	// After a restart the core answers GET /api/scanner/jobs/<old id> with
	// 404 { error: "NotFound", code: "SCANNER_NOT_FOUND", message: "Job … not found" }.
	const setup = async (finalState: "trying" | "candidate") => {
		const { factory, last } = fakeSockets()
		const events = new EventsClient({ createSocket: factory, url: "ws://x/ws" })
		events.connect()
		last().open()
		let gone = false
		const api = new ApiClient({
			fetch: url =>
				Promise.resolve(
					gone || url.startsWith("/api/scanner/jobs/")
						? new Response(
								JSON.stringify({
									error: "NotFound",
									code: "SCANNER_NOT_FOUND",
									message: "Job j_1 not found",
								}),
								{ status: 404 },
							)
						: new Response(
								JSON.stringify({
									id: "j_1",
									state: "starting",
									createdAt: "2026-10-16T17:00:00.000Z",
									identify: { targets: [] },
								}),
								{ status: 201 },
							),
				),
		})
		const identify = new IdentifyStore(api, events)
		await identify.start(446_006_250)
		last().receive({
			type: "scanner:identify",
			channel: "scanner",
			data: {
				jobId: "j_1",
				targetHz: 446_006_250,
				state: finalState,
				trials: [],
			},
		})
		gone = true
		await identify.refresh()
		return identify
	}

	it("ends an identify in progress with a clear error", async () => {
		const identify = await setup("trying")
		expect(identify.get()).toMatchObject({
			job: null,
			errorCode: "SCANNER_NOT_FOUND",
		})
		expect(identify.active).toBe(false)
		const view = identifyView(identify.get(), Date.now())
		expect(view.phase).toBe("error")
		expect(view.line).toMatch(/restarted/)
	})

	it("keeps a final answer already shown", async () => {
		const identify = await setup("candidate")
		expect(identify.get().event?.state).toBe("candidate")
		expect(identify.get().error).toBeNull()
	})
})
