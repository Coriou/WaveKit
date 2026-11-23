/**
 * dsd-fme per-call WAV lookup off the event loop (findWavFileAsync): async listings only (no
 * sync directory read), one attempt in flight per adapter however many calls end at once, and
 * at most DSD_FME_WAV_LIST_MAX_ENTRIES names examined per listing. Synthetic names only.
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	DSD_FME_WAV_LIST_MAX_ENTRIES,
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
})
