import { describe, expect, it, vi } from "vitest"
import type { LiveAudioStatus } from "@wavekit/api-types"
import type { LiveAudioStore } from "../../src/data/index.ts"
import { audioAttachKey, audioSource } from "../../src/features/listen/audio.ts"
import {
	ListenController,
	type ListenPlayer,
} from "../../src/features/listen/controller.ts"
import type { PcmPlayerEvents } from "../../src/features/listen/pcm-player.ts"

const BASE = "http://localhost:5173/"

function status(over: Partial<LiveAudioStatus> = {}, offsetHz = 0) {
	return {
		running: true,
		sourceId: "rtl-0",
		effectiveSampleRate: 16_000,
		httpUrl: "http://localhost:3102/stream",
		wavUrl: "http://localhost:3102/stream.wav",
		clientCount: 1,
		config: {
			modulation: "nfm",
			bandwidth: 12_500,
			squelch: 0,
			offsetHz,
			audioFormat: "s16le",
		},
		...over,
	} as LiveAudioStatus
}

function setup(initial: LiveAudioStatus, credentials = false) {
	let current = initial
	const liveAudio = {
		get: () => ({ status: current }),
		start: vi.fn(() => Promise.resolve()),
		stop: vi.fn(() => Promise.resolve()),
	} as unknown as LiveAudioStore
	const calls: string[] = []
	let events: PcmPlayerEvents | null = null
	const player: ListenPlayer = {
		unlock: rate => void calls.push(`unlock ${rate}`),
		play: s =>
			void calls.push(
				`play ${s.url} ${s.format} ${s.rate}${s.credentials ? " cred" : ""}`,
			),
		stop: () => void calls.push("stop"),
		setVolume: () => undefined,
		dispose: () => void calls.push("dispose"),
	}
	const c = new ListenController(liveAudio, {
		createPlayer: e => {
			events = e
			return player
		},
	})
	const feed = (s: LiveAudioStatus) => {
		current = s
		const src = audioSource(s, BASE, credentials)
		c.setSource(audioAttachKey(src), src)
	}
	feed(initial)
	return { c, calls, feed, events: () => events as unknown as PcmPlayerEvents }
}

describe("ListenController (Web Audio path)", () => {
	it("unlocks in the gesture at the stream rate and plays the raw PCM URL", async () => {
		const { c, calls } = setup(status())
		expect(c.backend).toBe("worklet")
		await c.start()
		expect(calls).toEqual([
			"unlock 16000",
			"play http://localhost:3102/stream s16le 16000",
		])
		expect(c.get().phase).toBe("connecting")
	})

	it("shows an error instead of connecting forever when the player cannot start", async () => {
		const { c } = setup(status())
		const failing = c as unknown as { player: ListenPlayer }
		failing.player.unlock = () => {
			throw new Error("Audio output is not available")
		}
		await c.start()
		expect(c.get().phase).toBe("error")
		expect(c.get().error).toBe("Audio output is not available")
	})

	it("sends the session cookie to the audio port on a protected core", async () => {
		const { c, calls } = setup(status(), true)
		await c.start()
		expect(calls.at(-1)).toBe(
			"play http://localhost:3102/stream s16le 16000 cred",
		)
	})

	it("does not reattach on a retune: the core's stream follows tuning", async () => {
		vi.useFakeTimers()
		const { c, calls, feed } = setup(status())
		await c.start()
		feed(status({}, 25_000))
		feed(status({ clientCount: 2 }, -400_000))
		vi.advanceTimersByTime(2000)
		expect(calls.filter(x => x.startsWith("play"))).toHaveLength(1)
		// a new sample rate ends the core's stream: reattach
		feed(status({ effectiveSampleRate: 48_000 }))
		vi.advanceTimersByTime(300)
		expect(calls.at(-1)).toBe("play http://localhost:3102/stream s16le 48000")
		vi.useRealTimers()
	})

	it("is playing once the worklet plays, and retries when the stream ends", async () => {
		vi.useFakeTimers()
		const { c, calls, events } = setup(status())
		await c.start()
		events().onStats({
			playing: true,
			bufferedMs: 200,
			underruns: 0,
			droppedSamples: 0,
		})
		expect(c.get().phase).toBe("playing")
		events().onEnded("The audio stream ended")
		expect(c.get().phase).toBe("connecting")
		vi.advanceTimersByTime(1000)
		expect(calls.filter(x => x.startsWith("play"))).toHaveLength(2)
		vi.useRealTimers()
	})

	it("stops the player and the core's audio when the last listener leaves", async () => {
		const { c, calls } = setup(status())
		await c.start()
		await c.stop()
		expect(calls.at(-1)).toBe("stop")
		expect(c.get()).toMatchObject({ wanted: false, phase: "off" })
	})

	it("asks for a gesture when the context stays suspended", async () => {
		const { c, calls, events } = setup(status())
		await c.start()
		events().onBlocked()
		expect(c.get().phase).toBe("blocked")
		c.resume()
		expect(calls.at(-1)).toBe("unlock 16000")
	})
})

describe("ListenController hold (a recording plays here)", () => {
	it("mutes live audio while held and restores the operator's volume after", () => {
		const volumes: number[] = []
		const liveAudio = {
			get: () => ({ status: status() }),
		} as unknown as LiveAudioStore
		const c = new ListenController(liveAudio, {
			createPlayer: () => ({
				unlock: () => undefined,
				play: () => undefined,
				stop: () => undefined,
				setVolume: v => void volumes.push(v),
				dispose: () => undefined,
			}),
		})
		c.setVolume(0.6)
		c.hold(true)
		expect(c.isHeld).toBe(true)
		c.setVolume(0.4)
		expect(c.get().volume).toBe(0.4)
		c.hold(false)
		expect(volumes.slice(-4)).toEqual([0.6, 0, 0, 0.4])
	})
})

describe("ListenController recording", () => {
	it("records what the player decodes and hands the file over when listening stops", async () => {
		let tap: ((s: Float32Array, rate: number) => void) | null = null
		const player: ListenPlayer = {
			unlock: () => undefined,
			play: () => undefined,
			stop: () => undefined,
			setVolume: () => undefined,
			dispose: () => undefined,
			setTap: t => {
				tap = t
			},
			outputLatencyMs: () => 20,
		}
		const liveAudio = {
			get: () => ({ status: status() }),
			start: vi.fn(() => Promise.resolve()),
			stop: vi.fn(() => Promise.resolve()),
		} as unknown as LiveAudioStore
		const c = new ListenController(liveAudio, { createPlayer: () => player })
		expect(c.canRecord).toBe(true)
		await c.start()
		const ended: Blob[] = []
		expect(c.startRecording(wav => void ended.push(wav))).toBe(true)
		expect(c.startRecording(() => undefined)).toBe(false)
		tap!(new Float32Array(16_000), 16_000)
		expect(c.get().recording?.seconds).toBe(1)
		await c.stop()
		expect(tap).toBeNull()
		expect(c.get().recording).toBeNull()
		expect(ended).toHaveLength(1)
		expect(ended[0]!.size).toBe(44 + 32_000)
	})

	it("cannot record on the <audio> fallback", () => {
		const liveAudio = {
			get: () => ({ status: null }),
		} as unknown as LiveAudioStore
		const c = new ListenController(liveAudio, { createPlayer: null })
		expect(c.canRecord).toBe(false)
		expect(c.startRecording(() => undefined)).toBe(false)
	})
})
