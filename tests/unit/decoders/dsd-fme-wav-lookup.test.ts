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
		endThrough(d, 42)
		internals.emitOutput({
			timestamp: START,
			decoder: "dsd-fme",
			type: "call_start",
			data: { callId: "next", talkgroup: 43, flags: {} },
		})
		const voice: string[] = []
		d.on("voice-call", (v: { callId: string; active: boolean }) =>
			voice.push(`${v.callId}:${v.active}`),
		)
		expect(seen).toEqual([])
		await settleWavLookups(d)
		expect(seen).toEqual([`call_end:42:${fileOf(42)}`, "call_start:43"])
		// The voice-call halves follow the same order.
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
		const opendir = stuckOpendir()
		const { d, found } = decoderWithUpdates()
		endThrough(d, 45)
		await vi.advanceTimersByTimeAsync(DSD_FME_WAV_ATTEMPT_TIMEOUT_MS - 1)
		// Only the first directory's read started, and it never settles.
		expect(opendir).toHaveBeenCalledTimes(1)
		await vi.advanceTimersByTimeAsync(1)
		// Abandoned: the retry is scheduled and reads again.
		opendir.mockRestore()
		fs.writeFileSync(path.join(root, fileOf(45)), "")
		await vi.advanceTimersByTimeAsync(DSD_FME_WAV_RETRY_MS)
		await settleWavLookups(d)
		// The end went out at its deadline; the retry's find is an update.
		expect(found).toEqual([fileOf(45)])
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
