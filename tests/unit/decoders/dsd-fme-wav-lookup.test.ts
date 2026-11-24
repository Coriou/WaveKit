/**
 * dsd-fme per-call WAV lookup off the event loop (findWavFileAsync): async listings only (no
 * sync directory read), one attempt in flight per adapter however many calls end at once, and
 * at most DSD_FME_WAV_LIST_MAX_ENTRIES names examined per listing, each attempt abandoned after
 * DSD_FME_WAV_ATTEMPT_TIMEOUT_MS. A call's end waits (in order, at most DSD_FME_WAV_END_WAIT_MS)
 * for the first attempt and carries the file it finds. Synthetic names only.
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	DSD_FME_HELD_OUTPUTS_MAX,
	DSD_FME_WAV_ATTEMPT_TIMEOUT_MS,
	DSD_FME_WAV_END_WAIT_MS,
	DSD_FME_WAV_LIST_MAX_ENTRIES,
	DSD_FME_WAV_RETRIES,
	DSD_FME_WAV_RETRY_MS,
	DsdFmeDecoder,
} from "../../../src/decoders/builtin/dsd-fme.js"
import type { DecoderOutput } from "../../../src/decoders/types.js"
import { createDecoder } from "./dsd-fme-call-first-helpers.js"
import { settleWavLookups } from "./dsd-fme-wav-settle.js"

const START = new Date(2026, 0, 9, 10, 53, 27)
const pad = (n: number) => String(n).padStart(2, "0")
const STAMP = `${START.getFullYear()}${pad(START.getMonth() + 1)}${pad(START.getDate())}_${pad(START.getHours())}${pad(START.getMinutes())}${pad(START.getSeconds())}`
const fileOf = (tg: number) =>
	`${STAMP}_12345_DSTAR_CC_0_GROUP_TGT_${tg}_SRC_7.wav`

type Lookup = {
	findWavFileAsync(call: unknown, end: Date): void
}

/** A D-STAR call state as the adapter keeps it (no privacy field: known from the start). */
function callOf(tg: number) {
	return {
		callId: `c${tg}`,
		protocol: "dstar",
		talkgroup: tg,
		source: 7,
		startTime: START,
		startWallMs: START.getTime(),
		lastUpdate: START,
		quality: { crcErrs: 0, fecErrs: 0 },
		flags: {},
		encryptionKnown: true,
	}
}

let root = ""
beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "wk-dsd-lookup-"))
	vi.spyOn(
		DsdFmeDecoder.prototype as unknown as { recordingLinkable(): boolean },
		"recordingLinkable",
	).mockReturnValue(true)
})
afterEach(() => {
	vi.restoreAllMocks()
	fs.rmSync(root, { recursive: true, force: true })
})

function decoderWithUpdates() {
	const d = createDecoder({
		mode: "dstar",
		enablePerCallRecording: true,
		perCallRecordingDir: root,
		perCallRecordingPrune: false,
	})
	const found: string[] = []
	d.on("output", (o: DecoderOutput) => {
		const data = o.data as {
			wavFile?: string
			flags?: { wavFileUpdate?: boolean }
		}
		if (o.type === "call_end" && data.flags?.wavFileUpdate && data.wavFile)
			found.push(path.basename(data.wavFile))
	})
	return { d, found }
}

describe("dsd-fme WAV lookup", () => {
	it("runs one listing at a time when several calls end at once, and finds each file", async () => {
		const tgs = [11, 12, 13, 14, 15]
		for (const tg of tgs) fs.writeFileSync(path.join(root, fileOf(tg)), "")
		const real = fs.promises.opendir.bind(fs.promises)
		let inFlight = 0
		let peak = 0
		const opendir = vi
			.spyOn(fs.promises, "opendir")
			.mockImplementation(async (...args: Parameters<typeof real>) => {
				inFlight++
				peak = Math.max(peak, inFlight)
				// Hold the listing open across a few turns so an overlap would show.
				await new Promise(resolve => setImmediate(resolve))
				const dir = await real(...args)
				const iterate = dir[Symbol.asyncIterator].bind(dir)
				return Object.assign(dir, {
					[Symbol.asyncIterator]: async function* () {
						try {
							yield* iterate()
						} finally {
							inFlight--
						}
					},
				})
			})
		const { d, found } = decoderWithUpdates()
		const lookup = d as unknown as Lookup
		const end = new Date(START.getTime() + 2000)
		for (const tg of tgs) lookup.findWavFileAsync(callOf(tg), end)
		// Nothing was read synchronously: the lookups only queued.
		expect(opendir).not.toHaveBeenCalled()
		await settleWavLookups(d)
		expect(found).toEqual(tgs.map(fileOf))
		expect(peak).toBe(1)
		// The first directory holds every file: one listing per call.
		expect(opendir).toHaveBeenCalledTimes(tgs.length)
	})

	it("the adapter reads no directory synchronously", () => {
		const source = fs.readFileSync("src/decoders/builtin/dsd-fme.ts", "utf8")
		expect(source).not.toMatch(/\b(?:readdirSync|opendirSync|existsSync)\(/)
	})

	it("a missing directory is no match and no error", async () => {
		const { d, found } = decoderWithUpdates()
		fs.rmSync(root, { recursive: true, force: true })
		;(d as unknown as Lookup).findWavFileAsync(callOf(21), START)
		await settleWavLookups(d)
		expect(found).toEqual([])
	})

	/** A listing of `names` (the fs's order), through the adapter's opendir. */
	function listing(names: readonly string[]) {
		return vi.spyOn(fs.promises, "opendir").mockImplementation(
			async () =>
				({
					close: async () => undefined,
					[Symbol.asyncIterator]: async function* () {
						for (const name of names) yield { name }
					},
				}) as unknown as fs.Dir,
		)
	}

	it("finds a match at exactly DSD_FME_WAV_LIST_MAX_ENTRIES names examined", async () => {
		const names = Array.from(
			{ length: DSD_FME_WAV_LIST_MAX_ENTRIES - 1 },
			(_, i) => `other-${i}.wav`,
		)
		listing([...names, fileOf(31)])
		const { d, found } = decoderWithUpdates()
		;(d as unknown as Lookup).findWavFileAsync(callOf(31), START)
		await settleWavLookups(d)
		expect(found).toEqual([fileOf(31)])
	})

	it("stops one name past the bound (the match past it is not seen)", async () => {
		const names = Array.from(
			{ length: DSD_FME_WAV_LIST_MAX_ENTRIES },
			(_, i) => `other-${i}.wav`,
		)
		listing([...names, fileOf(32)])
		const { d, found } = decoderWithUpdates()
		;(d as unknown as Lookup).findWavFileAsync(callOf(32), START)
		await settleWavLookups(d)
		expect(found).toEqual([])
	})

	it("logs a truncated listing once per directory per adapter", async () => {
		const names = Array.from(
			{ length: DSD_FME_WAV_LIST_MAX_ENTRIES + 1 },
			(_, i) => `other-${i}.wav`,
		)
		listing(names)
		const { d } = decoderWithUpdates()
		const warn = vi.spyOn(
			(d as unknown as { logger: { warn(...a: unknown[]): void } }).logger,
			"warn",
		)
		const lookup = d as unknown as Lookup
		lookup.findWavFileAsync(callOf(33), START)
		lookup.findWavFileAsync(callOf(34), START)
		await settleWavLookups(d)
		const truncated = warn.mock.calls.filter(
			c => c[1] === "Recording directory listing truncated",
		)
		// Three directories searched per attempt, two calls: one line per directory.
		expect(truncated).toHaveLength(3)
	})
})

type EndInternals = {
	callState: unknown
	endCall(now: Date, timeout: boolean): DecoderOutput | null
	emitOutput(o: DecoderOutput): void
	outbox: unknown[]
}

/** Ends a D-STAR call through endCall and publishes it as the adapter does. */
function endThrough(d: DsdFmeDecoder, tg: number): DecoderOutput | null {
	const internals = d as unknown as EndInternals
	internals.callState = { ...callOf(tg), announced: true }
	const ended = internals.endCall(new Date(START.getTime() + 2000), false)
	if (ended) internals.emitOutput(ended)
	return ended
}

/** Every output in publication order, as type:talkgroup[:wav][:update]. */
function recorder(d: DsdFmeDecoder) {
	const seen: string[] = []
	d.on("output", (o: DecoderOutput) => {
		const data = o.data as {
			talkgroup?: number
			wavFile?: string
			flags?: { wavFileUpdate?: boolean }
		}
		seen.push(
			[
				o.type,
				String(data.talkgroup),
				...(data.wavFile ? [path.basename(data.wavFile)] : []),
				...(data.flags?.wavFileUpdate ? ["update"] : []),
			].join(":"),
		)
	})
	return seen
}

/** opendir that never settles (a stuck directory read). */
/**
 * opendir whose first read under this test's root stays pending until `release()` (it then
 * fails as a missing directory: no match); later reads are real.
 */
function heldOpendir() {
	const real = fs.promises.opendir.bind(fs.promises)
	let release = (): void => undefined
	let held = false
	const opendir = vi
		.spyOn(fs.promises, "opendir")
		.mockImplementation((dir, options) => {
			if (held || !String(dir).startsWith(root)) return real(dir, options)
			held = true
			return new Promise<fs.Dir>((_resolve, reject) => {
				release = () =>
					reject(Object.assign(new Error("gone"), { code: "ENOENT" }))
			})
		})
	return { opendir, release: () => release() }
}

/** The opendir calls under this test's root (an earlier test's real-timer retry may reach the spy). */
function ours(opendir: { mock: { calls: unknown[][] } }): unknown[][] {
	return opendir.mock.calls.filter(([dir]) => String(dir).startsWith(root))
}

/** Lets real I/O run (setImmediate turns; fake time does not move) until `done`, at most 500 turns. */
async function untilReal(done: () => boolean): Promise<void> {
	for (let i = 0; i < 500 && !done(); i++)
		await new Promise(resolve => setImmediate(resolve))
	expect(done()).toBe(true)
}

type StuckInternals = {
	stuckWavListing: { waiters: Set<unknown> } | null
}

/** A rejection as a missing directory reads (no match, no error). */
const missingDir = (): Promise<fs.Dir> =>
	Promise.reject(Object.assign(new Error("gone"), { code: "ENOENT" }))

/**
 * opendir whose first `n` reads of this test's root itself stay pending until `release(i)` (each
 * then fails as a missing directory: no match); later reads of the root are real. Its
 * subdirectories' reads are real too, or with `missingSubdirs` fail at once as missing (no real
 * I/O: the test's turns, not the machine's load, decide when they settle).
 */
function heldReads(n: number, opts: { missingSubdirs?: boolean } = {}) {
	const real = fs.promises.opendir.bind(fs.promises)
	const releases: (() => void)[] = []
	const opendir = vi
		.spyOn(fs.promises, "opendir")
		.mockImplementation((dir, options) => {
			if (
				opts.missingSubdirs === true &&
				String(dir) !== root &&
				String(dir).startsWith(root)
			)
				return missingDir()
			if (releases.length >= n || String(dir) !== root)
				return real(dir, options)
			return new Promise<fs.Dir>((_resolve, reject) => {
				releases.push(() =>
					reject(Object.assign(new Error("gone"), { code: "ENOENT" })),
				)
			})
		})
	return { opendir, release: (i: number) => releases[i]?.() }
}

function stuckOpendir() {
	return vi
		.spyOn(fs.promises, "opendir")
		.mockImplementation(() => new Promise<fs.Dir>(() => undefined))
}

describe("dsd-fme call_end held for its first lookup", () => {
	afterEach(() => {
		vi.useRealTimers()
	})

	it("the call_end itself carries a file that exists at its end, with no update", async () => {
		fs.writeFileSync(path.join(root, fileOf(41)), "")
		const { d } = decoderWithUpdates()
		const seen = recorder(d)
		endThrough(d, 41)
		// Held: nothing is published before the first attempt.
		expect(seen).toEqual([])
		await settleWavLookups(d)
		expect(seen).toEqual([`call_end:41:${fileOf(41)}`])
	})

	it("a later call's events never overtake an earlier held end", async () => {
		fs.writeFileSync(path.join(root, fileOf(42)), "")
		const { d } = decoderWithUpdates()
		const seen = recorder(d)
		const internals = d as unknown as EndInternals
		const voice: string[] = []
		d.on("voice-call", (v: { callId: string; active: boolean }) =>
			voice.push(`${v.callId}:${v.active}`),
		)
		endThrough(d, 42)
		internals.emitOutput({
			timestamp: START,
			decoder: "dsd-fme",
			type: "call_start",
			data: { callId: "next", talkgroup: 43, flags: {} },
		})
		expect(seen).toEqual([])
		// The voice-call halves never wait: in production order, in the tick they were produced.
		expect(voice).toEqual(["c42:false", "next:true"])
		await settleWavLookups(d)
		expect(seen).toEqual([`call_end:42:${fileOf(42)}`, "call_start:43"])
		expect(voice).toEqual(["c42:false", "next:true"])
	})

	it("a stuck read releases the end without its file at DSD_FME_WAV_END_WAIT_MS, not before", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		stuckOpendir()
		const { d } = decoderWithUpdates()
		const seen = recorder(d)
		endThrough(d, 44)
		await vi.advanceTimersByTimeAsync(DSD_FME_WAV_END_WAIT_MS - 1)
		expect(seen).toEqual([])
		await vi.advanceTimersByTimeAsync(1)
		expect(seen).toEqual(["call_end:44"])
	})

	it("a stuck read is abandoned at DSD_FME_WAV_ATTEMPT_TIMEOUT_MS so the chain moves on, not before", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		const { opendir, release } = heldOpendir()
		const { d, found } = decoderWithUpdates()
		const seenEnds = recorder(d)
		let ended = false
		d.on("output", (o: DecoderOutput) => {
			if (o.type === "call_end") ended = true
		})
		endThrough(d, 45)
		await vi.advanceTimersByTimeAsync(DSD_FME_WAV_ATTEMPT_TIMEOUT_MS - 1)
		// Only the first directory's read started, and it has not settled.
		expect(ours(opendir)).toHaveLength(1)
		// The end went out at its own deadline, long before.
		expect(ended).toBe(true)
		await vi.advanceTimersByTimeAsync(1)
		// Abandoned while its read is still stuck: the call's retries are skipped, the chain is
		// free for the next call at once, and its first attempt waits for the one stuck read.
		fs.writeFileSync(path.join(root, fileOf(46)), "")
		await vi.advanceTimersByTimeAsync(DSD_FME_WAV_RETRY_MS)
		endThrough(d, 46)
		release()
		await vi.advanceTimersByTimeAsync(0)
		await settleWavLookups(d)
		// The next call's first attempt read once the stuck read settled; call 45 never retried.
		expect(found).toEqual([])
		expect(seenEnds).toContain(`call_end:46:${fileOf(46)}`)
	})

	it("single flight: while an abandoned read is pending, no attempt starts another", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		const { opendir, release } = heldOpendir()
		const { d, found } = decoderWithUpdates()
		endThrough(d, 48)
		// Past a whole retry chain's time (its retries are skipped: the read is still stuck).
		const chainMs =
			(1 + DSD_FME_WAV_RETRIES) *
			(DSD_FME_WAV_ATTEMPT_TIMEOUT_MS + DSD_FME_WAV_RETRY_MS)
		await vi.advanceTimersByTimeAsync(chainMs)
		// One read ever started, however many attempts timed out behind it.
		expect(ours(opendir)).toHaveLength(1)
		expect(found).toEqual([])
		// A later call's lookup waits for it too: still one read.
		endThrough(d, 49)
		await vi.advanceTimersByTimeAsync(DSD_FME_WAV_ATTEMPT_TIMEOUT_MS - 1)
		expect(ours(opendir)).toHaveLength(1)
		// The stuck read settles: the waiting attempt reads (a second listing), and only then.
		fs.writeFileSync(path.join(root, fileOf(49)), "")
		release()
		await vi.advanceTimersByTimeAsync(0)
		await settleWavLookups(d)
		expect(ours(opendir).length).toBeGreaterThan(1)
		expect(found).toEqual([fileOf(49)])
	})

	it("single flight: a read that never settles holds two waiters at most (the chain's attempt and one retry's one wait), however many attempts give up on it", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		const opendir = stuckOpendir()
		const { d } = decoderWithUpdates()
		const internals = d as unknown as StuckInternals
		const calls = [50, 51, 52, 53]
		for (const tg of calls) endThrough(d, tg)
		// Every call's whole chain times out behind the one stuck read.
		const chainMs =
			(1 + DSD_FME_WAV_RETRIES) *
			(DSD_FME_WAV_ATTEMPT_TIMEOUT_MS + DSD_FME_WAV_RETRY_MS)
		let peak = 0
		for (let t = 0; t < calls.length * chainMs; t += 100) {
			await vi.advanceTimersByTimeAsync(100)
			peak = Math.max(peak, internals.stuckWavListing?.waiters.size ?? 0)
		}
		expect(ours(opendir)).toHaveLength(1)
		expect(internals.stuckWavListing).not.toBeNull()
		// One chain attempt waits at a time, beside at most one retry's wait (call k's attempt holds
		// the chain from 2k s to 2k + 2 s, its retry waits from 2k + 2.2 s to 2k + 4.2 s: the next
		// call's attempt overlaps it, the one after does not); every waiter that gave up left.
		expect(peak).toBe(2)
		expect(internals.stuckWavListing!.waiters.size).toBe(0)
	})

	it("single flight: once the stuck read settles, the fresh search gets its own full DSD_FME_WAV_ATTEMPT_TIMEOUT_MS", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		// The subdirectories fail at once as missing: no real I/O races the frozen fake clock.
		const reads = heldReads(2, { missingSubdirs: true })
		const { d } = decoderWithUpdates()
		const internals = d as unknown as StuckInternals
		endThrough(d, 54)
		// The first attempt's read is abandoned (its retry waits for it once); the next call's
		// first attempt waits for it.
		await vi.advanceTimersByTimeAsync(DSD_FME_WAV_ATTEMPT_TIMEOUT_MS)
		endThrough(d, 57)
		await vi.advanceTimersByTimeAsync(DSD_FME_WAV_RETRY_MS)
		const first = internals.stuckWavListing
		expect(first).not.toBeNull()
		// The next call's attempt, and the first call's retry waiting for the read once.
		expect(first!.waiters.size).toBe(2)
		// The stuck read settles late in the waiting attempt's budget (it began waiting
		// DSD_FME_WAV_RETRY_MS ago); its fresh read sticks too.
		await vi.advanceTimersByTimeAsync(
			DSD_FME_WAV_ATTEMPT_TIMEOUT_MS - DSD_FME_WAV_RETRY_MS - 100,
		)
		reads.release(0)
		// The old search's reads of the subdirectories settle (fake time stands still).
		await untilReal(() => internals.stuckWavListing === null)
		await untilReal(
			() => ours(reads.opendir).filter(([dir]) => dir === root).length === 2,
		)
		expect(internals.stuckWavListing).toBeNull()
		// Not abandoned at the waiting attempt's deadline (100 ms on), only a full budget later.
		await vi.advanceTimersByTimeAsync(DSD_FME_WAV_ATTEMPT_TIMEOUT_MS - 1)
		expect(internals.stuckWavListing).toBeNull()
		await vi.advanceTimersByTimeAsync(1)
		expect(internals.stuckWavListing).not.toBeNull()
		expect(internals.stuckWavListing).not.toBe(first)
		reads.release(1)
		await vi.advanceTimersByTimeAsync(0)
		await settleWavLookups(d)
	})

	it("a new run keeps an old run's stuck read: its waiting attempt reads nothing and the next lookup starts no second listing until it settles", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		const reads = heldReads(1)
		const { d } = decoderWithUpdates()
		const seen = recorder(d)
		const internals = d as unknown as StuckInternals & {
			callTimeoutTimer: ReturnType<typeof setInterval> | null
		}
		const rootReads = (): number =>
			ours(reads.opendir).filter(([dir]) => dir === root).length
		endThrough(d, 55)
		// Its read is abandoned (its retry waits for it once); a second old-run call's attempt waits
		// on it.
		await vi.advanceTimersByTimeAsync(DSD_FME_WAV_ATTEMPT_TIMEOUT_MS)
		endThrough(d, 58)
		await vi.advanceTimersByTimeAsync(DSD_FME_WAV_RETRY_MS)
		const old = internals.stuckWavListing
		// The second call's attempt, and the first call's retry waiting for the read once.
		expect(old!.waiters.size).toBe(2)
		// A new run: the base start (the child's spawn) is stubbed out.
		vi.spyOn(
			Object.getPrototypeOf(DsdFmeDecoder.prototype) as {
				start(): Promise<void>
			},
			"start",
		).mockResolvedValue(undefined)
		await d.start()
		if (internals.callTimeoutTimer) clearInterval(internals.callTimeoutTimer)
		internals.callTimeoutTimer = null
		// The old run's waiter gave up; the read still holds a libuv thread, so it stays recorded.
		expect(old!.waiters.size).toBe(0)
		expect(internals.stuckWavListing).toBe(old)
		expect(rootReads()).toBe(1)
		// A new call's lookup waits for the one stuck read: no second listing beside it.
		fs.writeFileSync(path.join(root, fileOf(56)), "")
		endThrough(d, 56)
		await vi.advanceTimersByTimeAsync(DSD_FME_WAV_ATTEMPT_TIMEOUT_MS - 100)
		expect(rootReads()).toBe(1)
		expect(internals.stuckWavListing).toBe(old)
		expect(old!.waiters.size).toBe(1)
		// The stuck read settles: the waiting attempt reads now, and finds the file.
		reads.release(0)
		await untilReal(() => rootReads() === 2)
		await untilReal(() =>
			seen.some(e => e.startsWith(`call_end:56:${fileOf(56)}`)),
		)
		expect(internals.stuckWavListing).toBeNull()
		// Free again: the new call's retries (if any) read one at a time, real reads; the old
		// calls schedule none in the new run.
		await settleWavLookups(d)
	})

	it("while the same listing stays stuck, each call costs the chain one attempt, never its retries (a read that never settles)", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		const opendir = stuckOpendir()
		const { d } = decoderWithUpdates()
		const internals = d as unknown as StuckInternals
		const debug = vi.spyOn(
			(d as unknown as { logger: { debug(...a: unknown[]): void } }).logger,
			"debug",
		)
		const skipped = (): number =>
			debug.mock.calls.filter(
				c => c[1] === "WAV file lookup ended early, retries skipped",
			).length
		endThrough(d, 60)
		endThrough(d, 61)
		// Call 60's attempt is abandoned at the timeout (its retry is scheduled); call 61's then
		// waits a full timeout on the stuck read.
		await vi.advanceTimersByTimeAsync(DSD_FME_WAV_ATTEMPT_TIMEOUT_MS)
		expect(skipped()).toBe(0)
		expect(internals.stuckWavListing!.waiters.size).toBe(1)
		// Call 60's retry is due with the same read stuck: it waits for it once, outside the
		// chain, beside call 61's attempt.
		await vi.advanceTimersByTimeAsync(DSD_FME_WAV_RETRY_MS)
		expect(internals.stuckWavListing!.waiters.size).toBe(2)
		// Call 61's attempt times out at 4 000 ms; call 60's wait at 4 200 ms (2 000 + 200 +
		// 2 000): still stuck, its lookup ends unread.
		await vi.advanceTimersByTimeAsync(DSD_FME_WAV_ATTEMPT_TIMEOUT_MS - 1)
		expect(skipped()).toBe(0)
		await vi.advanceTimersByTimeAsync(1)
		expect(skipped()).toBe(1)
		// Call 61's retry waits once too, from 4 200 ms, and ends at 6 200 ms.
		expect(internals.stuckWavListing!.waiters.size).toBe(1)
		await vi.advanceTimersByTimeAsync(DSD_FME_WAV_ATTEMPT_TIMEOUT_MS - 1)
		expect(skipped()).toBe(1)
		await vi.advanceTimersByTimeAsync(1)
		expect(skipped()).toBe(2)
		expect(internals.stuckWavListing!.waiters.size).toBe(0)
		// Both lookups are over: nothing waits on the read over a whole retry chain's time.
		const chainMs =
			(1 + DSD_FME_WAV_RETRIES) *
			(DSD_FME_WAV_ATTEMPT_TIMEOUT_MS + DSD_FME_WAV_RETRY_MS)
		for (let t = 0; t < chainMs; t += 100) {
			await vi.advanceTimersByTimeAsync(100)
			expect(internals.stuckWavListing!.waiters.size).toBe(0)
		}
		// No backlog: a call ending now starts its attempt at once (it waits on the read), and its
		// lookup is over 4 200 ms later.
		endThrough(d, 62)
		await vi.advanceTimersByTimeAsync(0)
		expect(internals.stuckWavListing!.waiters.size).toBe(1)
		await vi.advanceTimersByTimeAsync(
			2 * DSD_FME_WAV_ATTEMPT_TIMEOUT_MS + DSD_FME_WAV_RETRY_MS - 1,
		)
		expect(skipped()).toBe(2)
		await vi.advanceTimersByTimeAsync(1)
		expect(skipped()).toBe(3)
		expect(internals.stuckWavListing!.waiters.size).toBe(0)
		expect(ours(opendir)).toHaveLength(1)
	})

	it("a merely slow read (it settles after the timeout, before the retry runs): the retry reads and finds the file", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		const reads = heldReads(1)
		const { d, found } = decoderWithUpdates()
		const internals = d as unknown as StuckInternals
		endThrough(d, 70)
		await vi.advanceTimersByTimeAsync(DSD_FME_WAV_ATTEMPT_TIMEOUT_MS)
		expect(internals.stuckWavListing).not.toBeNull()
		// The file is renamed into place and the slow read settles, both before the retry runs.
		fs.writeFileSync(path.join(root, fileOf(70)), "")
		await vi.advanceTimersByTimeAsync(DSD_FME_WAV_RETRY_MS - 100)
		reads.release(0)
		await untilReal(() => internals.stuckWavListing === null)
		await vi.advanceTimersByTimeAsync(100)
		await settleWavLookups(d)
		expect(found).toEqual([fileOf(70)])
	})

	it("a slow read that settles at 2.3 s, after the retry began waiting for it: the retry reads and finds the file", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		const reads = heldReads(1)
		const { d, found } = decoderWithUpdates()
		const internals = d as unknown as StuckInternals
		endThrough(d, 71)
		fs.writeFileSync(path.join(root, fileOf(71)), "")
		// 2 300 ms: the retry (due at 2 200 ms) is waiting on the read.
		await vi.advanceTimersByTimeAsync(
			DSD_FME_WAV_ATTEMPT_TIMEOUT_MS + DSD_FME_WAV_RETRY_MS + 100,
		)
		expect(internals.stuckWavListing!.waiters.size).toBe(1)
		reads.release(0)
		await untilReal(() => internals.stuckWavListing === null)
		await settleWavLookups(d)
		await untilReal(() => found.length === 1)
		expect(found).toEqual([fileOf(71)])
		expect(ours(reads.opendir).filter(([dir]) => dir === root)).toHaveLength(2)
	})

	it("a read that settles only after the retry's one wait: the lookup ends at 4 200 ms (the hung-mount bound)", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		const reads = heldReads(1)
		const { d, found } = decoderWithUpdates()
		const internals = d as unknown as StuckInternals
		endThrough(d, 74)
		fs.writeFileSync(path.join(root, fileOf(74)), "")
		await vi.advanceTimersByTimeAsync(
			2 * DSD_FME_WAV_ATTEMPT_TIMEOUT_MS + DSD_FME_WAV_RETRY_MS,
		)
		expect(internals.stuckWavListing!.waiters.size).toBe(0)
		reads.release(0)
		await untilReal(() => internals.stuckWavListing === null)
		const chainMs =
			(1 + DSD_FME_WAV_RETRIES) *
			(DSD_FME_WAV_ATTEMPT_TIMEOUT_MS + DSD_FME_WAV_RETRY_MS)
		await vi.advanceTimersByTimeAsync(chainMs)
		await settleWavLookups(d)
		expect(ours(reads.opendir).filter(([dir]) => dir === root)).toHaveLength(1)
		expect(found).toEqual([])
	})

	it("a lookup whose first attempt was only queued when start() began a new run reads once and retries nothing", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		const reads = heldReads(1)
		const { d, found } = decoderWithUpdates()
		const internals = d as unknown as StuckInternals & {
			callTimeoutTimer: ReturnType<typeof setInterval> | null
		}
		const rootReads = (): number =>
			ours(reads.opendir).filter(([dir]) => dir === root).length
		// Call 72's attempt holds the chain in a slow read; call 73's first attempt is queued.
		endThrough(d, 72)
		endThrough(d, 73)
		await vi.advanceTimersByTimeAsync(0)
		expect(rootReads()).toBe(1)
		vi.spyOn(
			Object.getPrototypeOf(DsdFmeDecoder.prototype) as {
				start(): Promise<void>
			},
			"start",
		).mockResolvedValue(undefined)
		await d.start()
		if (internals.callTimeoutTimer) clearInterval(internals.callTimeoutTimer)
		internals.callTimeoutTimer = null
		// The slow read settles: call 72 finds nothing and schedules no retry; call 73's first
		// attempt reads once (nothing yet) and, from the old run, schedules none either.
		reads.release(0)
		await untilReal(() => rootReads() === 2)
		await settleWavLookups(d)
		fs.writeFileSync(path.join(root, fileOf(72)), "")
		fs.writeFileSync(path.join(root, fileOf(73)), "")
		const chainMs =
			(1 + DSD_FME_WAV_RETRIES) *
			(DSD_FME_WAV_ATTEMPT_TIMEOUT_MS + DSD_FME_WAV_RETRY_MS)
		await vi.advanceTimersByTimeAsync(chainMs)
		await settleWavLookups(d)
		expect(rootReads()).toBe(2)
		expect(found).toEqual([])
	})

	describe("a DMR lookup releases its clearance exactly once on every early end", () => {
		/** A DMR call's lookup started directly, and the clearance releases for it. */
		const dmrLookup = (d: DsdFmeDecoder, tg: number) => {
			const clearance = (
				d as unknown as { dmrClearance: { ended(id: string): void } }
			).dmrClearance
			const ended = vi.spyOn(clearance, "ended")
			;(d as unknown as Lookup).findWavFileAsync(
				{ ...callOf(tg), protocol: "dmr" },
				START,
			)
			return () => ended.mock.calls.filter(([id]) => id === `c${tg}`).length
		}
		const restart = async (d: DsdFmeDecoder) => {
			const internals = d as unknown as {
				callTimeoutTimer: ReturnType<typeof setInterval> | null
			}
			vi.spyOn(
				Object.getPrototypeOf(DsdFmeDecoder.prototype) as {
					start(): Promise<void>
				},
				"start",
			).mockResolvedValue(undefined)
			await d.start()
			if (internals.callTimeoutTimer) clearInterval(internals.callTimeoutTimer)
			internals.callTimeoutTimer = null
		}
		const chainMs =
			(1 + DSD_FME_WAV_RETRIES) *
			(DSD_FME_WAV_ATTEMPT_TIMEOUT_MS + DSD_FME_WAV_RETRY_MS)

		it("the retry finds the same read still stuck after its one wait", async () => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
			stuckOpendir()
			const { d } = decoderWithUpdates()
			const released = dmrLookup(d, 80)
			// The attempt times out at 2 000 ms, the retry waits once from 2 200 ms to 4 200 ms.
			await vi.advanceTimersByTimeAsync(
				2 * DSD_FME_WAV_ATTEMPT_TIMEOUT_MS + DSD_FME_WAV_RETRY_MS - 1,
			)
			expect(released()).toBe(0)
			await vi.advanceTimersByTimeAsync(1)
			expect(released()).toBe(1)
			await vi.advanceTimersByTimeAsync(chainMs)
			expect(released()).toBe(1)
		})

		it("a retry the old run scheduled runs in a new run", async () => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
			const { d } = decoderWithUpdates()
			const released = dmrLookup(d, 81)
			await settleWavLookups(d)
			expect(released()).toBe(0)
			await restart(d)
			await vi.advanceTimersByTimeAsync(DSD_FME_WAV_RETRY_MS)
			await settleWavLookups(d)
			expect(released()).toBe(1)
			await vi.advanceTimersByTimeAsync(chainMs)
			await settleWavLookups(d)
			expect(released()).toBe(1)
		})

		it("an attempt that ends in a new run schedules no retry", async () => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
			const reads = heldReads(1)
			const { d } = decoderWithUpdates()
			const released = dmrLookup(d, 82)
			await vi.advanceTimersByTimeAsync(0)
			await restart(d)
			reads.release(0)
			await untilReal(() => released() === 1)
			await vi.advanceTimersByTimeAsync(chainMs)
			await settleWavLookups(d)
			expect(released()).toBe(1)
		})
	})

	it("a found-nothing attempt still retries while no listing is stuck", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		const { d, found } = decoderWithUpdates()
		endThrough(d, 63)
		await settleWavLookups(d)
		// The file appears after the first attempt: a retry finds it (an update).
		fs.writeFileSync(path.join(root, fileOf(63)), "")
		await vi.advanceTimersByTimeAsync(DSD_FME_WAV_RETRY_MS)
		await settleWavLookups(d)
		expect(found).toEqual([fileOf(63)])
	})

	it("an old run's attempt that wakes after start() schedules no retry in the new run", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		const reads = heldReads(1)
		const { d, found } = decoderWithUpdates()
		const internals = d as unknown as StuckInternals & {
			callTimeoutTimer: ReturnType<typeof setInterval> | null
		}
		const rootReads = (): number =>
			ours(reads.opendir).filter(([dir]) => dir === root).length
		endThrough(d, 64)
		await vi.advanceTimersByTimeAsync(DSD_FME_WAV_ATTEMPT_TIMEOUT_MS)
		// The old run's second call waits on the stuck read.
		endThrough(d, 65)
		await vi.advanceTimersByTimeAsync(0)
		const old = internals.stuckWavListing
		expect(old!.waiters.size).toBe(1)
		vi.spyOn(
			Object.getPrototypeOf(DsdFmeDecoder.prototype) as {
				start(): Promise<void>
			},
			"start",
		).mockResolvedValue(undefined)
		await d.start()
		if (internals.callTimeoutTimer) clearInterval(internals.callTimeoutTimer)
		internals.callTimeoutTimer = null
		// Woken by the start, it read nothing; once the read settles the listing is free, yet the
		// old call schedules no retry in the new run, so its file is never looked up again.
		expect(old!.waiters.size).toBe(0)
		fs.writeFileSync(path.join(root, fileOf(65)), "")
		reads.release(0)
		await untilReal(() => internals.stuckWavListing === null)
		const before = rootReads()
		const chainMs =
			(1 + DSD_FME_WAV_RETRIES) *
			(DSD_FME_WAV_ATTEMPT_TIMEOUT_MS + DSD_FME_WAV_RETRY_MS)
		await vi.advanceTimersByTimeAsync(chainMs)
		await settleWavLookups(d)
		expect(rootReads()).toBe(before)
		expect(found).toEqual([])
	})

	it("a retry an old run scheduled reads nothing in the new run", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		const opendir = vi.spyOn(fs.promises, "opendir")
		const { d, found } = decoderWithUpdates()
		const internals = d as unknown as {
			callTimeoutTimer: ReturnType<typeof setInterval> | null
		}
		const rootReads = (): number =>
			ours(opendir).filter(([dir]) => dir === root).length
		endThrough(d, 66)
		// The first attempt found nothing (an empty folder): a retry is scheduled.
		await settleWavLookups(d)
		expect(rootReads()).toBe(1)
		vi.spyOn(
			Object.getPrototypeOf(DsdFmeDecoder.prototype) as {
				start(): Promise<void>
			},
			"start",
		).mockResolvedValue(undefined)
		await d.start()
		if (internals.callTimeoutTimer) clearInterval(internals.callTimeoutTimer)
		internals.callTimeoutTimer = null
		fs.writeFileSync(path.join(root, fileOf(66)), "")
		await vi.advanceTimersByTimeAsync(
			DSD_FME_WAV_RETRIES * DSD_FME_WAV_RETRY_MS,
		)
		await settleWavLookups(d)
		expect(rootReads()).toBe(1)
		expect(found).toEqual([])
	})

	it("holds DSD_FME_HELD_OUTPUTS_MAX outputs behind a waiting end, and releases it one past", () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		stuckOpendir()
		const { d } = decoderWithUpdates()
		const seen = recorder(d)
		const internals = d as unknown as EndInternals
		endThrough(d, 46)
		const other = (i: number): DecoderOutput => ({
			timestamp: START,
			decoder: "dsd-fme",
			type: "message",
			data: { i },
		})
		// The end plus MAX - 1 others: exactly the bound.
		for (let i = 0; i < DSD_FME_HELD_OUTPUTS_MAX - 1; i++)
			internals.emitOutput(other(i))
		expect(internals.outbox).toHaveLength(DSD_FME_HELD_OUTPUTS_MAX)
		expect(seen).toEqual([])
		internals.emitOutput(other(DSD_FME_HELD_OUTPUTS_MAX))
		expect(internals.outbox).toHaveLength(0)
		expect(seen[0]).toBe("call_end:46")
		expect(seen).toHaveLength(DSD_FME_HELD_OUTPUTS_MAX + 1)
	})

	it("stop publishes the ends it produces, with their files, before it returns", async () => {
		fs.writeFileSync(path.join(root, fileOf(47)), "")
		const { d } = decoderWithUpdates()
		const seen = recorder(d)
		;(d as unknown as EndInternals).callState = {
			...callOf(47),
			announced: true,
		}
		await d.stop()
		expect(seen).toEqual([
			expect.stringMatching(new RegExp(`^call_end:47:${fileOf(47)}`)),
		])
	})
})

type StopInternals = EndInternals & {
	pendingCall: unknown
	handleOutputLine(line: string): void
	markSettled(end: unknown): void
	settleEnd(end: unknown, wavFile: string | undefined): boolean
}

/**
 * Every timer a lookup chain could still arm (each attempt's timeout, each retry) fired, with the
 * real directory reads between them completing (setImmediate is not faked).
 */
async function runOutLookups(d: DsdFmeDecoder): Promise<void> {
	// A whole chain: 1 + DSD_FME_WAV_RETRIES attempts, each at most its timeout plus the retry gap.
	const chainMs =
		(1 + DSD_FME_WAV_RETRIES) *
		(DSD_FME_WAV_ATTEMPT_TIMEOUT_MS + DSD_FME_WAV_RETRY_MS)
	const turns = async (n: number): Promise<void> => {
		for (let i = 0; i < n; i++)
			await new Promise(resolve => setImmediate(resolve))
	}
	for (let ms = 0; ms <= chainMs; ms += DSD_FME_WAV_RETRY_MS) {
		await vi.advanceTimersByTimeAsync(DSD_FME_WAV_RETRY_MS)
		// Small steps, so a real read finishes before its attempt's timeout fires.
		await Promise.race([settleWavLookups(d), turns(50)])
	}
}

describe("dsd-fme stop with held ends", () => {
	afterEach(() => {
		vi.useRealTimers()
	})

	it("parses no line while stop drains: a call opened then would never end", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		stuckOpendir()
		const { d } = decoderWithUpdates()
		const seen = recorder(d)
		const internals = d as unknown as StopInternals
		internals.callState = { ...callOf(61), announced: true }
		const stopped = d.stop()
		// The child still prints while it exits: D-STAR voice syncs that would open a call.
		for (let i = 0; i < 4; i++)
			internals.handleOutputLine("03:04:05 Sync: +DSTAR VOICE ")
		await vi.advanceTimersByTimeAsync(DSD_FME_WAV_END_WAIT_MS)
		await stopped
		expect(internals.callState).toBeNull()
		expect(internals.pendingCall).toBeNull()
		expect(seen).toEqual(["call_end:61"])
	})

	it("a privacy print the child prints while stop drains marks the call stop ended (fail closed)", async () => {
		// The real admission rule: a P25 call is linkable on its own clear print only.
		vi.restoreAllMocks()
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		const { release } = heldOpendir()
		const { d, found } = decoderWithUpdates()
		const ends: {
			flags?: { encrypted?: boolean }
			clearEvidence?: boolean
			wavFile?: string
		}[] = []
		d.on("output", (o: DecoderOutput) => {
			if (o.type === "call_end") ends.push(o.data as (typeof ends)[number])
		})
		const internals = d as unknown as StopInternals
		internals.callState = {
			...callOf(64),
			protocol: "p25p1",
			clearEvidence: true,
			flags: { encrypted: false },
			announced: true,
		}
		const stopped = d.stop()
		// Held for its lookup: a late line still reaches the call stop() ended.
		expect(ends).toEqual([])
		internals.handleOutputLine("03:04:05 Group Call Encrypted ")
		await vi.advanceTimersByTimeAsync(DSD_FME_WAV_END_WAIT_MS)
		await stopped
		expect(ends).toHaveLength(1)
		expect(ends[0]?.flags?.encrypted).toBe(true)
		expect(ends[0]?.clearEvidence).toBeUndefined()
		expect(ends[0]?.wavFile).toBeUndefined()
		// The file the child finalises at exit is never linked afterwards.
		fs.writeFileSync(
			path.join(root, `${STAMP}_12345_P25_CC_0_GROUP_TGT_64_SRC_7.wav`),
			"",
		)
		release()
		await runOutLookups(d)
		expect(found).toEqual([])
		// And no call opened from the late line.
		expect(internals.callState).toBeNull()
	})

	it("a late line without a privacy print leaves the call stop ended clear", async () => {
		vi.restoreAllMocks()
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		stuckOpendir()
		const { d } = decoderWithUpdates()
		const ends: { flags?: { encrypted?: boolean }; clearEvidence?: boolean }[] =
			[]
		d.on("output", (o: DecoderOutput) => {
			if (o.type === "call_end") ends.push(o.data as (typeof ends)[number])
		})
		const internals = d as unknown as StopInternals
		internals.callState = {
			...callOf(65),
			protocol: "p25p1",
			clearEvidence: true,
			flags: { encrypted: false },
			announced: true,
		}
		const stopped = d.stop()
		internals.handleOutputLine(
			"03:04:05 Group Call ALG ID: 0x80 KEY ID: 0x0000 ",
		)
		await vi.advanceTimersByTimeAsync(DSD_FME_WAV_END_WAIT_MS)
		await stopped
		expect(ends[0]?.flags?.encrypted).toBe(false)
		expect(ends[0]?.clearEvidence).toBe(true)
	})

	it("waits only for the ends queued when the drain began, at most DSD_FME_WAV_END_WAIT_MS", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		stuckOpendir()
		const { d } = decoderWithUpdates()
		const seen = recorder(d)
		const internals = d as unknown as StopInternals
		internals.callState = { ...callOf(62), announced: true }
		let done = false
		const stopped = d.stop().then(() => {
			done = true
		})
		await vi.advanceTimersByTimeAsync(DSD_FME_WAV_END_WAIT_MS / 2)
		// An end queued after the drain began (its own deadline 250 ms past the first's).
		endThrough(d, 63)
		await vi.advanceTimersByTimeAsync(DSD_FME_WAV_END_WAIT_MS / 2 - 1)
		expect(done).toBe(false)
		await vi.advanceTimersByTimeAsync(1)
		await stopped
		expect(done).toBe(true)
		// The later end went out at the drain's end, not at its own deadline, and none is held.
		expect(seen).toEqual(["call_end:62", "call_end:63"])
		expect(internals.outbox).toHaveLength(0)
	})

	it("still reports, once, a file the child finalised at exit: the post-stop update is bounded", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		const { d, found } = decoderWithUpdates()
		endThrough(d, 66)
		// The first attempt finds nothing and schedules a retry.
		await settleWavLookups(d)
		await d.stop()
		// dsd-fme writes the stopped call's file as its child exits (inside super.stop()).
		fs.writeFileSync(path.join(root, fileOf(66)), "")
		await runOutLookups(d)
		expect(found).toEqual([fileOf(66)])
	})

	/** restart() as the base runs it (stop() then start()), the child's spawn stubbed out. */
	const restartedAfterStop = async (d: DsdFmeDecoder): Promise<void> => {
		vi.spyOn(
			Object.getPrototypeOf(DsdFmeDecoder.prototype) as {
				start(): Promise<void>
			},
			"start",
		).mockResolvedValue(undefined)
		await d.start()
		const internals = d as unknown as {
			callTimeoutTimer: ReturnType<typeof setInterval> | null
		}
		if (internals.callTimeoutTimer) clearInterval(internals.callTimeoutTimer)
		internals.callTimeoutTimer = null
	}

	it("a restart (stop() then start()) still links, once, a file the child finalised at exit", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		const { d, found } = decoderWithUpdates()
		endThrough(d, 66)
		await settleWavLookups(d)
		await d.stop()
		fs.writeFileSync(path.join(root, fileOf(66)), "")
		await restartedAfterStop(d)
		await runOutLookups(d)
		expect(found).toEqual([fileOf(66)])
	})

	it("a restart still links, once, the file of a call stop() itself ended", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		const { d, found } = decoderWithUpdates()
		const internals = d as unknown as StopInternals
		internals.callState = { ...callOf(69), announced: true }
		const stopped = d.stop()
		await vi.advanceTimersByTimeAsync(DSD_FME_WAV_END_WAIT_MS)
		await stopped
		fs.writeFileSync(path.join(root, fileOf(69)), "")
		await restartedAfterStop(d)
		await runOutLookups(d)
		expect(found).toEqual([fileOf(69)])
	})

	it("logs a held end as published: a file set after its deadline but before release counts", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		stuckOpendir()
		const { d } = decoderWithUpdates()
		const seen = recorder(d)
		const internals = d as unknown as StopInternals
		const info = vi.spyOn(
			(d as unknown as { logger: { info(...a: unknown[]): void } }).logger,
			"info",
		)
		endThrough(d, 67)
		endThrough(d, 68)
		const held = internals.outbox as { end?: unknown }[]
		const firstEnd = held[0]?.end
		const secondEnd = held[1]?.end
		expect(firstEnd).toBeDefined()
		expect(secondEnd).toBeDefined()
		// The second's deadline settled it without a file while the first still waits.
		internals.markSettled(secondEnd)
		expect(internals.settleEnd(secondEnd, path.join(root, fileOf(68)))).toBe(
			true,
		)
		internals.settleEnd(firstEnd, undefined)
		expect(seen).toEqual(["call_end:67", `call_end:68:${fileOf(68)}`])
		const ended = info.mock.calls
			.filter(c => c[1] === "Call ended")
			.map(c => c[0] as { talkgroup: number; hasWavFile: boolean })
			.map(c => [c.talkgroup, c.hasWavFile])
		expect(ended).toEqual([
			[67, false],
			[68, true],
		])
	})
})
