import { describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import type { ActivitySummary, LiveAudioStatus } from "@wavekit/api-types"

import type { LiveAudioStore } from "../../src/data/index.ts"
import { listenAfterTune } from "../../src/features/listen/after-tune.ts"
import {
	ListenController,
	type ListenPlayer,
} from "../../src/features/listen/controller.ts"
import {
	AUTO_NEXT_KEY,
	PREV_RESTART_S,
	PlaybackService,
	canPrev,
	discPauses,
	fileErrorText,
	heldOf,
	markOf,
	queuePosition,
	queueStep,
} from "../../src/features/playback/service.ts"
import type {
	AudioLike,
	KeyValueStore,
	QueueRef,
} from "../../src/features/playback/service.ts"
import { synthWav } from "../../mock/recordings.ts"
import { ApiClient, ApiError } from "../../src/data/api-client.ts"
import { RecordingReadiness } from "../../src/data/recording-readiness.ts"
import { RecordingsStore } from "../../src/data/recordings-store.ts"

class FakeAudio implements AudioLike {
	src = ""
	currentTime = 0
	duration = Number.NaN
	playbackRate = 1
	preservesPitch = false
	playing = false
	paused = true
	ended = false
	calls: string[] = []
	/** The next play() result; resolves by default. */
	nextPlay: (() => Promise<void>) | null = null
	private readonly handlers = new Map<string, (() => void)[]>()
	play() {
		this.calls.push("play")
		this.playing = true
		this.paused = false
		const next = this.nextPlay
		this.nextPlay = null
		return next ? next() : Promise.resolve()
	}
	pause() {
		this.calls.push("pause")
		this.playing = false
		this.paused = true
	}
	removeAttribute(name: string) {
		this.calls.push(`remove ${name}`)
		if (name === "src") this.src = ""
	}
	load() {
		this.calls.push("load")
	}
	addEventListener(type: string, fn: () => void) {
		this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn])
	}
	emit(type: string) {
		for (const fn of this.handlers.get(type) ?? []) fn()
	}
	/** The file's metadata arrived. */
	meta(duration: number) {
		this.duration = duration
		this.emit("loadedmetadata")
	}
}

interface Deferred {
	resolve: () => void
	reject: (e: unknown) => void
}

function memoryStorage(initial: Record<string, string> = {}): KeyValueStore & {
	data: Record<string, string>
} {
	const data = { ...initial }
	return {
		data,
		getItem: k => data[k] ?? null,
		setItem: (k, v) => {
			data[k] = v
		},
	}
}

/** A service on a fake element, a fake fetch (immediate, or held with `hold: true`) and a recorded hold. */
function setup(
	opts: {
		hold?: boolean
		fail?: Record<string, string>
		storage?: KeyValueStore | null
	} = {},
) {
	const audio = new FakeAudio()
	const held: boolean[] = []
	const pending = new Map<string, Deferred>()
	const revoked: string[] = []
	let urls = 0
	const fetchFile = vi.fn((id: string) => {
		const failure = opts.fail?.[id]
		if (failure !== undefined) return Promise.reject(new Error(failure))
		const blob = new Blob([new Uint8Array(synthWav(2, id.length))])
		if (!opts.hold) return Promise.resolve(blob)
		return new Promise<Blob>((resolve, reject) => {
			pending.set(id, { resolve: () => resolve(blob), reject })
		})
	})
	const p = new PlaybackService({
		fetchFile,
		holdLive: h => held.push(h),
		createAudio: () => audio,
		createUrl: () => `blob:${++urls}`,
		revokeUrl: u => void revoked.push(u),
		storage: opts.storage === undefined ? memoryStorage() : opts.storage,
	})
	/** Lands the held fetch of `id` and lets the service see it. */
	const land = async (id: string) => {
		pending.get(id)?.resolve()
		pending.delete(id)
		await flush()
	}
	return { audio, held, fetchFile, p, land, pending, revoked }
}

const flush = () => new Promise<void>(r => setTimeout(r, 0))
const Q = (...ids: string[]): QueueRef => ({ source: "activity", ids })

/** Plays `id` and waits until it plays. */
async function playing(
	s: ReturnType<typeof setup>,
	id = "a",
	queue?: QueueRef,
) {
	s.p.play(id, queue)
	await flush()
	expect(s.p.get().phase).toBe("playing")
}

describe("PlaybackService: play", () => {
	it("any → loading on a new id: aborts the prior load, pauses, resets, takes the queue", async () => {
		const s = setup({ hold: true })
		s.p.play("a", Q("a", "b"), 1.5)
		expect(s.p.get()).toMatchObject({
			id: "a",
			phase: "loading",
			pos: 1.5,
			duration: null,
			error: null,
			wantPlay: true,
			queue: Q("a", "b"),
		})
		s.p.play("b")
		expect(s.p.get()).toMatchObject({ id: "b", phase: "loading", queue: null })
		// the first file lands after it was superseded: ignored (stale token)
		await s.land("a")
		expect(s.p.get()).toMatchObject({ id: "b", phase: "loading" })
		expect(s.audio.src).toBe("")
		await s.land("b")
		expect(s.p.get()).toMatchObject({ id: "b", phase: "playing" })
	})

	it("loading → loading on the same id: no second fetch", async () => {
		const s = setup({ hold: true })
		s.p.play("a")
		s.p.play("a")
		expect(s.fetchFile).toHaveBeenCalledTimes(1)
		expect(s.p.get().phase).toBe("loading")
	})

	it("file loaded → playing: src, speed, the position (a seek made while loading kept)", async () => {
		const s = setup({ hold: true })
		s.p.cycleSpeed()
		s.p.play("a", undefined, 1)
		s.p.seek(1.25)
		expect(s.p.get()).toMatchObject({ phase: "loading", pos: 1.25 })
		await s.land("a")
		expect(s.audio.src).toBe("blob:1")
		expect(s.audio.playbackRate).toBe(1.5)
		expect(s.audio.currentTime).toBe(1.25)
		expect(s.audio.playing).toBe(true)
		expect(s.p.get().phase).toBe("playing")
	})

	it("file loaded while a pause came during loading → paused, never starts", async () => {
		const s = setup({ hold: true })
		s.p.play("a")
		s.p.pause()
		expect(s.p.get()).toMatchObject({ phase: "loading", wantPlay: false })
		await s.land("a")
		expect(s.p.get().phase).toBe("paused")
		expect(s.audio.calls).not.toContain("play")
	})

	it("loading toggle flips wantPlay; resume asks to play again", async () => {
		const s = setup({ hold: true })
		s.p.play("a")
		s.p.toggle()
		expect(s.p.get().wantPlay).toBe(false)
		s.p.toggle()
		expect(s.p.get().wantPlay).toBe(true)
		s.p.pause()
		s.p.resume()
		expect(s.p.get().wantPlay).toBe(true)
	})

	it("file failed → error with the message", async () => {
		const s = setup({ fail: { gone: "Recording not found" } })
		s.p.play("gone")
		await flush()
		expect(s.p.get()).toMatchObject({
			id: "gone",
			phase: "error",
			error: "Recording not found",
		})
	})

	it("a failure of a superseded load is ignored", async () => {
		const s = setup({ hold: true })
		s.p.play("a")
		s.p.play("b")
		s.pending.get("a")?.reject(new Error("late"))
		await flush()
		expect(s.p.get()).toMatchObject({ id: "b", phase: "loading", error: null })
	})

	it("playing/paused/ended → playing on the same id: seeks and plays, keeping the queue", async () => {
		const s = setup()
		await playing(s, "a", Q("a", "b"))
		s.audio.meta(2)
		s.p.pause()
		s.p.play("a", undefined, 0.5)
		expect(s.p.get()).toMatchObject({
			phase: "playing",
			pos: 0.5,
			queue: Q("a", "b"),
		})
		expect(s.audio.currentTime).toBe(0.5)
		expect(s.fetchFile).toHaveBeenCalledTimes(1)
	})

	it("error → play fetches again", async () => {
		const s = setup()
		await playing(s)
		s.audio.emit("error")
		s.p.play("a")
		await flush()
		expect(s.fetchFile).toHaveBeenCalledTimes(2)
		expect(s.p.get().phase).toBe("playing")
	})
})

describe("PlaybackService: play() rejections", () => {
	it("NotAllowedError → paused without an error (the user presses play)", async () => {
		const s = setup()
		s.audio.nextPlay = () =>
			Promise.reject(new DOMException("blocked", "NotAllowedError"))
		s.p.play("a")
		await flush()
		expect(s.p.get()).toMatchObject({ phase: "paused", error: null })
	})

	it("AbortError → ignored (superseded)", async () => {
		const s = setup()
		s.audio.nextPlay = () =>
			Promise.reject(new DOMException("aborted", "AbortError"))
		s.p.play("a")
		await flush()
		expect(s.p.get().phase).toBe("playing")
	})

	it("another error → paused with its message", async () => {
		const s = setup()
		s.audio.nextPlay = () => Promise.reject(new Error("no output device"))
		s.p.play("a")
		await flush()
		expect(s.p.get()).toMatchObject({
			phase: "paused",
			error: "no output device",
		})
	})

	it("a rejection from an older epoch (stopped since) is ignored", async () => {
		const s = setup()
		let reject: (e: unknown) => void = () => {}
		s.audio.nextPlay = () =>
			new Promise<void>((_, r) => {
				reject = r
			})
		s.p.play("a")
		await flush()
		s.p.stop()
		s.p.play("b")
		await flush()
		reject(new Error("late"))
		await flush()
		expect(s.p.get()).toMatchObject({ id: "b", phase: "playing", error: null })
	})

	it("a late rejection of an earlier start (paused and resumed since) leaves the current play playing", async () => {
		const s = setup()
		let reject: (e: unknown) => void = () => {}
		s.audio.nextPlay = () =>
			new Promise<void>((_, r) => {
				reject = r
			})
		s.p.play("a")
		await flush()
		s.p.pause()
		s.p.resume()
		expect(s.p.get().phase).toBe("playing")
		reject(new Error("late"))
		await flush()
		expect(s.p.get()).toMatchObject({ id: "a", phase: "playing", error: null })
	})
})

describe("PlaybackService: pause, resume, seek", () => {
	it("playing → paused → playing; ended → playing from 0", async () => {
		const s = setup()
		await playing(s)
		s.audio.meta(2)
		s.p.pause()
		expect(s.p.get().phase).toBe("paused")
		expect(s.audio.playing).toBe(false)
		s.p.toggle()
		expect(s.p.get().phase).toBe("playing")
		s.audio.currentTime = 2
		s.p.setAutoNext(false)
		s.audio.emit("ended")
		expect(s.p.get()).toMatchObject({ phase: "ended", pos: 2 })
		s.p.resume()
		expect(s.p.get()).toMatchObject({ phase: "playing", pos: 0 })
		expect(s.audio.currentTime).toBe(0)
	})

	it("seek clamps to 0..duration; ended → paused", async () => {
		const s = setup()
		await playing(s)
		s.audio.meta(2)
		s.p.seek(9)
		expect(s.p.get().pos).toBe(2)
		s.p.seek(-1)
		expect(s.p.get().pos).toBe(0)
		s.p.setAutoNext(false)
		s.audio.emit("ended")
		s.p.seek(1)
		expect(s.p.get()).toMatchObject({ phase: "paused", pos: 1 })
		expect(s.audio.currentTime).toBe(1)
	})

	it("a waveform click on the paused current recording goes there and plays on; another starts there", async () => {
		const s = setup()
		await playing(s, "a", Q("a", "b"))
		s.audio.meta(2)
		s.p.pause()
		s.p.seekOrPlay("a", 1.5, Q("a", "b"))
		expect(s.p.get()).toMatchObject({ id: "a", phase: "playing", pos: 1.5 })
		expect(s.audio.currentTime).toBe(1.5)
		// while it plays, only the position moves
		s.p.seekOrPlay("a", 0.5, Q("a", "b"))
		expect(s.p.get()).toMatchObject({ id: "a", phase: "playing", pos: 0.5 })
		// an ended one plays on from the click too
		s.p.setAutoNext(false)
		s.audio.emit("ended")
		s.p.seekOrPlay("a", 1, Q("a", "b"))
		expect(s.p.get()).toMatchObject({ phase: "playing", pos: 1 })
		s.p.seekOrPlay("b", 0.25, Q("a", "b"))
		expect(s.p.get()).toMatchObject({ id: "b", pos: 0.25 })
	})

	it("the disc says Pause while it plays and while it loads to play", () => {
		expect(discPauses("playing", true)).toBe(true)
		expect(discPauses("loading", true)).toBe(true)
		expect(discPauses("loading", false)).toBe(false)
		expect(discPauses("paused", false)).toBe(false)
		expect(discPauses("ended", false)).toBe(false)
		expect(discPauses(null, false)).toBe(false)
	})

	it("idle: toggle, pause, resume and seek do nothing", () => {
		const s = setup()
		const before = s.p.get()
		s.p.toggle()
		s.p.pause()
		s.p.resume()
		s.p.seek(3)
		s.p.next()
		s.p.prev()
		expect(s.p.get()).toBe(before)
		expect(s.fetchFile).not.toHaveBeenCalled()
	})

	it("cycleSpeed sets the element's rate only once a file is loaded", async () => {
		const s = setup({ hold: true })
		s.p.play("a")
		s.p.cycleSpeed()
		expect(s.audio.playbackRate).toBe(1)
		await s.land("a")
		expect(s.audio.playbackRate).toBe(1.5)
		s.p.cycleSpeed()
		expect(s.audio.playbackRate).toBe(2)
		s.p.cycleSpeed()
		expect(s.p.get().speed).toBe(1)
	})
})

describe("PlaybackService: element events", () => {
	it("playing + ended with Auto-next and a next one → loading the next, same queue", async () => {
		const s = setup()
		await playing(s, "a", Q("a", "b"))
		s.audio.emit("ended")
		expect(s.p.get()).toMatchObject({
			id: "b",
			phase: "loading",
			queue: Q("a", "b"),
		})
		await flush()
		expect(s.p.get().phase).toBe("playing")
	})

	it("playing + ended at the end of the queue or with Auto-next off → ended at the duration", async () => {
		const s = setup()
		await playing(s, "b", Q("a", "b"))
		s.audio.meta(2)
		s.audio.emit("ended")
		expect(s.p.get()).toMatchObject({ id: "b", phase: "ended", pos: 2 })
		const t = setup()
		t.p.setAutoNext(false)
		await playing(t, "a", Q("a", "b"))
		t.audio.emit("ended")
		expect(t.p.get()).toMatchObject({ id: "a", phase: "ended" })
	})

	it("a Play all queue plays every part to its end whatever Auto-next says", async () => {
		const s = setup()
		s.p.setAutoNext(false)
		const all: QueueRef = { ...Q("a", "b", "c"), playAll: true }
		await playing(s, "a", all)
		s.audio.emit("ended")
		expect(s.p.get()).toMatchObject({ id: "b", phase: "loading", queue: all })
		await flush()
		s.audio.emit("ended")
		expect(s.p.get()).toMatchObject({ id: "c", phase: "loading" })
		await flush()
		s.audio.meta(2)
		s.audio.emit("ended")
		// the queue's end: it stops there
		expect(s.p.get()).toMatchObject({ id: "c", phase: "ended" })
		// a surface refreshing the same list keeps it a Play all
		const t = setup()
		t.p.setAutoNext(false)
		await playing(t, "a", all)
		t.p.setQueue("activity", ["a", "b", "c", "d"])
		expect(t.p.get().queue?.playAll).toBe(true)
	})

	it("paused + ended stays paused, never auto-next", async () => {
		const s = setup()
		await playing(s, "a", Q("a", "b"))
		s.p.pause()
		s.audio.emit("ended")
		expect(s.p.get()).toMatchObject({ id: "a", phase: "paused" })
	})

	it("playing/paused + error → error, and the file is fetched again by toggle", async () => {
		const s = setup()
		await playing(s)
		s.p.seek(0.75)
		s.audio.emit("error")
		expect(s.p.get()).toMatchObject({
			phase: "error",
			error: "This recording could not be played",
		})
		s.p.toggle()
		expect(s.p.get()).toMatchObject({ phase: "loading", pos: 0.75 })
		await flush()
		expect(s.fetchFile).toHaveBeenCalledTimes(2)
		expect(s.p.get().phase).toBe("playing")
		s.p.pause()
		s.audio.emit("error")
		expect(s.p.get().phase).toBe("error")
	})

	it("loading and idle ignore ended, error, loadedmetadata and timeupdate", async () => {
		const s = setup({ hold: true })
		s.p.play("a")
		await s.land("a")
		s.p.play("b")
		for (const e of ["ended", "error", "timeupdate"]) s.audio.emit(e)
		s.audio.meta(9)
		expect(s.p.get()).toMatchObject({
			id: "b",
			phase: "loading",
			duration: null,
			error: null,
		})
		s.p.stop()
		for (const e of ["ended", "error", "timeupdate"]) s.audio.emit(e)
		s.audio.meta(9)
		expect(s.p.get()).toMatchObject({ id: null, phase: "idle", duration: null })
	})

	it("timeupdate and loadedmetadata follow the element while loaded", async () => {
		const s = setup()
		await playing(s)
		s.audio.meta(2)
		s.audio.currentTime = 1.2
		s.audio.emit("timeupdate")
		expect(s.p.get()).toMatchObject({ pos: 1.2, duration: 2 })
	})
})

describe("PlaybackService: stop, forget, dispose", () => {
	it("stop → idle: aborts, empties the element, clears the queue", async () => {
		const s = setup({ hold: true })
		s.p.play("a", Q("a"))
		s.p.stop()
		// nothing was loaded into the element yet
		expect(s.audio.calls).toEqual([])
		await s.land("a")
		expect(s.p.get()).toMatchObject({
			id: null,
			phase: "idle",
			pos: 0,
			queue: null,
			wantPlay: false,
		})
		expect(s.audio.src).toBe("")
		const t = setup()
		await playing(t)
		t.audio.calls = []
		t.p.stop()
		expect(t.audio.calls).toEqual(["pause", "remove src", "load"])
		expect(t.p.get().id).toBeNull()
	})

	it("forget the current one → idle and its file dropped", async () => {
		const s = setup()
		await playing(s)
		s.p.forget("a")
		expect(s.p.get().phase).toBe("idle")
		expect(s.revoked).toEqual(["blob:1"])
		expect(s.p.peaks.get().has("a")).toBe(false)
	})

	it("forget another one → removed from the queue, same phase", async () => {
		const s = setup()
		await playing(s, "a", Q("a", "b", "c"))
		s.p.forget("b")
		expect(s.p.get()).toMatchObject({ phase: "playing", queue: Q("a", "c") })
	})

	it("forget while its fetch is in flight: the file is never cached nor its peaks kept", async () => {
		const s = setup({ hold: true })
		void s.p.loadPeaks("x")
		s.p.forget("x")
		await s.land("x")
		expect(s.p.peaks.get().has("x")).toBe(false)
		s.p.play("x")
		expect(s.fetchFile).toHaveBeenCalledTimes(2)
	})

	it("forget aborting a waveform read keeps no flat waveform: an Undo loads it anew", async () => {
		const blob = new Blob([new Uint8Array(synthWav(2, 1))])
		let calls = 0
		const fetchFile = vi.fn(
			(_id: string, signal?: AbortSignal) =>
				new Promise<Blob>((resolve, reject) => {
					calls++
					if (calls > 1) {
						resolve(blob)
						return
					}
					signal?.addEventListener("abort", () =>
						reject(new DOMException("aborted", "AbortError")),
					)
				}),
		)
		const p = new PlaybackService({
			fetchFile,
			holdLive: () => {},
			createAudio: () => new FakeAudio(),
			createUrl: () => "blob:1",
			revokeUrl: () => {},
			storage: memoryStorage(),
		})
		const first = p.loadPeaks("x")
		p.forget("x")
		await first
		expect(p.peaks.get().has("x")).toBe(false)
		await p.loadPeaks("x")
		expect(fetchFile).toHaveBeenCalledTimes(2)
		expect(p.peaks.get().get("x")).not.toBe("none")
	})

	it("Delete then Undo while the shared fetch is in flight: a new play fetches anew and plays", async () => {
		const s = setup({ hold: true })
		s.p.play("x", Q("x"))
		s.p.forget("x")
		expect(s.p.get().phase).toBe("idle")
		// Undo: the row is back and played again before the old fetch lands
		s.p.play("x", Q("x"))
		expect(s.fetchFile).toHaveBeenCalledTimes(2)
		await s.land("x")
		expect(s.p.get()).toMatchObject({ id: "x", phase: "playing", error: null })
		expect(s.p.peaks.get().has("x")).toBe(true)
	})

	it("a superseded or stopped start aborts its fetch; one still waited for elsewhere goes on", async () => {
		const s = setup({ hold: true })
		const signalOf = (n: number) =>
			(s.fetchFile.mock.calls[n] as unknown as [string, AbortSignal])[1]
		s.p.play("a", Q("a", "b"))
		s.p.play("b", Q("a", "b"))
		expect(signalOf(0).aborted).toBe(true)
		expect(signalOf(1).aborted).toBe(false)
		s.p.stop()
		expect(signalOf(1).aborted).toBe(true)
		// a waveform read (no signal) keeps the shared fetch going when the play is superseded
		void s.p.loadPeaks("c")
		s.p.play("c")
		s.p.play("a")
		expect(signalOf(2).aborted).toBe(false)
		s.p.forget("c")
		expect(signalOf(2).aborted).toBe(true)
		s.p.dispose()
		expect(signalOf(3).aborted).toBe(true)
	})

	it("a superseded start stops the store's retry loop for a file still being saved", async () => {
		vi.useFakeTimers()
		try {
			const readiness = new RecordingReadiness()
			readiness.note([
				{
					eventId: "evt_a",
					producedAt: new Date().toISOString(),
					recording: { id: "a", durationMs: 1000 },
				} as ActivitySummary,
			])
			let calls = 0
			const api = new ApiClient({
				fetch: () => {
					calls += 1
					return Promise.resolve(
						new Response(
							JSON.stringify({ code: "RECORDING_NOT_FOUND", message: "x" }),
							{ status: 404 },
						),
					)
				},
			})
			const store = new RecordingsStore(api, null, {}, readiness)
			const p = new PlaybackService({
				fetchFile: (id, signal) => store.file(id, signal),
				holdLive: () => undefined,
				createAudio: () => new FakeAudio(),
				storage: null,
			})
			p.play("a")
			await vi.advanceTimersByTimeAsync(0)
			expect(calls).toBe(1)
			p.play("b")
			await vi.advanceTimersByTimeAsync(60_000)
			// "b" is not linked here: one try; "a" was never tried again
			expect(calls).toBe(2)
			p.dispose()
			store.dispose()
		} finally {
			vi.useRealTimers()
		}
	})

	it("a fetch landing after dispose creates and caches no object URL", async () => {
		let urls = 0
		const pending: (() => void)[] = []
		const p = new PlaybackService({
			fetchFile: () =>
				new Promise<Blob>(r => {
					pending.push(() => r(new Blob([new Uint8Array(synthWav(1, 1))])))
				}),
			holdLive: () => undefined,
			createAudio: () => new FakeAudio(),
			createUrl: () => `blob:${++urls}`,
			revokeUrl: () => undefined,
			storage: null,
		})
		p.play("a")
		void p.loadPeaks("b")
		p.dispose()
		for (const land of pending) land()
		await flush()
		expect(urls).toBe(0)
		expect(p.peaks.get().size).toBe(0)
	})

	it("a failed waveform read reads as none, never loading for good", async () => {
		const s = setup({ fail: { bad: "503" } })
		await s.p.loadPeaks("bad")
		expect(s.p.peaks.get().get("bad")).toBe("none")
	})

	it("dispose → idle, every file revoked, live audio released", async () => {
		const s = setup()
		await playing(s)
		await s.p.loadPeaks("b")
		s.p.dispose()
		expect(s.p.get().phase).toBe("idle")
		expect([...s.revoked].sort()).toEqual(["blob:1", "blob:2"])
		expect(s.held).toEqual([true, false])
	})
})

describe("PlaybackService: queue, next, prev", () => {
	it("next and prev play the neighbour in the same queue; none at the ends", async () => {
		const s = setup()
		await playing(s, "b", Q("a", "b", "c"))
		s.p.next()
		expect(s.p.get()).toMatchObject({ id: "c", queue: Q("a", "b", "c") })
		await flush()
		s.p.next()
		expect(s.p.get().id).toBe("c")
		s.p.prev()
		expect(s.p.get().id).toBe("b")
		await flush()
		s.p.prev()
		await flush()
		s.p.prev()
		expect(s.p.get().id).toBe("a")
	})

	it("Prev is enabled exactly when it does something (the same 2 s rule)", async () => {
		const s = setup()
		await playing(s, "a", Q("a"))
		s.audio.meta(10)
		s.p.seek(1)
		// at 1 s, first of its queue: prev() would do nothing, so the button is off
		expect(canPrev(s.p.get())).toBe(false)
		s.p.prev()
		expect(s.p.get()).toMatchObject({ id: "a", pos: 1 })
		s.p.seek(PREV_RESTART_S + 0.5)
		expect(canPrev(s.p.get())).toBe(true)
		s.p.prev()
		expect(s.p.get().pos).toBe(0)
		const t = setup()
		await playing(t, "b", Q("a", "b"))
		expect(canPrev(t.p.get())).toBe(true)
	})

	it("prev past 2 s goes back to the start of the same recording", async () => {
		const s = setup()
		await playing(s, "b", Q("a", "b"))
		s.audio.meta(10)
		s.p.seek(5)
		s.p.prev()
		expect(s.p.get()).toMatchObject({ id: "b", pos: 0 })
	})

	it("several lists of one source: only the list played from refreshes its queue", async () => {
		const s = setup()
		const drawer: QueueRef = {
			source: "activity",
			list: "drawer",
			ids: ["a", "b"],
		}
		await playing(s, "a", drawer)
		// a pinned column showing the same recording never takes the queue over
		s.p.setQueue("activity", ["a", "z"], undefined, "column-1")
		expect(s.p.get().queue).toEqual(drawer)
		// nor does a list without a key
		s.p.setQueue("activity", ["a", "y"])
		expect(s.p.get().queue).toEqual(drawer)
		s.p.setQueue("activity", ["a", "b", "c"], undefined, "drawer")
		expect(s.p.get().queue).toEqual({
			source: "activity",
			list: "drawer",
			ids: ["a", "b", "c"],
		})
	})

	it("setQueue replaces the snapshot only from the same source while it holds the recording", async () => {
		const s = setup()
		await playing(s, "b", Q("a", "b"))
		s.p.setQueue("recordings", ["b", "z"])
		expect(s.p.get().queue).toEqual(Q("a", "b"))
		s.p.setQueue("activity", ["x", "y"])
		expect(s.p.get().queue).toEqual(Q("a", "b"))
		s.p.setQueue("activity", ["b", "c"], { b: "B", c: "C" })
		expect(s.p.get().queue).toEqual({
			source: "activity",
			ids: ["b", "c"],
			titles: { b: "B", c: "C" },
		})
		expect(queuePosition(s.p.get())).toBe("1 of 2")
	})

	it("setQueue leaves an equal queue as it is, even with its titles rebuilt", async () => {
		const s = setup()
		await playing(s, "b", {
			source: "tuned",
			ids: ["a", "b"],
			titles: { a: "A", b: "B" },
		})
		const before = s.p.get()
		s.p.setQueue("tuned", ["a", "b"], { a: "A", b: "B" })
		expect(s.p.get()).toBe(before)
		s.p.setQueue("tuned", ["a", "b"], { a: "A", b: "B2" })
		expect(s.p.get().queue?.titles).toEqual({ a: "A", b: "B2" })
		s.p.setQueue("tuned", ["a", "b"], { a: "A" })
		expect(s.p.get().queue?.titles).toEqual({ a: "A" })
	})

	it("queueStep reads the neighbour; null off the list or past its ends", () => {
		const q = Q("a", "b")
		expect(queueStep(q, "a", 1)).toBe("b")
		expect(queueStep(q, "a", -1)).toBeNull()
		expect(queueStep(q, "z", 1)).toBeNull()
		expect(queueStep(null, "a", 1)).toBeNull()
	})
})

describe("PlaybackService: Auto-next storage", () => {
	it("defaults on, reads and persists the switch", () => {
		const st = memoryStorage()
		const s = setup({ storage: st })
		expect(s.p.get().autoNext).toBe(true)
		s.p.setAutoNext(false)
		expect(st.data[AUTO_NEXT_KEY]).toBe("0")
		expect(setup({ storage: st }).p.get().autoNext).toBe(false)
		s.p.setAutoNext(true)
		expect(st.data[AUTO_NEXT_KEY]).toBe("1")
	})

	it("unreadable storage → default on; unwritable → kept in memory", () => {
		const broken: KeyValueStore = {
			getItem: () => {
				throw new Error("denied")
			},
			setItem: () => {
				throw new Error("full")
			},
		}
		const s = setup({ storage: broken })
		expect(s.p.get().autoNext).toBe(true)
		s.p.setAutoNext(false)
		expect(s.p.get().autoNext).toBe(false)
		expect(setup({ storage: null }).p.get().autoNext).toBe(true)
	})
})

describe("PlaybackService: live hold (one subscriber)", () => {
	it("holds while playing or loading to play; paused, ended, error and idle restore", async () => {
		const s = setup({ hold: true })
		s.p.play("a", Q("a"))
		expect(s.held).toEqual([true])
		s.p.pause() // loading, wantPlay false
		expect(s.held).toEqual([true, false])
		s.p.resume()
		await s.land("a")
		expect(s.held).toEqual([true, false, true])
		s.p.pause()
		s.p.toggle()
		s.p.setAutoNext(false)
		s.audio.emit("ended")
		s.p.resume()
		s.audio.emit("error")
		s.p.toggle() // loading again
		s.p.stop()
		expect(s.held).toEqual([
			true,
			false,
			true,
			false,
			true,
			false,
			true,
			false,
			true,
			false,
		])
	})

	it("heldOf is the table's I2", () => {
		const base = setup().p.get()
		expect(heldOf({ ...base, id: "a", phase: "playing" })).toBe(true)
		expect(heldOf({ ...base, id: "a", phase: "loading", wantPlay: true })).toBe(
			true,
		)
		expect(
			heldOf({ ...base, id: "a", phase: "loading", wantPlay: false }),
		).toBe(false)
		for (const phase of ["paused", "ended", "error", "idle"] as const)
			expect(heldOf({ ...base, id: "a", phase, wantPlay: true })).toBe(false)
	})
})

describe("PlaybackService: marks", () => {
	it("marks one id with its phase", async () => {
		const s = setup()
		await playing(s, "a")
		expect(markOf("a")(s.p.get())).toBe("playing")
		expect(markOf("b")(s.p.get())).toBeNull()
	})

	it("keeps no per-surface row state: no surface can shrink the dock", async () => {
		const s = setup()
		await playing(s, "a")
		expect(Object.keys(s.p.get())).not.toContain("expanded")
		expect("setExpanded" in s.p).toBe(false)
	})
})

// The player model's transition table (service.ts, top comment): one test per cell that moves.
type Phase = "idle" | "loading" | "playing" | "paused" | "ended" | "error"
type PlayerEvent =
	| "play row"
	| "play all"
	| "next/prev"
	| "close"
	| "end"
	| "error"

/** A service in `phase` with "a" in the player (queue a, b; Auto-next as given). */
async function inPhase(phase: Phase, autoNext = true) {
	const s = setup({
		hold: phase === "loading",
		fail: phase === "error" ? { a: "boom" } : {},
	})
	s.p.setAutoNext(autoNext)
	if (phase === "idle") return s
	s.p.play("a", Q("a", "b"))
	await flush()
	if (phase === "paused") s.p.pause()
	if (phase === "ended") {
		// played to its end with Auto-next off (a paused file's end event leaves it paused)
		s.p.setAutoNext(false)
		s.audio.ended = true
		s.audio.emit("ended")
		s.audio.ended = false
		s.p.setAutoNext(autoNext)
	}
	expect(s.p.get().phase).toBe(phase)
	return s
}

/** Fires `event` on the service. */
function fire(s: ReturnType<typeof setup>, event: PlayerEvent): void {
	switch (event) {
		case "play row":
			s.p.play("b", Q("a", "b"), 0, "B")
			return
		case "play all":
			s.p.play("b", Q("b", "a"), 0, "B")
			return
		case "next/prev":
			s.p.next()
			return
		case "close":
			s.p.stop()
			return
		case "end":
			s.audio.ended = true
			s.audio.emit("ended")
			return
		case "error":
			s.audio.emit("error")
			return
	}
}

const TABLE: Record<Phase, Record<PlayerEvent, Phase>> = {
	idle: {
		"play row": "loading",
		"play all": "loading",
		"next/prev": "idle",
		close: "idle",
		end: "idle",
		error: "idle",
	},
	loading: {
		"play row": "loading",
		"play all": "loading",
		"next/prev": "loading",
		close: "idle",
		end: "loading",
		// an element error is not the loading file's: its failed fetch is (the test below)
		error: "loading",
	},
	playing: {
		"play row": "loading",
		"play all": "loading",
		"next/prev": "loading",
		close: "idle",
		end: "loading",
		error: "error",
	},
	paused: {
		"play row": "loading",
		"play all": "loading",
		"next/prev": "loading",
		close: "idle",
		end: "paused",
		error: "error",
	},
	ended: {
		"play row": "loading",
		"play all": "loading",
		"next/prev": "loading",
		close: "idle",
		end: "ended",
		error: "ended",
	},
	error: {
		"play row": "loading",
		"play all": "loading",
		"next/prev": "loading",
		close: "idle",
		end: "error",
		error: "error",
	},
}

describe("PlaybackService: the transition table", () => {
	for (const [from, row] of Object.entries(TABLE) as [
		Phase,
		Record<PlayerEvent, Phase>,
	][])
		for (const [event, to] of Object.entries(row) as [PlayerEvent, Phase][])
			it(`${from} + ${event} → ${to}`, async () => {
				const s = await inPhase(from)
				fire(s, event)
				expect(s.p.get().phase).toBe(to)
			})

	it("loading + error: a failed fetch is the error", async () => {
		const s = setup({ fail: { a: "boom" } })
		s.p.play("a")
		expect(s.p.get().phase).toBe("loading")
		await flush()
		expect(s.p.get()).toMatchObject({ phase: "error", error: "boom" })
	})

	it("playing + end without Auto-next (or at the queue's end) → ended", async () => {
		const s = await inPhase("playing", false)
		fire(s, "end")
		expect(s.p.get().phase).toBe("ended")
	})

	it("the same recording again plays on from where it is asked, no new fetch", async () => {
		for (const from of ["playing", "paused", "ended"] as const) {
			const s = await inPhase(from)
			const fetches = s.fetchFile.mock.calls.length
			s.p.play("a", Q("a", "b"), 0.5)
			expect(s.p.get().phase).toBe("playing")
			expect(s.fetchFile.mock.calls.length).toBe(fetches)
		}
	})
})

describe("PlaybackService: a pause or play from outside the service", () => {
	it("an outside pause (a media key) pauses and gives live audio back; an outside play holds it again", async () => {
		const s = setup()
		await playing(s)
		expect(s.held).toEqual([true])
		s.audio.paused = true
		s.audio.emit("pause")
		expect(s.p.get().phase).toBe("paused")
		expect(s.held).toEqual([true, false])
		s.audio.paused = false
		s.audio.emit("play")
		expect(s.p.get()).toMatchObject({ phase: "playing", wantPlay: true })
		expect(s.held).toEqual([true, false, true])
	})

	it("the service's own pause and start are not seen twice", async () => {
		const s = setup()
		await playing(s)
		s.p.pause()
		s.audio.emit("pause")
		expect(s.p.get().phase).toBe("paused")
		s.p.resume()
		s.audio.emit("play")
		expect(s.p.get().phase).toBe("playing")
		expect(s.held).toEqual([true, false, true])
		// a pause and a resume in one go: the pause event, queued before the play, finds the element playing
		s.p.pause()
		s.p.resume()
		s.audio.emit("pause")
		s.audio.emit("play")
		expect(s.p.get().phase).toBe("playing")
		expect(s.held).toEqual([true, false, true, false, true])
	})

	it("the pause that comes with the end is the end's", async () => {
		const s = setup()
		await playing(s)
		s.audio.paused = true
		s.audio.ended = true
		s.audio.emit("pause")
		expect(s.p.get().phase).toBe("playing")
		s.audio.emit("ended")
		expect(s.p.get().phase).toBe("ended")
		expect(s.held).toEqual([true, false])
	})

	it("an outside play after the end plays it again from its start and holds live audio again", async () => {
		const s = setup()
		await playing(s)
		s.audio.paused = true
		s.audio.ended = true
		s.audio.emit("ended")
		expect(s.p.get().phase).toBe("ended")
		expect(s.held).toEqual([true, false])
		// a media key: the element starts over from 0
		s.audio.ended = false
		s.audio.paused = false
		s.audio.currentTime = 0
		s.audio.emit("play")
		expect(s.p.get()).toMatchObject({
			phase: "playing",
			wantPlay: true,
			pos: 0,
		})
		expect(s.held).toEqual([true, false, true])
	})

	it("loading, idle and an old src ignore pause and play", async () => {
		const s = setup({ hold: true })
		s.p.play("a")
		await s.land("a")
		s.p.pause()
		s.p.play("b")
		s.audio.paused = false
		s.audio.emit("play")
		s.audio.paused = true
		s.audio.emit("pause")
		expect(s.p.get()).toMatchObject({
			id: "b",
			phase: "loading",
			wantPlay: true,
		})
		s.p.stop()
		s.audio.paused = false
		s.audio.emit("play")
		expect(s.p.get()).toMatchObject({ id: null, phase: "idle" })
	})
})

describe("PlaybackService: why a file could not be fetched", () => {
	const refused = (status: number) =>
		new ApiError({
			status,
			code: null,
			message: `GET /api/recordings/a/file failed with ${status}`,
			body: "",
			method: "GET",
			path: "/api/recordings/a/file",
		})

	it("says each refusal in words", () => {
		expect(fileErrorText(refused(404))).toBe(
			"This recording is no longer on the receiver",
		)
		expect(fileErrorText(refused(410))).toBe(
			"This recording is no longer on the receiver",
		)
		expect(fileErrorText(refused(429))).toBe(
			"Too many recordings are being read; try again in a moment",
		)
		expect(fileErrorText(refused(503))).toBe("The receiver is busy; try again")
		expect(fileErrorText(refused(401))).toBe("Session expired, pair again")
		expect(fileErrorText(refused(500))).toBe(
			"GET /api/recordings/a/file failed with 500",
		)
		expect(fileErrorText(new Error("offline"))).toBe("offline")
	})

	it("the user guide names every refusal the player says", () => {
		const guide = readFileSync(
			new URL("../../../docs/WEB-APP.md", import.meta.url),
			"utf8",
		)
		for (const status of [401, 404, 429, 503])
			expect(guide).toContain(`\`${fileErrorText(refused(status))}\``)
	})

	it("the dock shows the words, and a 401 ends the session as other requests do", async () => {
		const api = new ApiClient({
			fetch: () =>
				Promise.resolve(
					new Response(JSON.stringify({ code: "SESSION_REQUIRED" }), {
						status: 401,
					}),
				),
		})
		api.setCsrfToken("t")
		const lost = vi.fn()
		api.onSessionLost(lost)
		const p = new PlaybackService({
			fetchFile: id => api.blob(`/api/recordings/${id}/file`),
			holdLive: () => undefined,
			createAudio: () => new FakeAudio(),
			createUrl: () => "blob:1",
			revokeUrl: () => undefined,
			storage: null,
		})
		p.play("a")
		await vi.waitFor(() => expect(p.get().phase).toBe("error"))
		expect(p.get().error).toBe("Session expired, pair again")
		expect(lost).toHaveBeenCalledTimes(1)
		p.dispose()
	})

	it("a 404 file reads as gone", async () => {
		const p = new PlaybackService({
			fetchFile: () => Promise.reject(refused(404)),
			holdLive: () => undefined,
			createAudio: () => new FakeAudio(),
			storage: null,
		})
		p.play("a")
		await vi.waitFor(() => expect(p.get().phase).toBe("error"))
		expect(p.get().error).toBe("This recording is no longer on the receiver")
		p.dispose()
	})
})

function liveSetup() {
	const status = {
		running: true,
		sourceId: "src-0",
		effectiveSampleRate: 16_000,
		httpUrl: "http://localhost:3102/stream",
		wavUrl: "http://localhost:3102/stream.wav",
		clientCount: 1,
		config: {
			modulation: "nfm",
			bandwidth: 12_500,
			squelch: 0,
			offsetHz: 0,
			audioFormat: "s16le",
		},
	} as LiveAudioStatus
	const liveAudio = {
		get: vi.fn(() => ({ status, error: null })),
		load: vi.fn(() => Promise.resolve()),
		start: vi.fn(() => Promise.resolve()),
		stop: vi.fn(() => Promise.resolve()),
		readAutoRoute: vi.fn(() => Promise.resolve(null)),
	} as unknown as LiveAudioStore
	const volumes: number[] = []
	const player: ListenPlayer = {
		unlock: () => undefined,
		play: () => undefined,
		stop: () => undefined,
		setVolume: v => void volumes.push(v),
		dispose: () => undefined,
	}
	const audio = new FakeAudio()
	let playback: PlaybackService | null = null
	const listen = new ListenController(liveAudio, {
		createPlayer: () => player,
		pausePlayback: () => playback?.pause(),
	})
	playback = new PlaybackService({
		fetchFile: () =>
			Promise.resolve(new Blob([new Uint8Array(synthWav(1, 1))])),
		holdLive: h => listen.hold(h),
		createAudio: () => audio,
		createUrl: () => "blob:x",
		revokeUrl: () => undefined,
		storage: null,
	})
	return { listen, playback, volumes, liveAudio }
}

describe("Listen and playback", () => {
	it("a recording mutes live audio; pausing it restores it", async () => {
		const { listen, playback, volumes } = liveSetup()
		await listen.start()
		playback.play("a")
		expect(listen.isHeld).toBe(true)
		expect(volumes.at(-1)).toBe(0)
		await flush()
		playback.pause()
		expect(listen.isHeld).toBe(false)
		expect(volumes.at(-1)).toBeGreaterThan(0)
	})

	it("Listen start while a recording plays pauses it and stays on", async () => {
		const { listen, playback } = liveSetup()
		playback.play("a")
		await flush()
		expect(playback.get().phase).toBe("playing")
		await listen.start()
		expect(playback.get().phase).toBe("paused")
		expect(listen.isHeld).toBe(false)
		expect(listen.get().wanted).toBe(true)
	})

	it("Listen start while one loads to play: it stays loading and will not start", async () => {
		const { listen, playback } = liveSetup()
		playback.play("a")
		const started = listen.start()
		expect(playback.get()).toMatchObject({ phase: "loading", wantPlay: false })
		await started
		await flush()
		expect(playback.get().phase).toBe("paused")
		expect(listen.isHeld).toBe(false)
	})

	it("the Listen button while held pauses the recording and never turns live audio off", async () => {
		const { listen, playback, liveAudio } = liveSetup()
		await listen.start()
		playback.play("a")
		await flush()
		await listen.toggle()
		expect(listen.get().wanted).toBe(true)
		expect(playback.get().phase).toBe("paused")
		expect(liveAudio.stop).not.toHaveBeenCalled()
		// not held: the button turns Listen off as before
		await listen.toggle()
		expect(listen.get().wanted).toBe(false)
	})

	it("a scanner Listen with audio already on pauses playback once the tune lands", async () => {
		const { listen, playback } = liveSetup()
		await listen.start()
		playback.play("a")
		await flush()
		expect(playback.get().phase).toBe("playing")
		expect(
			await listenAfterTune(161_000_000, () => Promise.resolve(true), listen),
		).toBe(true)
		expect(playback.get().phase).toBe("paused")
		expect(listen.isHeld).toBe(false)
		expect(listen.get().wanted).toBe(true)
	})

	it("Listen resume (a blocked autoplay) pauses playback too", async () => {
		const { listen, playback } = liveSetup()
		await listen.start()
		playback.play("a")
		await flush()
		listen.resume()
		expect(playback.get().phase).toBe("paused")
	})
})
