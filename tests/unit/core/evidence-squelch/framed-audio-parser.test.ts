/**
 * A18 framed demod audio parser (docs/specs/evidence-squelch requirements 9.2-9.7, 9.10): chunk
 * independence, bounds, unknown types, the two fault classes and the parse cost.
 */
import { performance } from "node:perf_hooks"
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	FramedAudioParser,
	WKAF_FLAG_BURST_START,
	WKAF_FLAG_GATE_OPEN,
	WKAF_T_BLOCK,
	WKAF_T_DROP,
	WKAF_T_GATE_OPEN,
	WKAF_T_PCM,
	WKAF_T_RESET,
	minFramedQueueBytes,
	type FramedAudioFault,
	type FramedMarker,
} from "../../../../src/core/evidence-squelch/framed-audio-parser.js"
import { DEMOD_QUEUE_BYTES } from "../../../../src/core/live-demod/rust-protocol.js"
import {
	chunked,
	discontinuityPayload,
	encodeFramed,
	header,
	preamble,
	type Step,
} from "./framed-harness.js"

type Entry = { pcm: string } | FramedMarker | { fault: FramedAudioFault }

/** Parses `chunks`; consecutive PCM views are merged so entries compare across chunkings. */
function parse(
	chunks: readonly Buffer[],
	format: "s16le" | "f32le" = "s16le",
): { entries: Entry[]; parser: FramedAudioParser; views: Buffer[] } {
	const entries: Entry[] = []
	const views: Buffer[] = []
	let pcm: Buffer[] = []
	const flush = (): void => {
		if (pcm.length > 0)
			entries.push({ pcm: Buffer.concat(pcm).toString("hex") })
		pcm = []
	}
	const parser = new FramedAudioParser(format, {
		pcm: view => {
			views.push(view)
			pcm.push(Buffer.from(view))
		},
		marker: marker => {
			flush()
			entries.push(marker)
		},
		fault: fault => {
			flush()
			entries.push({ fault })
		},
	})
	for (const chunk of chunks) parser.push(chunk)
	flush()
	return { entries, parser, views }
}

function faults(entries: Entry[]): FramedAudioFault[] {
	return entries.flatMap(e => ("fault" in e ? [e.fault] : []))
}

const pcm = (samples: number, fill = 0x11): Step => ({
	kind: "pcm",
	bytes: Buffer.alloc(samples * 2, fill),
})

/** Random valid step sequences: gate markers alternate and never repeat a RESET/DROP flag. */
const stepsArb = fc
	.array(
		fc.oneof(
			{
				weight: 4,
				arbitrary: fc
					.integer({ min: 1, max: 700 })
					.map(n => ({ t: "pcm" as const, n })),
			},
			{ weight: 2, arbitrary: fc.constant({ t: "gate" as const, n: 0 }) },
			{
				weight: 2,
				arbitrary: fc
					.double({ noNaN: false })
					.map(n => ({ t: "block" as const, n })),
			},
			{
				weight: 1,
				arbitrary: fc
					.integer({ min: 0, max: 7 })
					.map(n => ({ t: "reset" as const, n })),
			},
			{
				weight: 1,
				arbitrary: fc
					.integer({ min: 0, max: 7 })
					.map(n => ({ t: "drop" as const, n })),
			},
			{
				weight: 1,
				arbitrary: fc
					.integer({ min: 0, max: 64 })
					.map(n => ({ t: "ignorable" as const, n })),
			},
		),
		{ maxLength: 40 },
	)
	.map(raw => {
		let gate = false
		let fill = 1
		const steps: Step[] = []
		for (const r of raw) {
			if (r.t === "pcm") {
				steps.push({ kind: "pcm", bytes: Buffer.alloc(r.n * 2, fill++ & 0xff) })
			} else if (r.t === "gate") {
				gate = !gate
				steps.push({ kind: "gate", open: gate })
			} else if (r.t === "block") {
				steps.push({
					kind: "block",
					powerDbfs: -30,
					quietingDb: Math.fround(r.n),
				})
			} else if (r.t === "reset" || r.t === "drop") {
				gate = (r.n & 1) !== 0
				steps.push({ kind: r.t, count: r.n * 37, flags: r.n })
			} else
				steps.push({
					kind: "raw",
					type: 0x8000 + r.n,
					payload: Buffer.alloc(r.n, 0xee),
				})
		}
		return steps
	})

describe("A18 framed audio parser", () => {
	// Feature: evidence-squelch, Property 20: framed audio chunk independence
	// Validates: Requirements 9.4, 9.7
	it("any chunk split gives the same PCM, markers and positions as a one-chunk parse", () => {
		fc.assert(
			fc.property(
				stepsArb,
				fc.array(fc.nat(), { maxLength: 60 }),
				fc.boolean(),
				(steps, cutSeeds, oneByte) => {
					const bytes = encodeFramed(steps)
					const whole = parse([bytes])
					expect(faults(whole.entries)).toEqual([])
					const cuts = oneByte
						? Array.from({ length: bytes.length }, (_, i) => i)
						: cutSeeds.map(c => c % (bytes.length + 1))
					const split = parse(chunked(bytes, cuts))
					expect(split.entries).toEqual(whole.entries)
					expect(split.parser.position).toBe(whole.parser.position)
					// Every marker sits at the running position.
					let pos = 0
					for (const e of whole.entries) {
						if ("pcm" in e) pos += e.pcm.length / 4
						else if ("at" in e) {
							expect(e.at).toBe(pos)
							if (e.type === "drop") pos += e.count
						}
					}
				},
			),
			{ numRuns: 200 },
		)
	})

	// Feature: evidence-squelch, Property 21: split discontinuity markers parse as one marker
	// Validates: Requirements 9.4, 9.7
	it("a RESET and a DROP split after every payload byte (including byte 16) parse as one marker", () => {
		for (const kind of ["reset", "drop"] as const) {
			const steps: Step[] = [
				pcm(5),
				{ kind, count: 1234, flags: WKAF_FLAG_GATE_OPEN },
				pcm(3, 0x22),
			]
			const bytes = encodeFramed(steps)
			const payloadStart = 16 + 8 + 10 + 8
			const whole = parse([bytes]).entries
			expect(whole).toEqual([
				{ pcm: "11".repeat(10) },
				{ type: kind, at: 5, count: 1234, flags: 1 },
				{ pcm: "22".repeat(6) },
			])
			for (let k = 0; k <= 24; k++) {
				const split = parse(chunked(bytes, [payloadStart + k])).entries
				expect([k, split]).toEqual([k, whole])
			}
			const ones = parse(
				chunked(
					bytes,
					Array.from({ length: bytes.length }, (_, i) => i),
				),
			).entries
			expect(ones).toEqual(whole)
		}
	})

	it("PCM views alias the pushed chunk (no copy) and may split a sample", () => {
		const bytes = encodeFramed([pcm(4)])
		const { views } = parse([bytes.subarray(0, 27), bytes.subarray(27)])
		expect(views.map(v => v.length)).toEqual([3, 5])
		expect(views[0]?.buffer).toBe(bytes.buffer)
	})

	describe("bounds (9.4)", () => {
		const one = (records: Buffer[]): Entry[] =>
			parse([Buffer.concat([preamble("s16le", false), ...records])]).entries

		it("PCM 65 536 bytes passes; 65 538, 0 and a partial sample are framing errors", () => {
			expect(
				one([header(WKAF_T_PCM, 65_536), Buffer.alloc(65_536, 1)]),
			).toEqual([{ pcm: "01".repeat(65_536) }])
			expect(faults(one([header(WKAF_T_PCM, 65_538)]))).toEqual([
				{ kind: "framing", reason: "header-bound", frameType: 1, offset: 16 },
			])
			expect(faults(one([header(WKAF_T_PCM, 0)]))[0]?.reason).toBe(
				"header-bound",
			)
			expect(
				faults(one([header(WKAF_T_PCM, 3), Buffer.alloc(3)]))[0]?.reason,
			).toBe("pcm-partial")
			const f32 = parse(
				[Buffer.concat([preamble("f32le", false), header(WKAF_T_PCM, 6)])],
				"f32le",
			).entries
			expect(faults(f32)[0]?.reason).toBe("pcm-partial")
		})

		it("an ignorable payload of 64 bytes is skipped (also split byte by byte); 65 is a framing error", () => {
			const ok = Buffer.concat([
				preamble("s16le", false),
				header(0x8000, 64),
				Buffer.alloc(64, 0xab),
				header(WKAF_T_PCM, 2),
				Buffer.from([7, 0]),
			])
			const expected = [{ pcm: "0700" }]
			expect(parse([ok]).entries).toEqual(expected)
			expect(
				parse(
					chunked(
						ok,
						Array.from({ length: ok.length }, (_, i) => i),
					),
				).entries,
			).toEqual(expected)
			expect(faults(one([header(0x8000, 65)]))).toEqual([
				{
					kind: "framing",
					reason: "header-bound",
					frameType: 0x8000,
					offset: 16,
				},
			])
			expect(faults(one([header(9, 65)]))[0]?.reason).toBe("header-bound")
		})

		it("known marker types at their length pass; plus and minus one are framing errors", () => {
			const lengths: Array<[number, number]> = [
				[2, 8],
				[3, 8],
				[4, 24],
				[5, 24],
				[6, 16],
			]
			for (const [type, length] of lengths)
				for (const delta of [-1, 1])
					expect([
						type,
						delta,
						faults(one([header(type, length + delta)])),
					]).toEqual([
						type,
						delta,
						[
							{
								kind: "framing",
								reason: "payload-length",
								frameType: type,
								offset: 16,
							},
						],
					])
			const block = Buffer.alloc(16)
			block.writeFloatLE(-12.5, 8)
			block.writeFloatLE(Number.POSITIVE_INFINITY, 12)
			expect(one([header(WKAF_T_BLOCK, 16), block])).toEqual([
				{
					type: "block",
					at: 0,
					powerDbfs: -12.5,
					quietingDb: Number.POSITIVE_INFINITY,
				},
			])
		})

		it("the framed queue minimum is 74 / 76 bytes and the demod queue meets it", () => {
			expect(minFramedQueueBytes("s16le")).toBe(74)
			expect(minFramedQueueBytes("f32le")).toBe(76)
			expect(DEMOD_QUEUE_BYTES).toBeGreaterThanOrEqual(76)
		})
	})

	describe("unknown types and faults (9.5, 9.6)", () => {
		it("an ignorable type between PCM frames changes nothing", () => {
			const plain = encodeFramed([pcm(3), pcm(2, 0x33)])
			const withIgnorable = encodeFramed([
				pcm(3),
				{ kind: "raw", type: 0xffff, payload: Buffer.alloc(10, 9) },
				pcm(2, 0x33),
			])
			expect(parse([withIgnorable]).entries).toEqual(parse([plain]).entries)
		})

		it("unknown critical types fail safe as marker errors; PCM continues, markers stop", () => {
			for (const type of [0, 7, 0x7fff]) {
				const bytes = encodeFramed([
					pcm(2),
					{ kind: "raw", type, payload: Buffer.alloc(4) },
					pcm(2, 0x44),
					{ kind: "gate", open: true },
					{ kind: "raw", type: 9, payload: Buffer.alloc(0) },
					pcm(1, 0x55),
				])
				const { entries, parser } = parse([bytes])
				expect(entries).toEqual([
					{ pcm: "11".repeat(4) },
					{
						fault: {
							kind: "marker",
							reason: "unknown-critical",
							frameType: type,
							offset: 28,
						},
					},
					{ pcm: "44".repeat(4) + "5555" },
				])
				expect(parser.failed).toBe("marker")
				expect(parser.stage1Open).toBe(false)
			}
		})

		it("an index mismatch and a gate repeat are marker errors", () => {
			const at = Buffer.alloc(8)
			at.writeUInt32LE(3, 0)
			const mismatch = Buffer.concat([
				preamble("s16le", false),
				header(WKAF_T_PCM, 4),
				Buffer.alloc(4),
				header(WKAF_T_GATE_OPEN, 8),
				at,
			])
			expect(faults(parse([mismatch]).entries)).toEqual([
				{ kind: "marker", reason: "index-mismatch", frameType: 2, offset: 28 },
			])
			const repeat = encodeFramed(
				[
					pcm(1),
					{
						kind: "raw",
						type: WKAF_T_GATE_OPEN,
						payload: Buffer.from([1, 0, 0, 0, 0, 0, 0, 0]),
					},
				],
				{ gateOpen: true },
			)
			expect(faults(parse([repeat]).entries)[0]?.reason).toBe("gate-repeat")
			// A DROP after a RESET flag equal to the gate: no gate marker, no fault.
			const flagged = encodeFramed([
				{ kind: "reset", count: 0, flags: WKAF_FLAG_GATE_OPEN },
				pcm(1),
				{ kind: "gate", open: false },
			])
			expect(faults(parse([flagged]).entries)).toEqual([])
		})

		it("reserved bytes and a corrupted preamble are framing errors; nothing follows", () => {
			const reservedHeader = Buffer.concat([
				preamble("s16le", false),
				header(WKAF_T_PCM, 2, 1),
				Buffer.alloc(2, 1),
			])
			expect(parse([reservedHeader]).entries).toEqual([
				{
					fault: {
						kind: "framing",
						reason: "reserved",
						frameType: 1,
						offset: 16,
					},
				},
			])
			const tail = discontinuityPayload(0, 0, 0)
			tail[20] = 1
			const reservedDrop = Buffer.concat([
				preamble("s16le", false),
				header(WKAF_T_DROP, 24),
				tail,
				header(WKAF_T_PCM, 2),
				Buffer.alloc(2, 1),
			])
			expect(parse([reservedDrop]).entries).toEqual([
				{
					fault: {
						kind: "framing",
						reason: "reserved",
						frameType: 5,
						offset: 16,
					},
				},
			])
			const corrupt: Array<[number, number]> = [
				[0, 0x58],
				[4, 2],
				[6, 17],
				[8, 0x81],
				[12, 2],
				[13, 2],
				[14, 1],
				[15, 1],
			]
			for (const [index, value] of corrupt) {
				const bytes = encodeFramed([pcm(4)])
				bytes[index] = value
				for (const cuts of [
					[],
					[1, 9, 15],
					Array.from({ length: 30 }, (_, i) => i),
				]) {
					const { entries, parser } = parse(chunked(bytes, cuts))
					expect([index, entries]).toEqual([
						index,
						[
							{
								fault: {
									kind: "framing",
									reason: "preamble",
									frameType: null,
									offset: 0,
								},
							},
						],
					])
					expect(parser.failed).toBe("framing")
				}
			}
		})

		it("raw PCM after a valid echo is a preamble error, never reinterpreted as audio", () => {
			const raw = Buffer.alloc(9_600, 0x55)
			const { entries } = parse([raw.subarray(0, 7), raw.subarray(7)])
			expect(entries).toEqual([
				{
					fault: {
						kind: "framing",
						reason: "preamble",
						frameType: null,
						offset: 0,
					},
				},
			])
		})

		it("one fault notification per class; a framing error after a marker error still ends", () => {
			const bytes = Buffer.concat([
				encodeFramed([
					{ kind: "raw", type: 7, payload: Buffer.alloc(0) },
					{ kind: "raw", type: 8, payload: Buffer.alloc(0) },
					pcm(1),
				]),
				header(WKAF_T_PCM, 0),
				header(WKAF_T_PCM, 0),
			])
			const kinds = faults(parse([bytes]).entries).map(f => f.kind)
			expect(kinds).toEqual(["marker", "framing"])
		})

		it("a burst holds stage 1 closed until its closing record", () => {
			const states: boolean[] = []
			const parser = new FramedAudioParser("s16le", {
				pcm: () => states.push(parser.stage1Open),
				marker: () => undefined,
				fault: () => undefined,
			})
			parser.push(
				encodeFramed(
					[
						pcm(1),
						{
							kind: "reset",
							count: 1,
							flags: WKAF_FLAG_GATE_OPEN | WKAF_FLAG_BURST_START,
						},
						pcm(1),
						{ kind: "drop", count: 4, flags: WKAF_FLAG_GATE_OPEN },
						pcm(1),
						{ kind: "reset", count: 0, flags: 0 },
						pcm(1),
					],
					{ gateOpen: true },
				),
			)
			expect(states).toEqual([true, false, true, false])
			expect(parser.position).toBe(8)
		})

		describe("u64 fields past Number.MAX_SAFE_INTEGER (marker fault)", () => {
			const MAX = 2n ** 53n - 1n
			const u64 = (v: bigint): Buffer => {
				const b = Buffer.alloc(8)
				b.writeBigUInt64LE(v)
				return b
			}
			const drop = (at: bigint, count: bigint): Buffer => {
				const p = Buffer.alloc(24)
				u64(at).copy(p, 0)
				u64(count).copy(p, 8)
				return Buffer.concat([header(WKAF_T_DROP, 24), p])
			}
			const gateOpen = (at: bigint): Buffer =>
				Buffer.concat([header(WKAF_T_GATE_OPEN, 8), u64(at)])
			const run = (records: Buffer[]) => {
				const r = parse([Buffer.concat([preamble("s16le", false), ...records])])
				return {
					...r,
					markers: r.entries.filter(e => "type" in e),
					faults: faults(r.entries),
				}
			}

			it("2^53-1 is exact: DROP to it and a gate marker there pass", () => {
				const r = run([drop(0n, MAX), gateOpen(MAX)])
				expect(r.faults).toEqual([])
				expect(r.parser.position).toBe(Number.MAX_SAFE_INTEGER)
				expect(r.parser.stage1Open).toBe(true)
			})

			it("a DROP count of 2^53 fails safe; a later gate open at 2^53+1 does not open stage 1", () => {
				const r = run([
					drop(0n, MAX + 1n),
					gateOpen(MAX + 2n),
					header(WKAF_T_PCM, 2),
					Buffer.alloc(2, 9),
				])
				expect(r.faults).toEqual([
					{
						kind: "marker",
						reason: "index-mismatch",
						frameType: WKAF_T_DROP,
						offset: 16,
					},
				])
				expect(r.markers).toEqual([])
				expect(r.parser.stage1Open).toBe(false)
				expect(r.parser.failed).toBe("marker")
				// PCM still flows (A12 path).
				expect(r.entries.at(-1)).toEqual({ pcm: "0909" })
			})

			it("an at of 2^53 is an index mismatch", () => {
				const r = run([gateOpen(MAX + 1n)])
				expect(r.faults.map(f => f.reason)).toEqual(["index-mismatch"])
				expect(r.parser.stage1Open).toBe(false)
			})

			it("cumulative overflow across DROPs, and PCM past the limit, fail safe", () => {
				const half = 2n ** 52n
				const a = run([drop(0n, half), drop(half, half), gateOpen(2n * half)])
				expect(a.faults).toEqual([
					{
						kind: "marker",
						reason: "index-mismatch",
						frameType: WKAF_T_DROP,
						offset: 48,
					},
				])
				expect(a.markers).toHaveLength(1)
				expect(a.parser.stage1Open).toBe(false)
				const b = run([
					drop(0n, MAX),
					header(WKAF_T_PCM, 2),
					Buffer.alloc(2),
					gateOpen(MAX + 1n),
				])
				expect(b.faults).toEqual([
					{
						kind: "marker",
						reason: "index-mismatch",
						frameType: WKAF_T_PCM,
						offset: 48,
					},
				])
				expect(b.parser.stage1Open).toBe(false)
			})
		})

		it("RESET does not advance the position; DROP advances it by its count (0 allowed)", () => {
			const { entries } = parse([
				encodeFramed([
					pcm(2),
					{ kind: "reset", count: 99, flags: 0 },
					{ kind: "drop", count: 0, flags: 0 },
					{ kind: "drop", count: 10, flags: 0 },
					{
						kind: "raw",
						type: WKAF_T_RESET,
						payload: discontinuityPayload(12, 0, 0),
					},
				]),
			])
			expect(faults(entries)).toEqual([])
			expect(
				entries.filter(e => "type" in e).map(e => ("at" in e ? e.at : -1)),
			).toEqual([2, 2, 2, 12])
		})
	})

	it("parse cost per second of audio (micro-measure, printed, not asserted)", () => {
		// Rust's shape: one PCM record and one BLOCK per 10 ms, a gate pair every 260 ms.
		const seconds = 60
		const steps: Step[] = []
		const block = Buffer.alloc(960, 3)
		let gate = false
		for (let b = 0; b < seconds * 100; b++) {
			steps.push({ kind: "pcm", bytes: block })
			steps.push({ kind: "block", powerDbfs: -40, quietingDb: 20 })
			if (b % 26 === 0) {
				gate = !gate
				steps.push({ kind: "gate", open: gate })
			}
		}
		const bytes = encodeFramed(steps)
		const chunks = chunked(
			bytes,
			Array.from(
				{ length: Math.ceil(bytes.length / 4_096) },
				(_, i) => i * 4_096,
			),
		)
		const sink = {
			pcm: (_v: Buffer) => undefined,
			marker: (_m: FramedMarker) => undefined,
			fault: (_f: FramedAudioFault) => undefined,
		}
		for (let w = 0; w < 3; w++) {
			const p = new FramedAudioParser("s16le", sink)
			for (const c of chunks) p.push(c)
		}
		const runs = 10
		const t0 = performance.now()
		for (let r = 0; r < runs; r++) {
			const p = new FramedAudioParser("s16le", sink)
			for (const c of chunks) p.push(c)
		}
		const ms = (performance.now() - t0) / runs
		const overhead = (bytes.length - seconds * 96_000) / seconds
		console.info(
			`A18 parser: ${(ms / seconds).toFixed(4)} ms per second of s16 audio (${(ms / seconds / 10).toFixed(5)} core-%), framing overhead ${overhead.toFixed(0)} B/s (${((overhead / 96_000) * 100).toFixed(2)} % of s16), 4 KiB chunks`,
		)
		expect(ms).toBeGreaterThan(0)
	})
})
