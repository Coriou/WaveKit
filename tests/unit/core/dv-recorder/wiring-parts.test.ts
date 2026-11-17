/**
 * The recorder wiring's parts: the directory default, the catalogue source, the decoder ids,
 * the call name book fed from the decoder's call events, overlapping calls on one decoder and
 * slot (the tap hears a call DV_TAP_SETTLE_MS late), a shutdown inside that window, and a cap
 * cut whose link waits for the call's end. Fake tap, synthetic audio and ids only.
 */
import { EventEmitter } from "node:events"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { CALL_LINK_END_KEEP_MS } from "../../../../src/core/activity/ingress.js"
import {
	DV_TAP_BLOCK_MAX_MS,
	DV_TAP_SAMPLE_RATE_HZ,
	DV_TAP_SETTLE_MS,
} from "../../../../src/core/dv-tap/types.js"
import type { DvCallTap } from "../../../../src/core/dv-tap/types.js"
import {
	DV_CALL_INFO_MAX,
	DV_CALL_SOURCE_LABEL,
	createDvCallInfoBook,
	createDvCallRecorderWiring,
	dvCallDecoderIds,
	dvCallRecordingDir,
	dvCallRecordingSource,
	dvCallTapSourceOf,
} from "../../../../src/core/dv-recorder/wiring.js"
import { DvRecordCallsConfigSchema } from "../../../../src/config.js"
import type { DecoderOutput } from "../../../../src/decoders/types.js"
import {
	FakeCall,
	FakeTapSource,
	GIB,
	T0,
	cleanupRoots,
	fsWithFree,
	logger,
	sequence,
	tmpRoot,
} from "./fake-tap.js"

afterEach(cleanupRoots)

function out(
	type: "call_start" | "call_end",
	data: Record<string, unknown>,
): DecoderOutput {
	return { timestamp: new Date(T0), decoder: "dsd-fme", type, data }
}

const ref = (callId: string) => ({ decoderId: "dsd-fme", callId, slot: null })

describe("wiring helpers", () => {
	it("defaults the directory under the state dir and resolves a configured one", () => {
		const cfg = DvRecordCallsConfigSchema.parse({})
		expect(dvCallRecordingDir(cfg, "/var/lib/wk")).toBe(
			"/var/lib/wk/recordings/dv-calls",
		)
		expect(dvCallRecordingDir({ dir: "/data/calls/" }, "/var/lib/wk")).toBe(
			"/data/calls",
		)
		expect(dvCallRecordingSource("/d")).toEqual({
			decoderId: DV_CALL_SOURCE_LABEL,
			dir: "/d",
			kind: "dv-call",
		})
	})

	it("finds a service's call tap, or none", () => {
		expect(dvCallTapSourceOf({})).toBeNull()
		const src = new FakeTapSource()
		const found = dvCallTapSourceOf(src)
		expect(found).not.toBeNull()
		const tap = {} as DvCallTap
		const remove = found?.addCallTap(tap)
		expect(src.tap).toBe(tap)
		remove?.()
		expect(src.tap).toBeNull()
	})

	it("lists configured and active dsd-fme decoders, probes included, sorted and unique", () => {
		expect(
			dvCallDecoderIds({
				getConfiguredDecoderConfigs: () => [
					{ id: "dsd-b", type: "dsd-fme" },
					{ id: "adsb", type: "readsb" },
				],
				getAllDecoders: () => [
					{ id: "dsd-b", type: "dsd-fme" },
					{ id: "scan-abc1234-dmr-1", type: "dsd-fme" },
					{ id: "dsd-a", type: "dsd-fme" },
				],
			}),
		).toEqual(["dsd-a", "dsd-b", "scan-abc1234-dmr-1"])
	})
})

describe("the call name book", () => {
	it("keeps a DMR call's talkgroup and source; 0 is unknown", () => {
		const book = createDvCallInfoBook()
		book.noteOutput(
			"dsd-fme",
			out("call_start", { callId: "c1", talkgroup: 9, source: 2001 }),
		)
		expect(book.lookup(ref("c1"))).toEqual({
			callType: null,
			talkgroup: "9",
			source: "2001",
		})
		book.noteOutput(
			"dsd-fme",
			out("call_start", { callId: "c2", talkgroup: 0, source: 0 }),
		)
		expect(book.lookup(ref("c2"))).toBeNull()
	})

	it("takes D-STAR's UR and MY, never an unverified header's", () => {
		const book = createDvCallInfoBook()
		const dstar = { my: "N0CALL  ", ur: "CQCQCQ  " }
		book.noteOutput(
			"dsd-fme",
			out("call_start", { callId: "c1", talkgroup: 0, source: 0, dstar }),
		)
		expect(book.lookup(ref("c1"))).toEqual({
			callType: null,
			talkgroup: "CQCQCQ",
			source: "N0CALL",
		})
		book.noteOutput(
			"dsd-fme",
			out("call_end", {
				callId: "c2",
				talkgroup: 0,
				source: 0,
				dstar: { ...dstar, verified: false },
			}),
		)
		expect(book.lookup(ref("c2"))).toBeNull()
	})

	it("an end keeps the start's fields, a late file notice changes nothing, forget removes", () => {
		const book = createDvCallInfoBook()
		book.noteOutput(
			"dsd-fme",
			out("call_start", { callId: "c1", talkgroup: 9, source: 2001 }),
		)
		book.noteOutput("dsd-fme", out("call_end", { callId: "c1" }))
		book.noteOutput(
			"dsd-fme",
			out("call_end", {
				callId: "c1",
				talkgroup: 7,
				flags: { wavFileUpdate: true },
			}),
		)
		expect(book.lookup(ref("c1"))?.talkgroup).toBe("9")
		book.forget(ref("c1"))
		expect(book.lookup(ref("c1"))).toBeNull()
	})

	it("an ended call goes CALL_LINK_END_KEEP_MS after its end, on the next end", () => {
		let t = 0
		const book = createDvCallInfoBook(() => t)
		const end = (callId: string) =>
			book.noteOutput(
				"dsd-fme",
				out("call_end", { callId, talkgroup: 9, source: 1 }),
			)
		end("c1")
		t = CALL_LINK_END_KEEP_MS
		end("c2")
		expect(book.lookup(ref("c1"))).not.toBeNull()
		t = CALL_LINK_END_KEEP_MS + 1
		end("c3")
		expect(book.lookup(ref("c1"))).toBeNull()
		expect(book.lookup(ref("c2"))).not.toBeNull()
	})

	it("holds DV_CALL_INFO_MAX calls, the oldest out past it", () => {
		const book = createDvCallInfoBook()
		for (let i = 0; i <= DV_CALL_INFO_MAX; i++)
			book.noteOutput(
				"dsd-fme",
				out("call_start", { callId: `c${i}`, talkgroup: 9, source: 1 }),
			)
		expect(book.size()).toBe(DV_CALL_INFO_MAX)
		expect(book.lookup(ref("c0"))).toBeNull()
		expect(book.lookup(ref(`c${DV_CALL_INFO_MAX}`))).not.toBeNull()
	})
})

interface Linked {
	decoderId: string
	callId: string
	key: string
	durationMs: number
}

async function wired(over: Record<string, unknown> = {}) {
	const root = await tmpRoot()
	const src = new FakeTapSource()
	const outputs = new EventEmitter()
	const linked: Linked[] = []
	const touched: (string | undefined)[] = []
	const w = createDvCallRecorderWiring({
		config: DvRecordCallsConfigSchema.parse(over),
		stateDir: root,
		tapSource: src,
		inventory: {
			touchCallRecordings: async id => {
				touched.push(id)
			},
		},
		ingress: {
			linkRecording: (decoderId, callId, key, durationMs) => {
				// The catalogue was told first.
				expect(touched).toContain(decoderId)
				linked.push({ decoderId, callId, key, durationMs })
			},
		},
		decoderIds: () => ["dsd-fme"],
		outputs,
		protectionInstalled: () => true,
		logger,
		recorder: { fs: fsWithFree(() => 10 * GIB), random: sequence() },
	})
	await w.start()
	return { w, src, outputs, linked, dir: w.dir }
}

/** Samples per tap block of DV_TAP_BLOCK_MAX_MS. */
const BLOCK = (DV_TAP_BLOCK_MAX_MS * DV_TAP_SAMPLE_RATE_HZ) / 1000

describe("the recorder wiring", () => {
	it("two calls on one decoder and slot whose deliveries overlap give two files, in order, each linked", async () => {
		const { w, src, outputs, linked, dir } = await wired()
		const settleBlocks = DV_TAP_SETTLE_MS / DV_TAP_BLOCK_MAX_MS
		outputs.emit(
			"decoder:output",
			"dsd-fme",
			out("call_start", { callId: "A", talkgroup: 9, source: 1001 }),
		)
		const a = new FakeCall(src, { callId: "A", slot: 1, startedAtMs: T0 })
		for (let i = 0; i < settleBlocks; i++) a.pcm(BLOCK, 1000)
		// The decoder ended A and started B; the tap still delivers A's last DV_TAP_SETTLE_MS.
		outputs.emit("decoder:output", "dsd-fme", out("call_end", { callId: "A" }))
		outputs.emit(
			"decoder:output",
			"dsd-fme",
			out("call_start", { callId: "B", talkgroup: 9, source: 1002 }),
		)
		const b = new FakeCall(src, {
			callId: "B",
			slot: 1,
			startedAtMs: T0 + 2 * DV_TAP_SETTLE_MS,
		})
		for (let i = 0; i < settleBlocks; i++) {
			a.pcm(BLOCK, 1000)
			b.pcm(BLOCK, 2000)
		}
		a.end()
		for (let i = 0; i < settleBlocks; i++) b.pcm(BLOCK, 2000)
		outputs.emit("decoder:output", "dsd-fme", out("call_end", { callId: "B" }))
		b.end()
		await w.stop()
		const files = (await readdir(dir)).sort()
		expect(files).toHaveLength(2)
		expect(files[0]).toMatch(/_GROUP_TGT_9_SRC_1001\.wav$/)
		expect(files[1]).toMatch(/_GROUP_TGT_9_SRC_1002\.wav$/)
		// A holds only its own audio (1000), B only its own (2000), each 2 × the settle window.
		const bodyOf = async (name: string) => {
			const buf = await readFile(join(dir, name))
			return new Int16Array(
				buf.buffer,
				buf.byteOffset + 44,
				(buf.length - 44) / 2,
			)
		}
		const aPcm = await bodyOf(files[0] ?? "")
		const bPcm = await bodyOf(files[1] ?? "")
		const samples = (2 * DV_TAP_SETTLE_MS * DV_TAP_SAMPLE_RATE_HZ) / 1000
		expect(aPcm.length).toBe(samples)
		expect(bPcm.length).toBe(samples)
		expect(aPcm.every(v => v === 1000)).toBe(true)
		expect(bPcm.every(v => v === 2000)).toBe(true)
		// Each file links to its own call; the two commits run concurrently, so in either order.
		expect(
			linked
				.map(l => [l.callId, l.key, l.durationMs])
				.sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
		).toEqual([
			["A", `dsd~${files[0]}`, 2 * DV_TAP_SETTLE_MS],
			["B", `dsd~${files[1]}`, 2 * DV_TAP_SETTLE_MS],
		])
		// The book is empty again: each call was forgotten once linked.
		expect(w.book.size()).toBe(0)
	})

	it("a shutdown while a call waits in the settle window finalizes it (reason shutdown) and links it", async () => {
		const { w, src, linked, dir } = await wired()
		const finals: (string | null)[] = []
		const call = new FakeCall(src, { callId: "S", slot: 2 })
		call.voice(DV_TAP_SETTLE_MS)
		// The decoder's end is in; the tap's end is still DV_TAP_SETTLE_MS away when the core stops.
		const counters = w.recorder?.counters()
		expect(counters?.active).toBe(1)
		await w.stop()
		finals.push(...(await readdir(dir)))
		expect(finals).toHaveLength(1)
		expect(linked.map(l => l.callId)).toEqual(["S"])
		expect(w.recorder?.counters().recorded).toBe(1)
	})

	it("a file cut by the cap links only once the call's end arrives", async () => {
		const { w, src, linked } = await wired({ maxCallMs: 1000, minVoiceMs: 0 })
		const call = new FakeCall(src, { callId: "L" })
		call.voice(1000 + DV_TAP_BLOCK_MAX_MS)
		await expect.poll(() => w.pendingLinks(), { timeout: 5000 }).toBe(1)
		expect(linked).toEqual([])
		call.end()
		await expect.poll(() => linked.length, { timeout: 5000 }).toBe(1)
		expect(w.pendingLinks()).toBe(0)
		await w.stop()
	})

	it("an encrypted call gives no file and no link; a decoder not listed keeps its file unlinked", async () => {
		const { w, src, linked, dir } = await wired()
		const enc = new FakeCall(src, { callId: "E" })
		enc.voice(1500)
		enc.state("encrypted")
		enc.end("end", "encrypted")
		const other = new FakeCall(src, { decoderId: "elsewhere", callId: "O" })
		other.voice(1500)
		other.end()
		await w.stop()
		const files = await readdir(dir)
		expect(files).toHaveLength(1)
		expect(files[0]).toContain("_elsewhere_")
		expect(linked).toEqual([])
		expect(w.unknownDecoder()).toBe(1)
	})

	it("stays off without a tap or when disabled", async () => {
		const root = await tmpRoot()
		const base = {
			stateDir: root,
			inventory: {},
			ingress: { linkRecording: () => undefined },
			decoderIds: () => [],
			outputs: null,
			protectionInstalled: () => true,
			logger,
		}
		const none = createDvCallRecorderWiring({
			...base,
			config: DvRecordCallsConfigSchema.parse({}),
			tapSource: null,
		})
		const off = createDvCallRecorderWiring({
			...base,
			config: DvRecordCallsConfigSchema.parse({ enabled: false }),
			tapSource: new FakeTapSource(),
		})
		for (const w of [none, off]) {
			expect(w.recorder).toBeNull()
			await w.start()
			await w.stop()
		}
		await expect(readdir(join(root, "recordings"))).rejects.toThrow()
	})
})
