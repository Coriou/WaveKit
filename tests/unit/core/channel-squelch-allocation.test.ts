/**
 * The channel squelch's steady state allocates nothing per muted block, an emitted block is never
 * rewritten later, and the live demodulator's block chunker carries a partial block without
 * copying the stream yet hands out the same blocks as the concat-and-copy loop it replaces.
 */

import { Transform } from "node:stream"
import fc from "fast-check"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	ChannelSquelch,
	SquelchBlockChunker,
} from "../../../src/core/channel-squelch.js"
import { LiveDemodulator } from "../../../src/core/live-demodulator.js"
import { ReferenceChannelSquelch } from "./channel-squelch-reference.js"

const RATE = 4000
const BLOCK_SAMPLES = 40
const BLOCK_BYTES = BLOCK_SAMPLES * 8

/** `blocks` blocks of a tone of `amplitude` (0 = silence) starting at `phase`. */
function tone(
	blocks: number,
	amplitude: number,
	phase: number,
	step = 0.21,
): Buffer {
	const out = Buffer.alloc(blocks * BLOCK_BYTES)
	for (let n = 0; n < blocks * BLOCK_SAMPLES; n++) {
		out.writeFloatLE(amplitude * Math.cos(phase + n * step), n * 8)
		out.writeFloatLE(amplitude * Math.sin(phase + n * step), n * 8 + 4)
	}
	return out
}

function noise(blocks: number, level: number, seed: number): Buffer {
	const out = Buffer.alloc(blocks * BLOCK_BYTES)
	let state = seed >>> 0 || 1
	for (let w = 0; w < out.length / 4; w++) {
		state ^= state << 13
		state ^= state >>> 17
		state ^= state << 5
		out.writeFloatLE(level * ((state >>> 0) / 4294967296 - 0.5), w * 4)
	}
	return out
}

/** A muted block repeats one complex sample. */
function isMuted(block: Buffer): boolean {
	for (let at = 8; at + 8 <= block.length; at += 8)
		if (block.compare(block, 0, 8, at, at + 8) !== 0) return false
	return block.length >= 8
}

afterEach(() => {
	vi.restoreAllMocks()
})

describe("ChannelSquelch output ownership", () => {
	it.each([false, true])(
		"never rewrites an emitted block across mute and unmute episodes (muteZeros %s)",
		muteZeros => {
			const squelch = new ChannelSquelch({
				sampleRate: RATE,
				thresholdDbfs: -30,
				hangMs: 20,
				muteZeros,
			})
			const held: { block: Buffer; copy: Buffer }[] = []
			const keep = (blocks: Buffer[]): void => {
				for (const block of blocks)
					held.push({ block, copy: Buffer.from(block) })
			}
			// Episodes end on different phases, so each mute holds a different fill vector; odd
			// chunk sizes make blocks straddle chunks (assembled in the carry buffer).
			const parts: Buffer[] = []
			for (let episode = 0; episode < 6; episode++) {
				parts.push(noise(7, 0.002, episode + 1))
				parts.push(tone(5 + episode, 0.3, episode * 1.3, 0.1 + episode * 0.05))
			}
			parts.push(noise(9, 0.002, 99))
			const stream = Buffer.concat(parts)
			const sizes = [
				BLOCK_BYTES,
				1,
				777,
				BLOCK_BYTES * 2 + 3,
				64,
				BLOCK_BYTES - 1,
			]
			let offset = 0
			for (let k = 0; offset < stream.length; k++) {
				const size = sizes[k % sizes.length]!
				keep(squelch.process(stream.subarray(offset, offset + size)))
				offset += size
			}
			keep(squelch.flush())
			expect(held.length).toBeGreaterThan(80)
			const fills = new Set<string>()
			for (const { block, copy } of held) {
				expect(block.equals(copy)).toBe(true)
				if (isMuted(copy)) fills.add(copy.subarray(0, 8).toString("hex"))
			}
			// The muted blocks took a fill vector per mute episode (hold mode), or zeros.
			if (muteZeros) expect([...fills]).toEqual(["0000000000000000"])
			else expect(fills.size).toBeGreaterThan(5)
		},
	)

	it("assembles a straddling pass-through block in a buffer it never reuses", () => {
		const squelch = new ChannelSquelch({
			sampleRate: RATE,
			thresholdDbfs: null,
		})
		const stream = noise(4, 0.2, 5)
		const half = BLOCK_BYTES / 2
		const first = squelch.process(stream.subarray(0, half))
		const second = squelch.process(stream.subarray(half, half + BLOCK_BYTES))
		const third = squelch.process(
			stream.subarray(half + BLOCK_BYTES, half + BLOCK_BYTES * 2),
		)
		expect(first).toEqual([])
		expect(second).toHaveLength(1)
		expect(third).toHaveLength(1)
		expect(second[0]!.equals(stream.subarray(0, BLOCK_BYTES))).toBe(true)
		expect(
			third[0]!.equals(stream.subarray(BLOCK_BYTES, BLOCK_BYTES * 2)),
		).toBe(true)
	})
})

describe("ChannelSquelch allocation guard", () => {
	it.each([false, true])(
		"emits one shared buffer for 2 000 whole muted blocks without allocating (muteZeros %s)",
		muteZeros => {
			const squelch = new ChannelSquelch({
				sampleRate: RATE,
				thresholdDbfs: -30,
				muteZeros,
			})
			const ref = new ReferenceChannelSquelch({
				sampleRate: RATE,
				thresholdDbfs: -30,
				muteZeros,
			})
			const blocks = noise(16, 0.002, 7)
			// Warm up outside the spies: the first muted block creates the shared buffer.
			squelch.process(blocks.subarray(0, BLOCK_BYTES))
			ref.process(blocks.subarray(0, BLOCK_BYTES))
			const concat = vi.spyOn(Buffer, "concat")
			const from = vi.spyOn(Buffer, "from")
			const alloc = vi.spyOn(Buffer, "alloc")
			const allocUnsafe = vi.spyOn(Buffer, "allocUnsafe")
			const allocUnsafeSlow = vi.spyOn(Buffer, "allocUnsafeSlow")
			const identities = new Set<Buffer>()
			let emitted = 0
			for (let n = 0; n < 2000; n++) {
				const at = (n % 16) * BLOCK_BYTES
				for (const out of squelch.process(
					blocks.subarray(at, at + BLOCK_BYTES),
				)) {
					identities.add(out)
					emitted++
				}
			}
			const calls = [concat, from, alloc, allocUnsafe, allocUnsafeSlow].map(
				spy => spy.mock.calls.length,
			)
			vi.restoreAllMocks()
			expect(squelch.open).toBe(false)
			expect(emitted).toBe(2000)
			expect(identities.size).toBe(1)
			expect(calls).toEqual([0, 0, 0, 0, 0])
			// The shared block holds what the old implementation emitted.
			const [shared] = [...identities]
			expect(
				shared!.equals(ref.process(blocks.subarray(0, BLOCK_BYTES))[0]!),
			).toBe(true)
		},
	)

	it("does not copy the stream when muted blocks straddle 4 KiB chunks", () => {
		const squelch = new ChannelSquelch({ sampleRate: RATE, thresholdDbfs: -30 })
		const chunker = new SquelchBlockChunker(BLOCK_BYTES)
		const stream = noise(400, 0.002, 11)
		const concat = vi.spyOn(Buffer, "concat")
		const from = vi.spyOn(Buffer, "from")
		const alloc = vi.spyOn(Buffer, "alloc")
		const identities = new Set<Buffer>()
		for (let offset = 0; offset < stream.length; offset += 4096) {
			chunker.push(stream.subarray(offset, offset + 4096), block => {
				for (const out of squelch.process(block)) identities.add(out)
			})
		}
		const calls = [concat, from].map(spy => spy.mock.calls.length)
		const allocs = alloc.mock.calls.length
		vi.restoreAllMocks()
		expect(calls).toEqual([0, 0])
		// One shared muted block, created on the first closed block.
		expect(allocs).toBe(1)
		expect(identities.size).toBe(1)
	})
})

/** The old chunking of the live demodulator (concat with the remainder, copy the tail). */
class ConcatChunker {
	private remainder = Buffer.alloc(0)
	constructor(private readonly blockBytes: number) {}
	push(chunk: Buffer, onBlock: (block: Buffer) => void): void {
		const data = this.remainder.length
			? Buffer.concat([this.remainder, chunk])
			: chunk
		let offset = 0
		while (data.length - offset >= this.blockBytes) {
			onBlock(data.subarray(offset, offset + this.blockBytes))
			offset += this.blockBytes
		}
		this.remainder = Buffer.from(data.subarray(offset))
	}
	reset(): void {
		const whole = this.remainder.length - (this.remainder.length % 8)
		if (whole !== this.remainder.length)
			this.remainder = Buffer.from(this.remainder.subarray(0, whole))
	}
	get pendingBytes(): number {
		return this.remainder.length
	}
	take(): Buffer {
		const tail = this.remainder
		this.remainder = Buffer.alloc(0)
		return tail
	}
}

describe("SquelchBlockChunker", () => {
	it("hands out the same blocks, alignment resets and tail as the concat loop", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 6 }).map(samples => samples * 8),
				fc.array(
					fc.oneof(fc.integer({ min: 0, max: 70 }), fc.constant(-1 as const)),
					{ minLength: 1, maxLength: 40 },
				),
				(blockBytes, steps) => {
					const next = new SquelchBlockChunker(blockBytes)
					const old = new ConcatChunker(blockBytes)
					let counter = 0
					for (const step of steps) {
						if (step === -1) {
							const before = next.pendingBytes
							next.dropPartial(8)
							old.reset()
							// Exactly the partial complex sample is dropped.
							expect(next.pendingBytes).toBe(before - (before % 8))
							expect(next.pendingBytes).toBe(old.pendingBytes)
							continue
						}
						const chunk = Buffer.alloc(step)
						for (let i = 0; i < step; i++) chunk[i] = counter++ & 0xff
						const a: Buffer[] = []
						const b: Buffer[] = []
						next.push(chunk, block => a.push(Buffer.from(block)))
						old.push(chunk, block => b.push(Buffer.from(block)))
						expect(a).toEqual(b)
						expect(next.pendingBytes).toBe(old.pendingBytes)
					}
					expect(next.take().equals(old.take())).toBe(true)
					expect(next.pendingBytes).toBe(0)
				},
			),
			{ numRuns: 200 },
		)
	})

	it("passes blocks inside a chunk as views and owns only the carry", () => {
		const chunker = new SquelchBlockChunker(16)
		const chunk = Buffer.alloc(40)
		const got: Buffer[] = []
		chunker.push(chunk, block => got.push(block))
		expect(got).toHaveLength(2)
		expect(got.every(block => block.buffer === chunk.buffer)).toBe(true)
		expect(got.some(block => chunker.ownsMemoryOf(block))).toBe(false)
		const straddling: Buffer[] = []
		chunker.push(Buffer.alloc(8), block => straddling.push(block))
		expect(straddling).toHaveLength(1)
		expect(chunker.ownsMemoryOf(straddling[0]!)).toBe(true)
	})
})

type MeasuredSquelchStream = (
	squelch: ChannelSquelch,
	sampleRate: number,
	measured: () => void,
	frontMeasured: () => void,
) => Transform

/** The old `measuredSquelchStream` transform (without the alignment sentinel), on the reference. */
function oldMeasuredStream(
	squelch: ReferenceChannelSquelch,
	sampleRate: number,
	measured: () => void,
): Transform {
	const blockBytes = Math.max(1, Math.round(sampleRate * 0.01)) * 8
	let remainder = Buffer.alloc(0)
	return new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			const data = remainder.length ? Buffer.concat([remainder, chunk]) : chunk
			let offset = 0
			while (data.length - offset >= blockBytes) {
				const output = squelch.process(
					data.subarray(offset, offset + blockBytes),
				)
				offset += blockBytes
				measured()
				for (const block of output) this.push(block)
			}
			remainder = Buffer.from(data.subarray(offset))
			callback()
		},
		flush(callback) {
			for (const block of squelch.process(remainder)) this.push(block)
			for (const block of squelch.flush()) this.push(block)
			remainder = Buffer.alloc(0)
			callback()
		},
	})
}

async function drive(
	stream: Transform,
	chunks: Buffer[],
): Promise<{ held: { block: Buffer; copy: Buffer }[] }> {
	const held: { block: Buffer; copy: Buffer }[] = []
	stream.on("data", (block: Buffer) =>
		held.push({ block, copy: Buffer.from(block) }),
	)
	const done = new Promise<void>((resolve, reject) => {
		stream.on("end", resolve)
		stream.on("error", reject)
	})
	for (const chunk of chunks) stream.write(chunk)
	stream.end()
	await done
	return { held }
}

describe("LiveDemodulator measured squelch stream", () => {
	const measuredSquelchStream = (
		LiveDemodulator.prototype as unknown as {
			measuredSquelchStream: MeasuredSquelchStream
		}
	).measuredSquelchStream

	it.each([
		["open", null],
		["gated", -30],
	] as const)(
		"emits the old blocks and measure calls for any chunking (%s), and its flush the tail",
		async (_label, thresholdDbfs) => {
			const options = { sampleRate: RATE, thresholdDbfs, hangMs: 20 }
			const parts = [
				noise(5, 0.002, 3),
				tone(6, 0.3, 0.4),
				noise(5, 0.002, 4),
				tone(4, 0.3, 2.1),
				noise(2, 0.002, 5),
			]
			const stream = Buffer.concat([...parts, tone(1, 0.3, 1).subarray(0, 123)])
			const sizes = [1, 333, BLOCK_BYTES, 4096, 77, BLOCK_BYTES * 2 + 1]
			const chunks: Buffer[] = []
			for (let offset = 0, k = 0; offset < stream.length; k++) {
				const size = sizes[k % sizes.length]!
				chunks.push(stream.subarray(offset, offset + size))
				offset += size
			}
			let measuredNext = 0
			let measuredOld = 0
			const next = await drive(
				measuredSquelchStream(
					new ChannelSquelch(options),
					RATE,
					() => measuredNext++,
					() => undefined,
				),
				chunks,
			)
			const old = await drive(
				oldMeasuredStream(
					new ReferenceChannelSquelch(options),
					RATE,
					() => measuredOld++,
				),
				chunks,
			)
			expect(measuredNext).toBe(Math.floor(stream.length / BLOCK_BYTES))
			expect(measuredNext).toBe(measuredOld)
			expect(next.held.map(h => h.copy.toString("hex"))).toEqual(
				old.held.map(h => h.copy.toString("hex")),
			)
			// The tail (123 bytes) leaves on flush.
			expect(next.held.at(-1)!.copy.length).toBe(123)
			// Nothing emitted was rewritten afterwards (straddling blocks were copied out).
			for (const { block, copy } of next.held)
				expect(block.equals(copy)).toBe(true)
		},
	)
})
