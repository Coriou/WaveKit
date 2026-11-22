/**
 * The channel squelch after the allocation change (aligned float32 scratch, shared muted blocks,
 * a preallocated carry instead of `Buffer.concat`) is byte-identical to the implementation it
 * replaces (`channel-squelch-reference.ts`): the same generated IQ stream, cut into the same
 * random chunks and driven by the same runtime calls, gives the same emitted blocks in the same
 * order and the same public readings after every chunk, for every mode and option combination.
 */

import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	ChannelSquelch,
	type ChannelSquelchOptions,
} from "../../../src/core/channel-squelch.js"
import { ReferenceChannelSquelch } from "./channel-squelch-reference.js"

type Squelch = ChannelSquelch | ReferenceChannelSquelch

/** Byte length of one 10 ms gate block. */
function gateBlockBytes(sampleRate: number): number {
	return Math.max(1, Math.round(sampleRate * 0.01)) * 8
}

type SegmentKind = "noise" | "carrier" | "silence" | "special"

interface Segment {
	kind: SegmentKind
	blocks: number
	level: number
}

type RunOp =
	| { kind: "floor"; value: number | null }
	| { kind: "threshold"; value: number | null }
	| { kind: "detectOnly"; value: boolean }
	| { kind: "observer"; value: boolean }
	| { kind: "evidence"; value: boolean }
	| { kind: "mode"; value: "power" | "noise" }
	| { kind: "quieting"; value: number }
	| { kind: "reset" }

/** Raw float32 words: NaN payloads, ±Infinity, denormals, -0, the largest finite. */
const SPECIAL_WORDS = [
	0x7fc00001, 0xffc12345, 0x7f800001, 0x7f800000, 0xff800000, 0x00000001,
	0x807fffff, 0x80000000, 0x7f7fffff,
]

function mulberry32(seed: number): () => number {
	let a = seed >>> 0
	return () => {
		a = (a + 0x6d2b79f5) >>> 0
		let t = a
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

/**
 * Renders the segments as complex float32 LE IQ (deterministic for a seed), then `tailBytes`
 * (0 to one block less one byte) more of the last segment's kind, so the stream can end with a
 * partial block and a partial sample that only `flush` releases.
 */
function renderStream(
	segmentsIn: Segment[],
	seed: number,
	sampleRate: number,
	tailBytes: number,
): Buffer {
	const blockBytes = gateBlockBytes(sampleRate)
	const lastSegment = segmentsIn[segmentsIn.length - 1]
	const segments =
		lastSegment === undefined
			? segmentsIn
			: [...segmentsIn, { ...lastSegment, blocks: 1 }]
	let total = 0
	for (const segment of segments) total += segment.blocks * blockBytes
	const whole = total - (lastSegment === undefined ? 0 : blockBytes)
	const out = Buffer.alloc(total)
	const random = mulberry32(seed)
	let phase = random() * 2 * Math.PI
	let offset = 0
	for (const segment of segments) {
		const end = offset + segment.blocks * blockBytes
		const step = 0.05 + random() * 0.3
		for (; offset < end; offset += 8) {
			let i = 0
			let q = 0
			if (segment.kind === "carrier") {
				phase += step
				i = segment.level * Math.cos(phase) + 0.002 * (random() - 0.5)
				q = segment.level * Math.sin(phase) + 0.002 * (random() - 0.5)
			} else if (segment.kind !== "silence") {
				i = segment.level * (2 * random() - 1)
				q = segment.level * (2 * random() - 1)
			}
			out.writeFloatLE(i, offset)
			out.writeFloatLE(q, offset + 4)
			if (segment.kind === "special" && random() < 0.2) {
				const word = SPECIAL_WORDS[Math.floor(random() * SPECIAL_WORDS.length)]!
				out.writeUInt32LE(word, offset + (random() < 0.5 ? 0 : 4))
			}
		}
	}
	return out.subarray(0, whole + tailBytes)
}

const SAMPLE_RATE = 4000
const BLOCK_BYTES = gateBlockBytes(SAMPLE_RATE)

const segmentArbitrary: fc.Arbitrary<Segment> = fc.record({
	kind: fc.constantFrom<SegmentKind>(
		"noise",
		"carrier",
		"carrier",
		"silence",
		"special",
	),
	blocks: fc.integer({ min: 1, max: 25 }),
	level: fc.constantFrom(0.003, 0.01, 0.03, 0.1, 0.3, 0.6),
})

const opArbitrary: fc.Arbitrary<RunOp> = fc.oneof(
	fc.record({
		kind: fc.constant("floor" as const),
		value: fc.constantFrom(null, -60, -45, -33),
	}),
	fc.record({
		kind: fc.constant("threshold" as const),
		value: fc.constantFrom(null, -40, -30, -20),
	}),
	fc.record({ kind: fc.constant("detectOnly" as const), value: fc.boolean() }),
	fc.record({ kind: fc.constant("observer" as const), value: fc.boolean() }),
	fc.record({ kind: fc.constant("evidence" as const), value: fc.boolean() }),
	fc.record({
		kind: fc.constant("mode" as const),
		value: fc.constantFrom<"power" | "noise">("power", "noise"),
	}),
	fc.record({
		kind: fc.constant("quieting" as const),
		value: fc.constantFrom(3, 6, 12, 20),
	}),
	fc.record({ kind: fc.constant("reset" as const) }),
)

/**
 * Chunk sizes: mostly exactly one block (the live demodulator's only path, the whole-block fast
 * path when nothing is pending), sometimes whole multiples, sometimes any size up to three blocks.
 */
const chunkSizeArbitrary = fc.oneof(
	{ weight: 12, arbitrary: fc.constant(BLOCK_BYTES) },
	{
		weight: 1,
		arbitrary: fc.integer({ min: 2, max: 3 }).map(k => k * BLOCK_BYTES),
	},
	{ weight: 2, arbitrary: fc.integer({ min: 1, max: BLOCK_BYTES * 3 + 7 }) },
)

/** The stream's tail after its whole blocks: none, whole samples, or any partial block. */
const tailArbitrary = fc.oneof(
	{ weight: 1, arbitrary: fc.constant(0) },
	{
		weight: 1,
		arbitrary: fc.integer({ min: 1, max: BLOCK_BYTES / 8 - 1 }).map(k => k * 8),
	},
	{ weight: 3, arbitrary: fc.integer({ min: 1, max: BLOCK_BYTES - 1 }) },
)

const optionsArbitrary = fc.record({
	thresholdDbfs: fc.constantFrom(null, -40, -30, -30, -20),
	hangMs: fc.constantFrom(10, 30, 60, 250),
	hysteresisDb: fc.constantFrom(1, 2, 4),
	mode: fc.constantFrom<"power" | "noise">("power", "power", "noise"),
	muteZeros: fc.constantFrom(false, false, true),
	detectOnly: fc.constantFrom(false, false, false, true),
	carrierObserver: fc.boolean(),
	carrierEvidence: fc.boolean(),
	pcmLeadSamples: fc.constantFrom(0, 0, 7, 33),
	noiseQuietingDb: fc.constantFrom(3, 6, 12),
})

const equivalenceRunArbitrary = fc.record({
	options: optionsArbitrary.map(
		(o): ChannelSquelchOptions => ({
			sampleRate: SAMPLE_RATE,
			bandwidthHz: SAMPLE_RATE / 2,
			...o,
		}),
	),
	segments: fc.array(segmentArbitrary, { minLength: 4, maxLength: 12 }),
	seed: fc.integer({ min: 0, max: 0x7fffffff }),
	tail: tailArbitrary,
	chunks: fc.array(chunkSizeArbitrary, { minLength: 1, maxLength: 8 }),
	ops: fc.array(fc.record({ after: fc.nat(120), op: opArbitrary }), {
		maxLength: 10,
	}),
})

/** Every public reading, compared with `Object.is` (NaN equals NaN, -0 differs from 0). */
function compareReadings(next: Squelch, ref: Squelch, where: string): void {
	const pairs: [string, unknown, unknown][] = [
		["open", next.open, ref.open],
		["powerDbfs", next.powerDbfs, ref.powerDbfs],
		["mode", next.mode, ref.mode],
		["noiseQuietingDb", next.noiseQuietingDb, ref.noiseQuietingDb],
		[
			"noiseQuietingLevelDb",
			next.noiseQuietingLevelDb,
			ref.noiseQuietingLevelDb,
		],
		["blockQuieted", next.blockQuieted(), ref.blockQuieted()],
		["blockCarrier", next.blockCarrier(), ref.blockCarrier()],
		["hasCarrierObserver", next.hasCarrierObserver, ref.hasCarrierObserver],
		["hasCarrierEvidence", next.hasCarrierEvidence, ref.hasCarrierEvidence],
		["detectOnly", next.detectOnly, ref.detectOnly],
		["mutesClosedPcm", next.mutesClosedPcm, ref.mutesClosedPcm],
		["closedSpansInFlight", next.closedSpansInFlight, ref.closedSpansInFlight],
	]
	for (const [name, a, b] of pairs)
		if (!Object.is(a, b))
			throw new Error(`${where}: ${name} ${String(a)} vs ${String(b)}`)
}

function applyOp(squelch: Squelch, op: RunOp): void {
	switch (op.kind) {
		case "floor":
			squelch.setNoiseFloorDbfs(op.value)
			return
		case "threshold":
			squelch.setThreshold(op.value)
			return
		case "detectOnly":
			squelch.setDetectOnly(op.value)
			return
		case "observer":
			squelch.setCarrierObserver(op.value)
			return
		case "evidence":
			squelch.setCarrierEvidence(op.value)
			return
		case "mode":
			squelch.setMode(op.value)
			return
		case "quieting":
			squelch.setNoiseQuietingDb(op.value)
			return
		case "reset":
			squelch.resetGate()
	}
}

function isNanWord(word: number): boolean {
	return (word & 0x7f800000) === 0x7f800000 && (word & 0x007fffff) !== 0
}

/** What the reference did for one emitted block, read from its state around `emitBlock`. */
interface BlockNote {
	/** Passed IQ rotated by a rotation that is not the identity. */
	rotated: boolean
	/** A held-vector mute whose fill is NaN. */
	nanFill: boolean
	/** Closed with `muteZeros` (exact zeros). */
	zeroMute: boolean
	/** A held-vector mute (closed without `muteZeros`). */
	heldMute: boolean
	/** The block ends with a partial complex sample. */
	partialSample: boolean
}

interface ReferenceInternals {
	gateOpen: boolean
	detectOnlyEnabled: boolean
	muteZeros: boolean
	rotCos: number
	rotSin: number
	fillI: number
	fillQ: number
	emitBlock(block: Buffer): Buffer
}

/** Wraps the reference's `emitBlock` so every emitted block leaves a note, in emission order. */
function instrumentReference(ref: ReferenceChannelSquelch): BlockNote[] {
	const internals = ref as unknown as ReferenceInternals
	const emit = internals.emitBlock.bind(ref)
	const notes: BlockNote[] = []
	internals.emitBlock = (block: Buffer): Buffer => {
		const passing = internals.gateOpen || internals.detectOnlyEnabled
		const out = emit(block)
		const mutesZeros = internals.muteZeros
		notes.push({
			rotated:
				passing &&
				!mutesZeros &&
				block.length >= 8 &&
				(internals.rotCos !== 1 || internals.rotSin !== 0),
			nanFill:
				!passing &&
				!mutesZeros &&
				(Number.isNaN(internals.fillI) || Number.isNaN(internals.fillQ)),
			zeroMute: !passing && mutesZeros,
			heldMute: !passing && !mutesZeros,
			partialSample: block.length % 8 !== 0,
		})
		return out
	}
	return notes
}

function pendingOf(squelch: ChannelSquelch): number {
	return (squelch as unknown as { pendingBytes: number }).pendingBytes
}

/** A block the new class emitted, with a copy of its bytes taken at emission. */
interface KeptBlock {
	block: Buffer
	copy: Buffer
	where: string
}

function keep(kept: KeptBlock[], blocks: Buffer[], where: string): void {
	for (const block of blocks)
		kept.push({ block, copy: Buffer.from(block), where })
}

/** No emitted block was rewritten later (a reused carry, scratch or shared mute buffer). */
function expectKeptUnchanged(kept: KeptBlock[]): void {
	for (const [k, entry] of kept.entries())
		if (!entry.block.equals(entry.copy))
			throw new Error(`${entry.where}: kept block ${k} was overwritten later`)
}

/**
 * Same blocks in the same order, byte-identical (`a.equals(b)`), with one exception: in a block
 * the reference emitted while its rotation was not the identity (`rotCos !== 1 || rotSin !== 0`,
 * rotated output), or in a muted fill whose fill itself is NaN, two NaN words match whatever
 * their payloads. The payload of a NaN computed from NaN operands (`i * cos - q * sin` with a NaN
 * sample or a NaN rotation) is not a property of the source: the previous implementation's
 * readFloatLE/writeFloatLE loop itself emits different payloads for the same input before and
 * after V8 optimises it. Everywhere else (pass-through, zero mutes, finite fills) the bytes are
 * copied, not computed, and must be identical.
 */
function expectSameBlocks(
	next: Buffer[],
	ref: Buffer[],
	notes: BlockNote[],
	where: string,
): void {
	if (next.length !== ref.length)
		throw new Error(`${where}: ${next.length} blocks vs ${ref.length}`)
	if (notes.length !== ref.length)
		throw new Error(`${where}: ${notes.length} notes for ${ref.length} blocks`)
	for (let k = 0; k < next.length; k++) {
		const a = next[k]!
		const b = ref[k]!
		const note = notes[k]!
		if (a.length !== b.length)
			throw new Error(
				`${where}: block ${k} is ${a.length} bytes vs ${b.length}`,
			)
		if (a.equals(b)) continue
		if (!note.rotated && !note.nanFill)
			throw new Error(
				`${where}: block ${k} differs (not rotated, finite fill): ${a.toString("hex")} vs ${b.toString("hex")}`,
			)
		const words = a.length >> 2
		for (let w = 0; w < words; w++) {
			const x = a.readUInt32LE(w * 4)
			const y = b.readUInt32LE(w * 4)
			if (x !== y && !(isNanWord(x) && isNanWord(y)))
				throw new Error(
					`${where}: block ${k} word ${w}: ${x.toString(16)} vs ${y.toString(16)}`,
				)
		}
		for (let i = words * 4; i < a.length; i++)
			if (a[i] !== b[i])
				throw new Error(`${where}: block ${k} byte ${i} differs`)
	}
}

/** Drives one `process`/`flush` call on both and compares the blocks; returns the reference's notes. */
function compareCall(
	callNext: () => Buffer[],
	callRef: () => Buffer[],
	notes: BlockNote[],
	kept: KeptBlock[],
	where: string,
): { ref: Buffer[]; notes: BlockNote[] } {
	const outNext = callNext()
	keep(kept, outNext, where)
	notes.length = 0
	const outRef = callRef()
	const callNotes = notes.splice(0)
	expectSameBlocks(outNext, outRef, callNotes, where)
	return { ref: outRef, notes: callNotes }
}

describe("ChannelSquelch equivalence with the implementation it replaces", () => {
	it("emits the same bytes and readings for any stream, chunking and option set", () => {
		// Shares of runs (tuned generator, asserted below): the gate opens at least once from
		// closed, passed IQ is rotated after an unmute, the stream ends with a tail that is not a
		// whole number of samples (so `flush` releases a partial sample), and at least 50
		// consecutive chunks of exactly one block arrive with nothing pending (the fast path).
		// Measured: opened about 73 %, rotated 40 to 46 %, partial-sample tail about 54 %, fast path
		// 38 % (17 % before one-block chunks were weighted up); out of 250 runs the flush releases a
		// partial sample as a zero mute about 13 times, as a held-vector mute 23 to 28 and rotated
		// 29 to 33.
		let runs = 0
		let opened = 0
		let rotated = 0
		let partialTails = 0
		let fastPathRuns = 0
		let zeroMuteFlushes = 0
		let heldPartialFlushes = 0
		let rotatedPartialFlushes = 0
		fc.assert(
			fc.property(equivalenceRunArbitrary, run => {
				const options: ChannelSquelchOptions = { ...run.options }
				const next = new ChannelSquelch(options)
				const ref = new ReferenceChannelSquelch(options)
				const notes = instrumentReference(ref)
				const kept: KeptBlock[] = []
				const stream = renderStream(
					run.segments,
					run.seed,
					options.sampleRate,
					run.tail,
				)
				let sawClosed = false
				let sawOpen = false
				let sawRotation = false
				let offset = 0
				let chunkIndex = 0
				let pcmPosition = 0
				let streak = 0
				let longestStreak = 0
				const width = 2
				while (offset < stream.length) {
					const size = run.chunks[chunkIndex % run.chunks.length]!
					const chunk = stream.subarray(offset, offset + size)
					offset += chunk.length
					if (pendingOf(next) === 0 && chunk.length === BLOCK_BYTES) {
						streak++
						longestStreak = Math.max(longestStreak, streak)
					} else streak = 0
					const where = `chunk ${chunkIndex}`
					const { ref: outRef } = compareCall(
						() => next.process(chunk),
						() => ref.process(chunk),
						notes,
						kept,
						where,
					)
					compareReadings(next, ref, where)
					// A19: the same PCM bytes are muted.
					let samples = 0
					for (const block of outRef) samples += Math.floor(block.length / 8)
					const pcmNext = Buffer.alloc(samples * width, 0xab)
					const pcmRef = Buffer.alloc(samples * width, 0xab)
					next.muteClosedPcm(pcmNext, pcmPosition, width)
					ref.muteClosedPcm(pcmRef, pcmPosition, width)
					pcmPosition += samples * width
					if (!pcmNext.equals(pcmRef))
						throw new Error(`chunk ${chunkIndex}: muted PCM differs`)
					if (ref.open) sawOpen = sawOpen || sawClosed
					else sawClosed = true
					const rot = ref as unknown as { rotCos: number; rotSin: number }
					if (rot.rotCos !== 1 || rot.rotSin !== 0) sawRotation = true
					for (const step of run.ops) {
						if (step.after !== chunkIndex) continue
						applyOp(next, step.op)
						applyOp(ref, step.op)
					}
					compareReadings(next, ref, `after ops ${chunkIndex}`)
					chunkIndex++
				}
				if (pendingOf(next) !== run.tail)
					throw new Error(`pending ${pendingOf(next)} vs tail ${run.tail}`)
				const flushed = compareCall(
					() => next.flush(),
					() => ref.flush(),
					notes,
					kept,
					"flush",
				)
				compareReadings(next, ref, "flush")
				compareCall(
					() => next.flush(),
					() => ref.flush(),
					notes,
					kept,
					"second flush",
				)
				compareReadings(next, ref, "second flush")
				expectKeptUnchanged(kept)
				if (flushed.ref.length !== (run.tail > 0 ? 1 : 0))
					throw new Error(`flush gave ${flushed.ref.length} blocks`)
				const tailNote = flushed.notes[0]
				if (tailNote !== undefined && tailNote.partialSample) {
					if (tailNote.zeroMute) zeroMuteFlushes++
					if (tailNote.heldMute) heldPartialFlushes++
					if (tailNote.rotated) rotatedPartialFlushes++
				}
				runs++
				if (sawOpen) opened++
				if (sawRotation) rotated++
				if (run.tail % 8 !== 0) partialTails++
				if (longestStreak >= 50) fastPathRuns++
			}),
			{ numRuns: 250 },
		)
		expect(opened / runs).toBeGreaterThan(0.2)
		expect(rotated / runs).toBeGreaterThan(0.2)
		expect(partialTails / runs).toBeGreaterThanOrEqual(0.2)
		expect(fastPathRuns / runs).toBeGreaterThanOrEqual(0.2)
		// Each flush case named by the review occurs (a partial sample in every one).
		expect(zeroMuteFlushes).toBeGreaterThan(0)
		expect(heldPartialFlushes).toBeGreaterThan(0)
		expect(rotatedPartialFlushes).toBeGreaterThan(0)
	})

	it("reads and writes float32 exactly like readFloatLE and writeFloatLE, special values included", () => {
		// Every bit pattern class: NaN payloads (quiet and signalling), ±Infinity, denormals, ±0,
		// the largest finite and ordinary values, in a stream that opens, rotates and mutes and
		// ends with a partial block (tail) that `flush` releases.
		const sampleRate = 4000
		const blockBytes = gateBlockBytes(sampleRate)
		const specials = [
			0x7fc00001, 0xffc12345, 0x7f800001, 0xff800001, 0x7f800000, 0xff800000,
			0x00000001, 0x807fffff, 0x80000000, 0x00000000, 0x7f7fffff, 0x3e99999a,
		]
		let partialTails = 0
		let runs = 0
		fc.assert(
			fc.property(
				fc.array(fc.integer({ min: 0, max: 0xffffffff }), {
					minLength: 1,
					maxLength: 40,
				}),
				fc.integer({ min: 1, max: blockBytes * 2 + 3 }),
				fc.boolean(),
				fc.integer({ min: 0, max: blockBytes - 1 }),
				(raw, chunk, muteZeros, tail) => {
					const options: ChannelSquelchOptions = {
						sampleRate,
						thresholdDbfs: -30,
						hangMs: 20,
						muteZeros,
					}
					const next = new ChannelSquelch(options)
					const ref = new ReferenceChannelSquelch(options)
					const notes = instrumentReference(ref)
					const kept: KeptBlock[] = []
					const blocks = 24
					const stream = Buffer.alloc(blocks * blockBytes + tail)
					const wordCount = Math.floor(stream.length / 4)
					for (let w = 0; w < wordCount; w++) {
						const block = Math.floor((w * 4) / blockBytes)
						const loud = block % 6 < 3
						const angle = w * 0.37 + block
						const value = loud
							? 0.3 * (w % 2 === 0 ? Math.cos(angle) : Math.sin(angle))
							: 0.001 * Math.sin(w)
						stream.writeFloatLE(value, w * 4)
					}
					for (let k = 0; k < raw.length; k++) {
						const word = (raw[k]! * 7 + k * 131) % wordCount
						const bits = specials[raw[k]! % specials.length]!
						stream.writeUInt32LE(raw[k]! % 3 === 0 ? raw[k]! : bits, word * 4)
					}
					for (let offset = 0; offset < stream.length; offset += chunk) {
						const part = stream.subarray(offset, offset + chunk)
						compareCall(
							() => next.process(part),
							() => ref.process(part),
							notes,
							kept,
							"special",
						)
						compareReadings(next, ref, "special")
					}
					compareCall(
						() => next.flush(),
						() => ref.flush(),
						notes,
						kept,
						"special flush",
					)
					compareCall(
						() => next.flush(),
						() => ref.flush(),
						notes,
						kept,
						"special second flush",
					)
					expectKeptUnchanged(kept)
					runs++
					if (tail % 8 !== 0) partialTails++
				},
			),
			{ numRuns: 200 },
		)
		expect(partialTails / runs).toBeGreaterThanOrEqual(0.2)
	})
})
