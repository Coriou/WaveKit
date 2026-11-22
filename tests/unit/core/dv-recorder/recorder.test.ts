/**
 * The digital-voice call recorder's lifecycle (one test per row of its state table), against a
 * fake call tap and a temporary directory. Audio is synthetic.
 */
import {
	readFile,
	readdir,
	stat,
	utimes,
	writeFile,
	mkdir,
	symlink,
} from "node:fs/promises"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
	CALL_WAV,
	callNameFields,
} from "../../../../src/core/recordings/names.js"
import { dsdFmeKeepKey } from "../../../../src/core/recordings/contract.js"
import { parseRiffDurationMs } from "../../../../src/core/recordings/riff.js"
import {
	DSD_FME_CALL_WAV,
	setCallRecordingProtection,
} from "../../../../src/decoders/builtin/call-recordings.js"
import type { RecordingProtection } from "../../../../src/core/recordings/contract.js"
import {
	DV_RECORDER_FREE_FLOOR_BYTES,
	DV_RECORDER_NAME_ATTEMPTS,
	DV_RECORDER_PRUNE_RETRY_MS,
	createDvCallRecorder,
	nodeDvRecorderFs,
	type DvRecorderFs,
} from "../../../../src/core/dv-recorder/recorder.js"
import { DV_TEMP_WAV } from "../../../../src/core/dv-recorder/names.js"
import type { DvTapEndReason } from "../../../../src/core/dv-tap/types.js"
import {
	FakeCall,
	GIB,
	MIB,
	cleanupRoots,
	fsWithFree,
	harness,
	logger,
} from "./fake-tap.js"

afterEach(async () => {
	setCallRecordingProtection(null)
	await cleanupRoots()
})

async function wavs(dir: string): Promise<string[]> {
	return (await readdir(dir)).filter(n => n.endsWith(".wav")).sort()
}

function enospc(): NodeJS.ErrnoException {
	const err: NodeJS.ErrnoException = new Error("no space left")
	err.code = "ENOSPC"
	return err
}

describe("DV call recorder: DMR calls are not recorded yet", () => {
	it.each(["DMR", "dmr", "DMR BS", null])(
		"a clear call of protocol %s writes, keeps and reports nothing",
		async protocol => {
			const h = await harness()
			const call = new FakeCall(h.src, { protocol })
			call.voice(2000)
			call.end()
			await h.rec.stop()
			expect(await wavs(h.dir)).toEqual([])
			expect(h.finalized).toEqual([])
			expect(h.rec.bytesTotal()).toBe(0)
			expect(h.rec.counters()).toMatchObject({
				recorded: 0,
				refusedProtocol: 1,
				active: 0,
			})
		},
	)

	it.each(["P25", "NXDN", "D-STAR", "YSF", "dPMR"])(
		"a clear %s call still records one WAV",
		async protocol => {
			const h = await harness()
			const call = new FakeCall(h.src, { protocol })
			call.voice(2000)
			call.end()
			await h.rec.stop()
			expect(await wavs(h.dir)).toHaveLength(1)
			expect(h.finalized).toHaveLength(1)
			expect(h.rec.counters()).toMatchObject({
				recorded: 1,
				refusedProtocol: 0,
			})
		},
	)
})

describe("DV call recorder: A1-A4, A9 start, audio, end", () => {
	it("start -> PCM -> end writes one WAV with the right RIFF sizes", async () => {
		const h = await harness()
		const call = new FakeCall(h.src)
		call.voice(2000)
		call.end()
		await h.rec.stop()
		const files = await wavs(h.dir)
		expect(files).toHaveLength(1)
		const name = files[0] ?? ""
		expect(DSD_FME_CALL_WAV.test(name)).toBe(true)
		expect(CALL_WAV.test(name)).toBe(true)
		expect(dsdFmeKeepKey(name)).toBe(`dsd~${name}`)
		const buf = await readFile(join(h.dir, name))
		// 2 000 ms × 16 000 B/s = 32 000 B of PCM + 44 B header.
		expect(buf.length).toBe(32_044)
		expect(buf.toString("ascii", 0, 4)).toBe("RIFF")
		expect(buf.readUInt32LE(4)).toBe(36 + 32_000)
		expect(buf.readUInt32LE(40)).toBe(32_000)
		expect(buf.readUInt32LE(24)).toBe(8000)
		expect(buf.readInt16LE(44)).toBe(1000)
		expect(parseRiffDurationMs(buf.subarray(0, 64), buf.length)).toBe(2000)
		expect(h.finalized).toEqual([
			expect.objectContaining({
				decoderId: "dsd-fme",
				callId: "dsd-fme-c1-1",
				slot: null,
				fileName: name,
				durationMs: 2000,
				deliveredSamples: 16_000,
				lostSamples: 0,
				held: false,
				truncated: false,
				reason: "end",
				bytes: 32_044,
			}),
		])
		expect(h.rec.bytesTotal()).toBe(32_044)
		expect(h.rec.counters().recorded).toBe(1)
	})

	it("names the file from the call's name fields", async () => {
		const h = await harness(
			{},
			{
				callInfo: ref =>
					ref.callId === "c-private"
						? { callType: "private", talkgroup: "2001", source: "3105" }
						: null,
			},
		)
		const a = new FakeCall(h.src, { callId: "c-private" })
		a.voice(1200)
		a.end()
		await h.rec.stop()
		const [name] = await wavs(h.dir)
		expect(callNameFields(name ?? "")).toMatchObject({
			callType: "private",
			talkgroup: "2001",
			source: "3105",
		})
	})

	it("writes held audio first, in order, and reports it", async () => {
		const h = await harness()
		const call = new FakeCall(h.src, { state: "unknown" })
		call.state("clear", 2400)
		call.pcm(1600, 111, true)
		call.pcm(800, 222, true)
		call.voice(1000, 333)
		call.end()
		await h.rec.stop()
		const [name] = await wavs(h.dir)
		const buf = await readFile(join(h.dir, name ?? ""))
		expect(buf.readInt16LE(44)).toBe(111)
		expect(buf.readInt16LE(44 + 2 * 1600)).toBe(222)
		expect(buf.readInt16LE(44 + 2 * 2400)).toBe(333)
		expect(buf.readUInt32LE(40)).toBe(2 * (2400 + 8000))
		expect(h.finalized[0]?.held).toBe(true)
	})

	it("opens no file for a call that never gets audio", async () => {
		const h = await harness()
		const call = new FakeCall(h.src)
		call.end()
		await h.rec.stop()
		expect(await readdir(h.dir)).toEqual([])
		expect(h.finalized).toEqual([])
	})

	it("drops audio that is not contiguous backwards and counts a forward gap as lost", async () => {
		const h = await harness()
		const call = new FakeCall(h.src)
		call.voice(1000)
		// A repeat of the last block (firstSample behind): never written twice.
		h.src.t.pcm({
			decoderId: call.decoderId,
			callId: call.callId,
			slot: null,
			pcm: new Int16Array(1600).fill(7),
			firstSample: call.delivered - 1600,
			atMs: 0,
			held: false,
		})
		call.drop(800)
		call.voice(400)
		call.end()
		await h.rec.stop()
		expect(h.finalized[0]).toMatchObject({
			durationMs: 1400,
			lostSamples: 800,
		})
		expect(h.rec.counters().outOfOrder).toBe(1)
	})
})

describe("DV call recorder: minimum voice (A9 bound)", () => {
	it("keeps no file for a 300 ms call and leaves no TEMP", async () => {
		const h = await harness()
		const call = new FakeCall(h.src)
		call.voice(300)
		call.end()
		await h.rec.stop()
		expect(await readdir(h.dir)).toEqual([])
		expect(h.rec.counters().tooShort).toBe(1)
	})

	it("counts voiced samples over all samples: 8 000 non-zero samples keep, 7 999 do not", async () => {
		const at = await harness()
		const keep = new FakeCall(at.src, { callId: "at" })
		keep.voice(3000, 0) // silence
		const block = new Int16Array(8000)
		block.fill(5)
		keep.pcm(block)
		keep.end()
		await at.rec.stop()
		expect(await wavs(at.dir)).toHaveLength(1)

		const past = await harness()
		const drop = new FakeCall(past.src, { callId: "past" })
		const short = new Int16Array(8000)
		// 7 999 non-zero samples: the block's last sample is zero.
		short.fill(9, 0, 7999)
		drop.voice(2000, 0)
		drop.pcm(short)
		drop.end()
		await past.rec.stop()
		expect(await readdir(past.dir)).toEqual([])
		expect(past.rec.counters().tooShort).toBe(1)
	})

	it("minVoiceMs 0 keeps any call with audio", async () => {
		const h = await harness({ minVoiceMs: 0 })
		const call = new FakeCall(h.src)
		call.voice(100, 0)
		call.end()
		await h.rec.stop()
		expect(await wavs(h.dir)).toHaveLength(1)
	})
})

describe("DV call recorder: encryption and non-clear ends (A6, A9e)", () => {
	it("clear -> encrypted discards the TEMP and keeps no file", async () => {
		const h = await harness()
		const call = new FakeCall(h.src)
		call.voice(3000)
		call.state("encrypted")
		call.end("end", "encrypted")
		await h.rec.stop()
		expect(await readdir(h.dir)).toEqual([])
		expect(h.rec.counters().encryptedDiscarded).toBe(1)
		expect(h.finalized).toEqual([])
	})

	it("a call that starts encrypted records nothing", async () => {
		const h = await harness()
		const call = new FakeCall(h.src, { state: "encrypted" })
		call.pcm(1600) // a stray block (the service never sends one)
		call.end("end", "encrypted")
		await h.rec.stop()
		expect(await readdir(h.dir)).toEqual([])
	})

	it("an end that is not clear discards the call", async () => {
		const h = await harness()
		const call = new FakeCall(h.src)
		call.voice(2000)
		call.end("timeout", "unknown")
		await h.rec.stop()
		expect(await readdir(h.dir)).toEqual([])
		expect(h.rec.counters().notClearDiscarded).toBe(1)
	})

	it("audio while unknown (no state event to clear) is never written", async () => {
		const h = await harness()
		const call = new FakeCall(h.src, { state: "unknown" })
		call.voice(2000)
		call.end()
		await h.rec.stop()
		expect(await readdir(h.dir)).toEqual([])
	})
})

describe("DV call recorder: concurrent calls", () => {
	it("two slots of one decoder and a second decoder give one file each", async () => {
		const h = await harness()
		const s1 = new FakeCall(h.src, { callId: "a-1", slot: 1 })
		const s2 = new FakeCall(h.src, { callId: "a-2", slot: 2 })
		const b = new FakeCall(h.src, { decoderId: "dsd-fme-2", callId: "b-1" })
		for (let i = 0; i < 8; i++) {
			s1.pcm(1600, 11)
			s2.pcm(1600, 22)
			b.pcm(1600, 33)
		}
		s2.end()
		s1.end()
		b.end()
		await h.rec.stop()
		const files = await wavs(h.dir)
		expect(files).toHaveLength(3)
		const firsts = await Promise.all(
			files.map(async f => (await readFile(join(h.dir, f))).readInt16LE(44)),
		)
		expect(firsts.sort((x, y) => x - y)).toEqual([11, 22, 33])
		expect(files.filter(f => f.includes("_dsd-fme-2_"))).toHaveLength(1)
		expect(h.finalized.map(f => f.slot).sort()).toEqual([1, 2, null])
	})

	it("a replaced call ends with a file and the next call gets its own (A11)", async () => {
		const h = await harness()
		const a = new FakeCall(h.src, { callId: "x-1", slot: 1 })
		a.voice(1500)
		a.end("replaced")
		const b = new FakeCall(h.src, { callId: "x-2", slot: 1 })
		b.voice(1500)
		b.end()
		await h.rec.stop()
		expect(await wavs(h.dir)).toHaveLength(2)
		// Renames run on each call's own chain, so the two may finish in either order.
		expect(h.finalized.map(f => [f.callId, f.reason]).sort()).toEqual([
			["x-1", "replaced"],
			["x-2", "end"],
		])
	})
})

describe("DV call recorder: every end reason", () => {
	const reasons: DvTapEndReason[] = [
		"end",
		"timeout",
		"replaced",
		"decoder-exit",
		"restart",
		"shutdown",
		"fault",
	]
	it.each(reasons)(
		"a clear call ending with %s keeps its file",
		async reason => {
			const h = await harness()
			const call = new FakeCall(h.src)
			call.voice(1100)
			call.end(reason)
			await h.rec.stop()
			expect(await wavs(h.dir)).toHaveLength(1)
			expect(h.finalized[0]?.reason).toBe(reason)
		},
	)
})

describe("DV call recorder: write failures (A8)", () => {
	function failing(
		fails: (write: number, position: number) => boolean,
	): DvRecorderFs {
		const base = fsWithFree(() => 10 * GIB)
		let writes = 0
		return {
			...base,
			open: async (p, flags) => {
				const h = await nodeDvRecorderFs.open(p, flags)
				return {
					write: (b, o, l, pos) =>
						fails(++writes, pos)
							? Promise.reject(enospc())
							: h.write(b, o, l, pos),
					close: () => h.close(),
				}
			},
		}
	}
	const failingWrites = (after: number) => failing(n => n > after)

	it("ENOSPC mid-call abandons the call without throwing and removes the TEMP", async () => {
		const h = await harness({}, { fs: failingWrites(1) })
		const call = new FakeCall(h.src)
		expect(() => {
			call.voice(3000)
			call.end()
		}).not.toThrow()
		await h.rec.stop()
		expect(await readdir(h.dir)).toEqual([])
		expect(h.rec.counters().writeErrors).toBe(1)
		expect(h.finalized).toEqual([])
	})

	it("after a write error no call starts until a prune pass reads the free space again", async () => {
		let at = 1_000_000
		const h = await harness({}, { fs: failingWrites(1), now: () => at })
		const first = new FakeCall(h.src, { callId: "c1" })
		first.voice(3000)
		first.end()
		// Let the failing write settle.
		await new Promise(r => setTimeout(r, 50))
		expect(h.rec.counters().writeErrors).toBe(1)
		const second = new FakeCall(h.src, { callId: "c2" })
		second.voice(2000)
		second.end()
		expect(h.rec.counters().refusedFloor).toBe(1)
		at += DV_RECORDER_PRUNE_RETRY_MS
		const third = new FakeCall(h.src, { callId: "c3" })
		third.end()
		expect(h.rec.counters().refusedFloor).toBe(2)
		await h.rec.stop()
	})

	it("a failing open abandons the call", async () => {
		const base = fsWithFree(() => 10 * GIB)
		const h = await harness(
			{},
			{ fs: { ...base, open: () => Promise.reject(enospc()) } },
		)
		const call = new FakeCall(h.src)
		call.voice(2000)
		call.end()
		await h.rec.stop()
		expect(await readdir(h.dir)).toEqual([])
		expect(h.rec.counters().writeErrors).toBe(1)
	})

	it("a failing header patch at finish keeps no file", async () => {
		// The placeholder header is write 1 at offset 0; the patch is the next write at 0.
		const h = await harness({}, { fs: failing((n, pos) => n > 1 && pos === 0) })
		const call = new FakeCall(h.src)
		call.voice(1500)
		call.end()
		await h.rec.stop()
		expect(await readdir(h.dir)).toEqual([])
		expect(h.rec.counters().writeErrors).toBe(1)
	})
})

describe("DV call recorder: start sweep (A12)", () => {
	it("removes TEMP_dv leftovers at start only, and nothing else", async () => {
		const h = await harness({}, {}, false)
		await mkdir(h.dir, { recursive: true })
		const leftover = "TEMP_dv_20260101_000000_ABCD.wav"
		const dsdTemp = "TEMP_20260101_000000_ABCD.wav"
		const user = "my-notes.wav"
		for (const n of [leftover, dsdTemp, user])
			await writeFile(join(h.dir, n), Buffer.alloc(10))
		await h.rec.start()
		expect((await readdir(h.dir)).sort()).toEqual([dsdTemp, user].sort())
		// A TEMP_dv appearing while running is not swept by a finishing call.
		const later = "TEMP_dv_20260101_000001_0001.wav"
		await writeFile(join(h.dir, later), Buffer.alloc(10))
		const call = new FakeCall(h.src)
		call.voice(1200)
		call.end()
		await h.rec.stop()
		const names = await readdir(h.dir)
		expect(names).toContain(later)
		expect(names.filter(n => DV_TEMP_WAV.test(n))).toEqual([later])
	})
})

describe("DV call recorder: max-call cap (A5)", () => {
	it("below the cap the file is whole and not truncated", async () => {
		const h = await harness({ minVoiceMs: 500, maxCallMs: 1000 })
		const call = new FakeCall(h.src)
		call.voice(900)
		call.end()
		await h.rec.stop()
		expect(h.finalized[0]).toMatchObject({ durationMs: 900, truncated: false })
	})

	it("at the cap (exactly maxCallMs) the file ends there (the recorder cannot know no more follows)", async () => {
		const h = await harness({ minVoiceMs: 500, maxCallMs: 1000 })
		const call = new FakeCall(h.src)
		call.voice(1000)
		call.end()
		await h.rec.stop()
		expect(h.finalized).toHaveLength(1)
		expect(h.finalized[0]).toMatchObject({ durationMs: 1000, truncated: true })
		const [name] = await wavs(h.dir)
		expect((await stat(join(h.dir, name ?? ""))).size).toBe(16_044)
	})

	it("past the cap the file is cut at 1 000 ms and later audio is ignored", async () => {
		const h = await harness({ minVoiceMs: 500, maxCallMs: 1000 })
		const call = new FakeCall(h.src)
		call.voice(1100)
		call.voice(2000)
		call.end()
		await h.rec.stop()
		const files = await wavs(h.dir)
		expect(files).toHaveLength(1)
		expect((await stat(join(h.dir, files[0] ?? ""))).size).toBe(16_044)
		expect(h.finalized[0]).toMatchObject({
			truncated: true,
			reason: null,
			durationMs: 1000,
		})
		expect(h.rec.counters().truncated).toBe(1)
	})
})

describe("DV call recorder: directory cap, retention and free floor (A1, A13)", () => {
	it("starts calls while the total is below retentionBytes, refuses at it", async () => {
		const cap = 16 * MIB
		const below = await harness(
			{ retentionBytes: cap },
			{
				prune: () =>
					Promise.resolve({ deleted: [], keptFiles: 1, keptBytes: cap - 1 }),
			},
		)
		const a = new FakeCall(below.src)
		a.voice(1100)
		a.end()
		await below.rec.stop()
		expect(await wavs(below.dir)).toHaveLength(1)

		const at = await harness(
			{ retentionBytes: cap },
			{
				prune: () =>
					Promise.resolve({ deleted: [], keptFiles: 1, keptBytes: cap }),
			},
		)
		const b = new FakeCall(at.src)
		b.voice(1100)
		b.end()
		await at.rec.stop()
		expect(await readdir(at.dir)).toEqual([])
		expect(at.rec.counters().refusedCap).toBe(1)
	})

	it("runs a prune pass after a rename that takes the total past the cap", async () => {
		const cap = 16 * MIB
		let passes = 0
		const h = await harness(
			{ retentionBytes: cap },
			{
				prune: () => {
					passes++
					return Promise.resolve({
						deleted: [],
						keptFiles: 1,
						keptBytes: cap - 100,
					})
				},
			},
		)
		expect(passes).toBe(1) // the start pass
		const call = new FakeCall(h.src)
		call.voice(1100)
		call.end()
		await h.rec.stop()
		expect(passes).toBe(2)
		// Recomputed by the pass: the fake reports cap - 100 kept (+ nothing added since).
		expect(h.rec.bytesTotal()).toBe(cap - 100)
	})

	it("the start pass deletes files past retentionDays and keeps younger and kept ones", async () => {
		const h = await harness({ retentionDays: 7 }, {}, false)
		await mkdir(h.dir, { recursive: true })
		const now = Date.now()
		const day = 86_400_000
		const old = "20260101_000000_00001_dsd-fme_GROUP_TGT_1_SRC_2.wav"
		const kept = "20260101_000000_00002_dsd-fme_GROUP_TGT_1_SRC_2.wav"
		const young = "20260101_000000_00003_dsd-fme_GROUP_TGT_1_SRC_2.wav"
		for (const [n, age] of [
			[old, 7 * day + 60_000],
			[kept, 8 * day],
			[young, 7 * day - 60_000],
		] as const) {
			const p = join(h.dir, n)
			await writeFile(p, Buffer.alloc(1000))
			await utimes(p, (now - age) / 1000, (now - age) / 1000)
		}
		const port: RecordingProtection = {
			isProtected: () => false,
			isDsdFmeFileProtected: n => n === kept,
			isScannerFileProtected: () => false,
			discoveryHoldsKept: () => false,
		}
		setCallRecordingProtection(port, logger)
		await h.rec.start()
		expect((await wavs(h.dir)).sort()).toEqual([kept, young].sort())
		// Kept files still count toward the total.
		expect(h.rec.bytesTotal()).toBe(2000)
		await h.rec.stop()
	})

	it("the start pass prunes the oldest files past retentionBytes", async () => {
		const h = await harness({ retentionBytes: 16 * MIB }, {}, false)
		await mkdir(h.dir, { recursive: true })
		const now = Date.now()
		const names = [1, 2, 3].map(
			i => `20260101_00000${i}_0000${i}_dsd-fme_GROUP_TGT_1_SRC_2.wav`,
		)
		for (const [i, n] of names.entries()) {
			const p = join(h.dir, n)
			await writeFile(p, Buffer.alloc(6 * MIB))
			const t = (now - 3_600_000 + i * 60_000) / 1000
			await utimes(p, t, t)
		}
		await h.rec.start()
		// 18 MiB > 16 MiB: the oldest goes, 12 MiB stay (at or under the bound).
		expect(await wavs(h.dir)).toEqual(names.slice(1))
		expect(h.rec.bytesTotal()).toBe(12 * MIB)
		await h.rec.stop()
	})

	it("records at exactly the free floor and refuses one byte below it", async () => {
		let freeNow = DV_RECORDER_FREE_FLOOR_BYTES
		const at = await harness({}, { fs: fsWithFree(() => freeNow) })
		const a = new FakeCall(at.src)
		a.voice(2000)
		a.end()
		await at.rec.stop()
		expect(await wavs(at.dir)).toHaveLength(1)

		freeNow = DV_RECORDER_FREE_FLOOR_BYTES - 1
		const past = await harness({}, { fs: fsWithFree(() => freeNow) })
		const b = new FakeCall(past.src)
		b.voice(2000)
		b.end()
		await past.rec.stop()
		expect(await readdir(past.dir)).toEqual([])
		expect(past.rec.counters().refusedFloor).toBe(1)
	})

	it("the free figure falls as calls are written (no statfs per call)", async () => {
		// 2 B short of room for a 2 s call (32 000 B of PCM) above the floor: the first call
		// starts, and after it the figure is 2 B under the floor.
		const h = await harness(
			{},
			{ fs: fsWithFree(() => DV_RECORDER_FREE_FLOOR_BYTES + 31_998) },
		)
		const a = new FakeCall(h.src, { callId: "a" })
		a.voice(2000)
		a.end()
		const b = new FakeCall(h.src, { callId: "b" })
		b.voice(2000)
		b.end()
		await h.rec.stop()
		expect(await wavs(h.dir)).toHaveLength(1)
		expect(h.rec.counters().refusedFloor).toBe(1)
	})

	it("an unreadable free figure records nothing (fail closed)", async () => {
		const base = fsWithFree(() => 10 * GIB)
		const h = await harness(
			{},
			{ fs: { ...base, statfs: () => Promise.reject(new Error("nope")) } },
		)
		const a = new FakeCall(h.src)
		a.voice(2000)
		a.end()
		await h.rec.stop()
		expect(await readdir(h.dir)).toEqual([])
	})
})

describe("DV call recorder: stop and disabled (A14)", () => {
	it("stop() finalizes an open clear call, removes the tap and ignores later events", async () => {
		const h = await harness()
		const call = new FakeCall(h.src)
		call.voice(1500)
		const tap = h.src.t
		await h.rec.stop()
		expect(h.src.tap).toBeNull()
		expect(h.finalized[0]).toMatchObject({
			reason: "shutdown",
			durationMs: 1500,
		})
		// The service's own `end` after the stop, then a new call: both ignored.
		tap.end({
			decoderId: call.decoderId,
			callId: call.callId,
			slot: null,
			reason: "shutdown",
			finalState: "clear",
			deliveredSamples: call.delivered,
			lostSamples: 0,
			discardedHeldSamples: 0,
			endedAtMs: 0,
		})
		expect(await wavs(h.dir)).toHaveLength(1)
		expect(h.finalized).toHaveLength(1)
	})

	it("stop() discards an open call that is not clear", async () => {
		const h = await harness()
		const call = new FakeCall(h.src)
		call.voice(1500)
		call.state("unknown")
		await h.rec.stop()
		expect(await readdir(h.dir)).toEqual([])
	})

	it("disabled: start adds no tap and creates no directory", async () => {
		const h = await harness({ enabled: false })
		expect(h.src.tap).toBeNull()
		await expect(readdir(h.dir)).rejects.toMatchObject({ code: "ENOENT" })
		await h.rec.stop()
	})
})

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = (): void => undefined
	const promise = new Promise<void>(r => {
		resolve = r
	})
	return { promise, resolve }
}

function eexist(): NodeJS.ErrnoException {
	const err: NodeJS.ErrnoException = new Error("exists")
	err.code = "EEXIST"
	return err
}

describe("DV call recorder: directory safety (M2) and the wiring guard", () => {
	it("refuses a symlinked directory: no tap, no file, a status count", async () => {
		const h = await harness({}, {}, false)
		const real = join(h.dir, "..", "real-dir")
		await mkdir(real, { recursive: true })
		await symlink(real, h.dir)
		await h.rec.start()
		expect(h.src.tap).toBeNull()
		expect(h.rec.counters().refusedDir).toBe(1)
		expect(await readdir(real)).toEqual([])
		await h.rec.stop()
	})

	it("refuses a directory path that is a file", async () => {
		const h = await harness({}, {}, false)
		await mkdir(join(h.dir, ".."), { recursive: true })
		await writeFile(h.dir, Buffer.alloc(1))
		await h.rec.start()
		expect(h.src.tap).toBeNull()
		expect(h.rec.counters().refusedDir).toBe(1)
	})

	it("never prunes without a protection port: it only measures and deletes nothing", async () => {
		let passes = 0
		const h = await harness(
			{ retentionDays: 1, retentionBytes: 16 * MIB },
			{
				protectionInstalled: () => false,
				prune: () => {
					passes++
					return Promise.resolve({ deleted: [], keptFiles: 0, keptBytes: 0 })
				},
			},
			false,
		)
		await mkdir(h.dir, { recursive: true })
		const old = "20260101_000000_00001_dsd-fme_GROUP_TGT_1_SRC_2.wav"
		const p = join(h.dir, old)
		await writeFile(p, Buffer.alloc(1000))
		const t = (Date.now() - 30 * 86_400_000) / 1000
		await utimes(p, t, t)
		await h.rec.start()
		expect(passes).toBe(0)
		expect(await wavs(h.dir)).toEqual([old])
		expect(h.rec.bytesTotal()).toBe(1000)
		expect(h.rec.counters().pruneUnprotected).toBe(1)
		// Recording still works; the measured total counts the new file.
		const call = new FakeCall(h.src)
		call.voice(1100)
		call.end()
		await h.rec.stop()
		expect(await wavs(h.dir)).toHaveLength(2)
		expect(passes).toBe(0)
	})

	it("the real pruner with no port configured in the recorder deletes nothing (default)", async () => {
		// Only for its directory and settings; the recorder under test has no protectionInstalled.
		const h = await harness({ retentionDays: 1 }, {}, false)
		const rec = createDvCallRecorder({
			settings: h.settings,
			source: h.src,
			logger,
			fs: fsWithFree(() => 10 * GIB),
		})
		await mkdir(h.dir, { recursive: true })
		const old = "20260101_000000_00001_dsd-fme_GROUP_TGT_1_SRC_2.wav"
		const p = join(h.dir, old)
		await writeFile(p, Buffer.alloc(1000))
		const t = (Date.now() - 30 * 86_400_000) / 1000
		await utimes(p, t, t)
		await rec.start()
		expect(await wavs(h.dir)).toEqual([old])
		expect(rec.counters().pruneUnprotected).toBe(1)
		await rec.stop()
	})
})

describe("DV call recorder: final names never overwrite (link, EEXIST)", () => {
	function linkFailing(eexists: number): DvRecorderFs {
		const base = fsWithFree(() => 10 * GIB)
		let n = 0
		return {
			...base,
			link: (a, b) =>
				n++ < eexists ? Promise.reject(eexist()) : base.link(a, b),
		}
	}

	it("a taken name draws the next one and keeps no TEMP", async () => {
		const h = await harness({}, { fs: linkFailing(2) })
		const call = new FakeCall(h.src)
		call.voice(1200)
		call.end()
		await h.rec.stop()
		const names = await readdir(h.dir)
		expect(names).toHaveLength(1)
		expect(DV_TEMP_WAV.test(names[0] ?? "")).toBe(false)
		expect(h.rec.counters().recorded).toBe(1)
	})

	it("an existing file on the drawn name is never replaced", async () => {
		const h = await harness({}, { random: () => 0.5 })
		// Every draw is 50 000: the first call takes the name, the second runs out of attempts.
		const a = new FakeCall(h.src, { callId: "a" })
		a.voice(1200, 11)
		a.end()
		await new Promise(r => setTimeout(r, 50))
		const [first] = await wavs(h.dir)
		const b = new FakeCall(h.src, { callId: "b" })
		b.voice(1200, 22)
		b.end()
		await h.rec.stop()
		expect(await readdir(h.dir)).toEqual([first])
		expect((await readFile(join(h.dir, first ?? ""))).readInt16LE(44)).toBe(11)
		expect(h.rec.counters().nameExhausted).toBe(1)
	})

	it(`${DV_RECORDER_NAME_ATTEMPTS} taken names drop the call; ${DV_RECORDER_NAME_ATTEMPTS - 1} do not`, async () => {
		const at = await harness(
			{},
			{ fs: linkFailing(DV_RECORDER_NAME_ATTEMPTS - 1) },
		)
		const a = new FakeCall(at.src)
		a.voice(1200)
		a.end()
		await at.rec.stop()
		expect(await wavs(at.dir)).toHaveLength(1)

		const past = await harness(
			{},
			{ fs: linkFailing(DV_RECORDER_NAME_ATTEMPTS) },
		)
		const b = new FakeCall(past.src)
		b.voice(1200)
		b.end()
		await past.rec.stop()
		expect(await readdir(past.dir)).toEqual([])
		expect(past.rec.counters().nameExhausted).toBe(1)
		expect(past.finalized).toEqual([])
	})
})

describe("DV call recorder: slow file work", () => {
	it("an end before a slow open resolves still writes the whole call", async () => {
		const gate = deferred()
		const base = fsWithFree(() => 10 * GIB)
		const h = await harness(
			{},
			{
				fs: {
					...base,
					open: async (p, f) => {
						await gate.promise
						return base.open(p, f)
					},
				},
			},
		)
		const call = new FakeCall(h.src)
		call.voice(2000)
		call.end()
		gate.resolve()
		await h.rec.stop()
		const [name] = await wavs(h.dir)
		expect((await stat(join(h.dir, name ?? ""))).size).toBe(32_044)
	})

	it("stop() during a rename waits for it and keeps the file", async () => {
		const gate = deferred()
		let linking = false
		const base = fsWithFree(() => 10 * GIB)
		const h = await harness(
			{},
			{
				fs: {
					...base,
					link: async (a, b) => {
						linking = true
						await gate.promise
						return base.link(a, b)
					},
				},
			},
		)
		const call = new FakeCall(h.src)
		call.voice(1500)
		call.end()
		while (!linking) await new Promise(r => setTimeout(r, 5))
		let stopped = false
		const stopping = h.rec.stop().then(() => {
			stopped = true
		})
		await new Promise(r => setTimeout(r, 20))
		expect(stopped).toBe(false)
		gate.resolve()
		await stopping
		expect(await wavs(h.dir)).toHaveLength(1)
		expect(h.finalized).toHaveLength(1)
	})

	it("start() during a stop waits for the stop, then adds the tap again", async () => {
		const gate = deferred()
		const base = fsWithFree(() => 10 * GIB)
		const h = await harness(
			{},
			{
				fs: {
					...base,
					link: async (a, b) => {
						await gate.promise
						return base.link(a, b)
					},
				},
			},
		)
		const call = new FakeCall(h.src)
		call.voice(1500)
		const stopping = h.rec.stop()
		const starting = h.rec.start()
		await new Promise(r => setTimeout(r, 20))
		expect(h.src.tap).toBeNull()
		gate.resolve()
		await stopping
		await starting
		expect(h.src.tap).not.toBeNull()
		expect(await wavs(h.dir)).toHaveLength(1)
		await h.rec.stop()
	})
})

describe("DV call recorder: the prune retry under the free floor", () => {
	it(`a refused start re-reads statfs only after ${DV_RECORDER_PRUNE_RETRY_MS} ms`, async () => {
		let at = 1_000_000
		let statfsCalls = 0
		let freeNow = DV_RECORDER_FREE_FLOOR_BYTES - 1
		const base = fsWithFree(() => freeNow)
		const h = await harness(
			{},
			{
				now: () => at,
				fs: {
					...base,
					statfs: d => {
						statfsCalls++
						return base.statfs(d)
					},
				},
			},
		)
		expect(statfsCalls).toBe(1) // the start pass
		at += DV_RECORDER_PRUNE_RETRY_MS - 1
		new FakeCall(h.src, { callId: "c1" }).end()
		await new Promise(r => setTimeout(r, 20))
		expect(statfsCalls).toBe(1)
		at += 1
		freeNow = 10 * GIB
		new FakeCall(h.src, { callId: "c2" }).end()
		await new Promise(r => setTimeout(r, 20))
		expect(statfsCalls).toBe(2)
		expect(h.rec.counters().refusedFloor).toBe(2)
		// The pass read the new figure: the next call records.
		const c3 = new FakeCall(h.src, { callId: "c3" })
		c3.voice(1200)
		c3.end()
		await h.rec.stop()
		expect(await wavs(h.dir)).toHaveLength(1)
	})
})

describe("DV call recorder: minor lifecycle edges", () => {
	it("a refused repeated start leaves no stale record", async () => {
		// 2 B short of room for a 2 s call above the floor: after it the figure is under the floor.
		const h = await harness(
			{},
			{ fs: fsWithFree(() => DV_RECORDER_FREE_FLOOR_BYTES + 31_998) },
		)
		const a = new FakeCall(h.src, { callId: "same" })
		a.voice(2000)
		const again = new FakeCall(h.src, { callId: "same" })
		expect(h.rec.counters().refusedFloor).toBe(1)
		expect(h.rec.counters().active).toBe(0)
		again.voice(2000)
		again.end()
		await h.rec.stop()
		expect(await wavs(h.dir)).toHaveLength(1)
		expect(h.finalized).toHaveLength(1)
	})

	it("a writer error after an abandon is not a write error and keeps recording on", async () => {
		const base = fsWithFree(() => 10 * GIB)
		let opened = 0
		const h = await harness(
			{},
			{
				fs: {
					...base,
					open: async (p, f) => {
						const handle = await base.open(p, f)
						if (++opened > 1) return handle
						return {
							write: (b, o, l, pos) => handle.write(b, o, l, pos),
							close: async () => {
								await handle.close()
								throw enospc()
							},
						}
					},
				},
			},
		)
		const enc = new FakeCall(h.src, { callId: "enc" })
		enc.voice(2000)
		enc.state("encrypted")
		await new Promise(r => setTimeout(r, 50))
		enc.end("end", "encrypted")
		const next = new FakeCall(h.src, { callId: "next" })
		next.voice(1200)
		next.end()
		await h.rec.stop()
		expect(h.rec.counters().writeErrors).toBe(0)
		expect(h.rec.counters().refusedFloor).toBe(0)
		expect(await wavs(h.dir)).toHaveLength(1)
	})
})
