import { PassThrough } from "node:stream"
import { describe, expect, it } from "vitest"
import {
	ANALOG_TONE_SLICE_SAMPLES,
	RECEIVER_NOISE_CARRIER_DBFS,
	captureFloorDb,
	createAnalogTrialRunner,
} from "../../../../src/core/iq-capture/analog-trial.js"
import type { IqCapturePort } from "../../../../src/core/scanner/iq-capture-contract.js"
import type {
	AnalogTrialFrame,
	AnalogTrialMode,
	AnalyzeEvent,
} from "../../../../src/core/scanner/scanner-redesign-contract.js"
import { ToneDetector } from "../../../../src/core/audio-tones/tone-detector.js"
import { synthesizeAnalogIq } from "../../../mocks/iq/analog-synth.js"
import { logText, spyLogger } from "./helpers.js"

const CAPTURE = "11111111-1111-4111-8111-111111111111"

function tonePcm(hz: number, seconds: number, amplitude = 0.25): Buffer {
	const n = Math.round(seconds * 8_000)
	const pcm = Buffer.alloc(n * 2)
	for (let i = 0; i < n; i++) {
		const sample = amplitude * Math.sin((2 * Math.PI * hz * i) / 8_000)
		const clipped = Math.max(-1, Math.min(1, sample))
		pcm.writeInt16LE(Math.round(clipped * 32_767), i * 2)
	}
	return pcm
}

function quietFrames(n: number): AnalogTrialFrame[] {
	const frames: AnalogTrialFrame[] = []
	for (let i = 0; i < n; i++) {
		frames.push({
			carrierDb: -25,
			hfNoiseDb: -18,
			audioDb: -12,
			syllabic: 0.45,
			cluster: 0.05,
		})
	}
	return frames
}

function analysis(frames: AnalogTrialFrame[], gapSamples = 0): AnalyzeEvent {
	return { event: "analysis", frames, gapSamples }
}

function scripted(options: {
	audio?: Buffer
	event?: unknown
	kill?: () => void
}): {
	port: IqCapturePort
	killed: () => boolean
} {
	let killed = false
	const port = {
		openAnalyze(_captureId: string, _mode: AnalogTrialMode) {
			const audio = new PassThrough()
			if (options.audio) audio.end(options.audio)
			else audio.end()
			return {
				audio,
				event:
					options.event instanceof Promise
						? options.event
						: Promise.resolve(options.event),
				kill() {
					killed = true
					options.kill?.()
				},
			}
		},
	} as unknown as IqCapturePort
	return { port, killed: () => killed }
}

function runnerFor(port: IqCapturePort) {
	const { logger, lines } = spyLogger()
	const runner = createAnalogTrialRunner({
		port,
		tones: () => new ToneDetector(),
		logger,
	})
	return { runner, lines }
}

describe("createAnalogTrialRunner", () => {
	it("zero-frame analysis ends no-sync", async () => {
		const { port, killed } = scripted({ event: analysis([]) })
		const { runner } = runnerFor(port)
		const result = await runner.run(
			CAPTURE,
			"nfm",
			new AbortController().signal,
		)
		expect(result.error).toBeUndefined()
		expect(result.outcome).toBe("no-sync")
		expect(result.voice).toBe(false)
		expect(result.tones.ctcssHz).toBeNull()
		expect(result.tones.dcs).toBeNull()
		expect(result.stats?.frames).toEqual([])
		expect(result.stats?.floorDb).toBe(0)
		expect(killed()).toBe(true)
	})

	it("a CTCSS 88.5 audio stream qualifies → decoded, ctcssHz 88.5", async () => {
		const { port } = scripted({
			audio: tonePcm(88.5, 1),
			event: analysis(quietFrames(20)),
		})
		const { runner } = runnerFor(port)
		const result = await runner.run(
			CAPTURE,
			"nfm",
			new AbortController().signal,
		)
		expect(result.error).toBeUndefined()
		expect(result.outcome).toBe("decoded")
		expect(result.tones.ctcssHz).toBe(88.5)
		expect(result.tones.dcs).toBeNull()
		expect(result.tones.audioSeconds).toBeGreaterThanOrEqual(0.75)
		expect(result.voice).toBe(true)
		expect(result.mode).toBe("nfm")
	})

	it("slices never exceed the tone-detector bound", async () => {
		const sizes: number[] = []
		const generations: number[] = []
		let generation = 0
		const detector = new ToneDetector()
		const push = detector.push.bind(detector)
		detector.push = (pcm, format) => {
			sizes.push(pcm.length / 2)
			generations.push(generation)
			// Queued before the runner's next slice, so a same-turn push
			// would record the same generation.
			setImmediate(() => {
				generation += 1
			})
			push(pcm, format)
		}
		const { logger } = spyLogger()
		const audio = Buffer.alloc((4_096 * 2 + 10) * 2)
		const { port } = scripted({ audio, event: analysis([]) })
		const runner = createAnalogTrialRunner({
			port,
			tones: () => detector,
			logger,
		})
		await runner.run(CAPTURE, "nfm", new AbortController().signal)
		expect(ANALOG_TONE_SLICE_SAMPLES).toBeLessThanOrEqual(1_024)
		expect(sizes.length).toBeGreaterThanOrEqual(3)
		expect(sizes.every(n => n <= ANALOG_TONE_SLICE_SAMPLES)).toBe(true)
		expect(sizes.reduce((sum, n) => sum + n, 0)).toBe(4_096 * 2 + 10)
		expect(new Set(generations).size).toBe(sizes.length)
	})

	it("abort → cancelled and child killed", async () => {
		let killed = false
		const audio = new PassThrough()
		const port = {
			openAnalyze() {
				return {
					audio,
					event: new Promise(() => {}),
					kill() {
						killed = true
					},
				}
			},
		} as unknown as IqCapturePort
		const { runner } = runnerFor(port)
		const ac = new AbortController()
		const pending = runner.run(CAPTURE, "nfm", ac.signal)
		ac.abort()
		const result = await pending
		expect(result.error).toBe("cancelled")
		expect(result.outcome).toBe("no-sync")
		expect(result.stats).toBeNull()
		expect(killed).toBe(true)
		audio.destroy()
	})

	it("port without openAnalyze → unavailable", async () => {
		const { runner, lines } = runnerFor({} as IqCapturePort)
		const result = await runner.run(CAPTURE, "am", new AbortController().signal)
		expect(result.error).toBe("unavailable")
		expect(result.outcome).toBe("no-sync")
		expect(result.mode).toBe("am")
		expect(result.stats).toBeNull()
		expect(logText(lines)).not.toContain(CAPTURE)
	})

	it("a gone capture → capture-gone and does not decode", async () => {
		const port = {
			openAnalyze: () => null,
		} as unknown as IqCapturePort
		const { runner } = runnerFor(port)
		const result = await runner.run(
			CAPTURE,
			"nfm",
			new AbortController().signal,
		)
		expect(result.error).toBe("capture-gone")
		expect(result.outcome).not.toBe("decoded")
		expect(result.outcome).not.toBe("heard")
		expect(result.stats).toBeNull()
	})

	it("an analyze error event → analyze-failed and the child is released", async () => {
		const { port, killed } = scripted({
			audio: tonePcm(88.5, 1),
			event: { event: "error", code: "io" },
		})
		const { runner } = runnerFor(port)
		const result = await runner.run(
			CAPTURE,
			"nfm",
			new AbortController().signal,
		)
		expect(result.error).toBe("analyze-failed")
		expect(result.outcome).not.toBe("decoded")
		expect(result.outcome).not.toBe("heard")
		expect(result.tones.ctcssHz).toBeNull()
		expect(result.stats).toBeNull()
		expect(killed()).toBe(true)
	})

	it("a rejected analyze event → analyze-failed and the child is released", async () => {
		const { port, killed } = scripted({
			event: Promise.reject(new Error(CAPTURE)),
		})
		const { runner, lines } = runnerFor(port)
		const result = await runner.run(
			CAPTURE,
			"nfm",
			new AbortController().signal,
		)
		expect(result.error).toBe("analyze-failed")
		expect(result.outcome).not.toBe("decoded")
		expect(result.outcome).not.toBe("heard")
		expect(killed()).toBe(true)
		expect(logText(lines)).not.toContain(CAPTURE)
	})

	it("openAnalyze throwing → analyze-failed", async () => {
		const port = {
			openAnalyze() {
				throw new Error(CAPTURE)
			},
		} as unknown as IqCapturePort
		const { runner, lines } = runnerFor(port)
		const result = await runner.run(
			CAPTURE,
			"nfm",
			new AbortController().signal,
		)
		expect(result.error).toBe("analyze-failed")
		expect(result.outcome).not.toBe("heard")
		expect(logText(lines)).not.toContain(CAPTURE)
	})

	it("malformed frames are not decoded or heard", async () => {
		const bad = {
			event: "analysis",
			frames: [
				{
					carrierDb: Number.NaN,
					hfNoiseDb: -40,
					audioDb: -5,
					syllabic: 0.9,
					cluster: 0.01,
				},
			],
			gapSamples: 0,
		}
		const { port, killed } = scripted({
			audio: tonePcm(88.5, 1),
			event: bad,
		})
		const { runner } = runnerFor(port)
		const result = await runner.run(
			CAPTURE,
			"nfm",
			new AbortController().signal,
		)
		expect(result.error).toBe("analyze-failed")
		expect(result.outcome).not.toBe("decoded")
		expect(result.outcome).not.toBe("heard")
		expect(result.stats).toBeNull()
		expect(result.tones.ctcssHz).toBeNull()
		expect(killed()).toBe(true)
	})

	it("a throwing getter on the event is not decoded", async () => {
		const event = {
			get event(): string {
				throw new Error(CAPTURE)
			},
		}
		const { port, killed } = scripted({ event })
		const { runner, lines } = runnerFor(port)
		const result = await runner.run(
			CAPTURE,
			"nfm",
			new AbortController().signal,
		)
		expect(result.error).toBe("analyze-failed")
		expect(result.outcome).not.toBe("decoded")
		expect(result.outcome).not.toBe("heard")
		expect(killed()).toBe(true)
		expect(logText(lines)).not.toContain(CAPTURE)
	})

	it("a throwing tone detector → analyze-failed and the child is released", async () => {
		const { port, killed } = scripted({
			audio: tonePcm(88.5, 1),
			event: analysis(quietFrames(4)),
		})
		const { logger } = spyLogger()
		const runner = createAnalogTrialRunner({
			port,
			tones: () => {
				throw new Error(CAPTURE)
			},
			logger,
		})
		const result = await runner.run(
			CAPTURE,
			"nfm",
			new AbortController().signal,
		)
		expect(result.error).toBe("analyze-failed")
		expect(killed()).toBe(true)
	})

	it("a detector that throws from push → analyze-failed and the child is released", async () => {
		const detector = new ToneDetector()
		detector.push = () => {
			throw new Error(CAPTURE)
		}
		const { port, killed } = scripted({
			audio: tonePcm(100, 0.1),
			event: analysis(quietFrames(2)),
		})
		const { logger, lines } = spyLogger()
		const runner = createAnalogTrialRunner({
			port,
			tones: () => detector,
			logger,
		})
		const result = await runner.run(
			CAPTURE,
			"nfm",
			new AbortController().signal,
		)
		expect(result.error).toBe("analyze-failed")
		expect(result.outcome).not.toBe("decoded")
		expect(result.outcome).not.toBe("heard")
		expect(killed()).toBe(true)
		expect(logText(lines)).not.toContain(CAPTURE)
	})

	it("an audio error with a hanging event still releases the child", async () => {
		let killed = false
		const audio = new PassThrough()
		const port = {
			openAnalyze() {
				return {
					audio,
					event: new Promise(() => {}),
					kill() {
						killed = true
					},
				}
			},
		} as unknown as IqCapturePort
		const { runner } = runnerFor(port)
		const pending = runner.run(CAPTURE, "nfm", new AbortController().signal)
		audio.destroy(new Error("audio"))
		const result = await pending
		expect(result.error).toBe("analyze-failed")
		expect(result.outcome).not.toBe("decoded")
		expect(result.outcome).not.toBe("heard")
		expect(result.stats).toBeNull()
		expect(killed).toBe(true)
	})

	it("an audio stream error → analyze-failed and the child is released", async () => {
		let killed = false
		const audio = new PassThrough()
		const port = {
			openAnalyze() {
				return {
					audio,
					event: Promise.resolve(analysis(quietFrames(4))),
					kill() {
						killed = true
					},
				}
			},
		} as unknown as IqCapturePort
		const { runner } = runnerFor(port)
		const pending = runner.run(CAPTURE, "nfm", new AbortController().signal)
		audio.destroy(new Error(CAPTURE))
		const result = await pending
		expect(result.error).toBe("analyze-failed")
		expect(result.outcome).not.toBe("heard")
		expect(killed).toBe(true)
	})

	it("an already-aborted signal does not open a child", async () => {
		let opened = false
		const port = {
			openAnalyze() {
				opened = true
				return null
			},
		} as unknown as IqCapturePort
		const { runner } = runnerFor(port)
		const ac = new AbortController()
		ac.abort()
		const result = await runner.run(CAPTURE, "nfm", ac.signal)
		expect(opened).toBe(false)
		expect(result.error).toBe("cancelled")
	})

	it("a kill that throws still settles", async () => {
		const { port } = scripted({
			event: analysis([]),
			kill() {
				throw new Error(CAPTURE)
			},
		})
		const { runner, lines } = runnerFor(port)
		const result = await runner.run(
			CAPTURE,
			"nfm",
			new AbortController().signal,
		)
		expect(result.outcome).toBe("no-sync")
		expect(result.error).toBeUndefined()
		expect(logText(lines)).not.toContain(CAPTURE)
	})

	it("a non-object audio handle is analyze-failed and kill is still called", async () => {
		let killed = false
		const port = {
			openAnalyze() {
				return {
					audio: null,
					event: Promise.resolve(analysis([])),
					kill() {
						killed = true
					},
				}
			},
		} as unknown as IqCapturePort
		const { runner } = runnerFor(port)
		const result = await runner.run(
			CAPTURE,
			"nfm",
			new AbortController().signal,
		)
		expect(result.error).toBe("analyze-failed")
		expect(killed).toBe(true)
	})

	it("AM floorDb is the receiver noise floor plus the capture HF noise", async () => {
		const carriers = [0, 10, 20, 30, 40]
		const frames = carriers.map(carrierDb => ({
			carrierDb,
			hfNoiseDb: 0,
			audioDb: -80,
			syllabic: 0,
			cluster: 0,
		}))
		expect(captureFloorDb(frames)).toBeCloseTo(RECEIVER_NOISE_CARRIER_DBFS, 8)
		const { port } = scripted({
			audio: Buffer.alloc(frames.length * 400 * 2),
			event: analysis(frames),
		})
		const { runner } = runnerFor(port)
		const result = await runner.run(CAPTURE, "am", new AbortController().signal)
		expect(result.stats?.floorDb).toBeCloseTo(RECEIVER_NOISE_CARRIER_DBFS, 8)
		expect(result.stats?.mode).toBe("am")
		expect(result.outcome).not.toBe("decoded")
		expect(result.outcome).not.toBe("heard")
	})

	it("continuous AM above the absolute floor is heard", async () => {
		const frames = Array.from({ length: 8 }, () => ({
			carrierDb: 0,
			hfNoiseDb: -40,
			audioDb: -12,
			syllabic: 0.5,
			cluster: 0.1,
		}))
		const { port } = scripted({
			audio: Buffer.alloc(frames.length * 400 * 2),
			event: analysis(frames),
		})
		const { runner } = runnerFor(port)
		const result = await runner.run(CAPTURE, "am", new AbortController().signal)
		expect(result.error).toBeUndefined()
		expect(result.outcome).toBe("heard")
		expect(result.voice).toBe(true)
		expect(result.stats?.floorDb).toBeCloseTo(
			RECEIVER_NOISE_CARRIER_DBFS - 40,
			8,
		)
	})

	it("AM frames sitting on the noise floor are no-sync", async () => {
		const frames = Array.from({ length: 8 }, () => ({
			carrierDb: RECEIVER_NOISE_CARRIER_DBFS,
			hfNoiseDb: 0,
			audioDb: -80,
			syllabic: 0,
			cluster: 0,
		}))
		const { port } = scripted({
			audio: Buffer.alloc(frames.length * 400 * 2),
			event: analysis(frames),
		})
		const { runner } = runnerFor(port)
		const result = await runner.run(CAPTURE, "am", new AbortController().signal)
		expect(result.error).toBeUndefined()
		expect(result.outcome).toBe("no-sync")
	})

	it("a tone shorter than 0.75 s does not decode", async () => {
		const { port } = scripted({
			audio: tonePcm(88.5, 0.5),
			event: analysis(quietFrames(10)),
		})
		const { runner } = runnerFor(port)
		const result = await runner.run(
			CAPTURE,
			"nfm",
			new AbortController().signal,
		)
		expect(result.tones.ctcssHz).toBeNull()
		expect(result.outcome).toBe("heard")
		expect(result.error).toBeUndefined()
	})

	it("an odd trailing byte is analyze-failed and the child is released", async () => {
		const pcm = Buffer.concat([tonePcm(88.5, 1), Buffer.from([0x01])])
		const sizes: number[] = []
		const detector = new ToneDetector()
		const push = detector.push.bind(detector)
		detector.push = (buf, format) => {
			sizes.push(buf.length)
			push(buf, format)
		}
		const { port, killed } = scripted({
			audio: pcm,
			event: analysis(quietFrames(20)),
		})
		const { logger } = spyLogger()
		const runner = createAnalogTrialRunner({
			port,
			tones: () => detector,
			logger,
		})
		const result = await runner.run(
			CAPTURE,
			"nfm",
			new AbortController().signal,
		)
		expect(
			sizes.every(n => n % 2 === 0 && n / 2 <= ANALOG_TONE_SLICE_SAMPLES),
		).toBe(true)
		expect(result.error).toBe("analyze-failed")
		expect(result.outcome).not.toBe("decoded")
		expect(result.outcome).not.toBe("heard")
		expect(result.tones.audioSeconds).toBe(0)
		expect(killed()).toBe(true)
	})

	it("audio one sample short of the frame count is analyze-failed", async () => {
		const samples = 20 * 400 - 1
		const { port, killed } = scripted({
			audio: Buffer.alloc(samples * 2),
			event: analysis(quietFrames(20)),
		})
		const { runner } = runnerFor(port)
		const result = await runner.run(
			CAPTURE,
			"nfm",
			new AbortController().signal,
		)
		expect(result.error).toBe("analyze-failed")
		expect(result.outcome).not.toBe("heard")
		expect(killed()).toBe(true)
	})

	it("one sample past the partial frame is analyze-failed", async () => {
		const samples = 20 * 400 + 401
		const { port } = scripted({
			audio: Buffer.alloc(samples * 2),
			event: analysis(quietFrames(20)),
		})
		const { runner } = runnerFor(port)
		const result = await runner.run(
			CAPTURE,
			"nfm",
			new AbortController().signal,
		)
		expect(result.error).toBe("analyze-failed")
		expect(result.outcome).not.toBe("decoded")
		expect(result.outcome).not.toBe("heard")
	})

	it("a partial final frame still classifies", async () => {
		const samples = 20 * 400 + 200
		const { port } = scripted({
			audio: Buffer.alloc(samples * 2),
			event: analysis(quietFrames(20)),
		})
		const { runner } = runnerFor(port)
		const result = await runner.run(
			CAPTURE,
			"nfm",
			new AbortController().signal,
		)
		expect(result.error).toBeUndefined()
		expect(result.outcome).toBe("heard")
		expect(result.tones.audioSeconds).toBeCloseTo(samples / 8_000, 5)
	})
})

describe("analog synth", () => {
	it("is deterministic for a seed and stays inside one capture", () => {
		const request = {
			kind: "nfm-ctcss" as const,
			snrDb: 12,
			seconds: 0.05,
			seed: 0x1234abcd,
		}
		const a = synthesizeAnalogIq(request)
		const b = synthesizeAnalogIq(request)
		expect(a.length).toBe(Math.round(0.05 * 48_000) * 2)
		expect(
			Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(
				Buffer.from(b.buffer, b.byteOffset, b.byteLength),
			),
		).toBe(true)
		const other = synthesizeAnalogIq({ ...request, seed: request.seed + 1 })
		expect(Buffer.from(other.buffer).equals(Buffer.from(a.buffer))).toBe(false)
	})
})
