/**
 * Test-only A18 helpers (docs/specs/evidence-squelch, design "Rust in-band gate markers"):
 *
 * - `encodeFramed`: a framed stream encoder mirroring `native/wavekit-chan/src/framing.rs`
 *   (preamble, 8-byte headers, little-endian payloads; positions computed as Rust does).
 * - `OrderedReference`: the canonical ordered-input reference. It feeds the evidence gate and
 *   pre-roll in sample order: the PCM up to each event, then the event. Its client bytes and
 *   verdicts define correct behaviour.
 * - `FramedConsumer`: the production framed consumer path below the socket: the real
 *   `FramedAudioParser`, `applyFramedMarker` and `processEvidenceChunk`.
 * - `CsdrConsumer`: the csdr shape: PCM chunks gated by stage 1 at arrival, block notes after
 *   the chunk that completes them (the documented skew).
 */
import { EVIDENCE_NOTE_DISCARD } from "../../../../src/core/evidence-squelch/contract.js"
import type { EvidenceGateOptions } from "../../../../src/core/evidence-squelch/contract.js"
import { EvidenceGate } from "../../../../src/core/evidence-squelch/evidence-gate.js"
import {
	FramedAudioParser,
	WKAF_FLAG_BURST_START,
	WKAF_FLAG_GATE_OPEN,
	WKAF_MAX_PCM_PAYLOAD,
	WKAF_T_BLOCK,
	WKAF_T_DROP,
	WKAF_T_GATE_CLOSE,
	WKAF_T_GATE_OPEN,
	WKAF_T_PCM,
	WKAF_T_RESET,
	type FramedAudioFault,
	type FramedMarker,
} from "../../../../src/core/evidence-squelch/framed-audio-parser.js"
import { PreRoll } from "../../../../src/core/evidence-squelch/pre-roll.js"
import {
	applyFramedMarker,
	processEvidenceChunk,
	type EvidenceWiring,
} from "../../../../src/core/evidence-squelch/wiring.js"

export const FRAMED_RATE = 48_000
export const FRAMED_BLOCK = 480

export type Step =
	| { kind: "pcm"; bytes: Buffer }
	| { kind: "gate"; open: boolean }
	| { kind: "block"; powerDbfs: number; quietingDb: number }
	| { kind: "reset"; count: number; flags: number }
	| { kind: "drop"; count: number; flags: number }
	/** Any frame, verbatim (type, reserved, payload). */
	| { kind: "raw"; type: number; payload: Buffer; reserved?: number }

export function header(type: number, length: number, reserved = 0): Buffer {
	const h = Buffer.alloc(8)
	h.writeUInt16LE(type, 0)
	h.writeUInt16LE(reserved, 2)
	h.writeUInt32LE(length, 4)
	return h
}

export function preamble(format: "s16le" | "f32le", gateOpen: boolean): Buffer {
	const p = Buffer.alloc(16)
	p.write("WKAF", 0, "latin1")
	p.writeUInt16LE(1, 4)
	p.writeUInt16LE(16, 6)
	p.writeUInt32LE(48_000, 8)
	p[12] = format === "s16le" ? 1 : 2
	p[13] = gateOpen ? 1 : 0
	return p
}

function u64(value: number): Buffer {
	const b = Buffer.alloc(8)
	b.writeBigUInt64LE(BigInt(value))
	return b
}

export function discontinuityPayload(
	at: number,
	count: number,
	flags: number,
): Buffer {
	const p = Buffer.alloc(24)
	u64(at).copy(p, 0)
	u64(count).copy(p, 8)
	p[16] = flags
	return p
}

/** Frames `steps` as Rust does; PCM steps longer than 65 536 bytes become several records. */
export function encodeFramed(
	steps: readonly Step[],
	options: { format?: "s16le" | "f32le"; gateOpen?: boolean } = {},
): Buffer {
	const format = options.format ?? "s16le"
	const width = format === "s16le" ? 2 : 4
	const parts: Buffer[] = [preamble(format, options.gateOpen ?? false)]
	let pos = 0
	for (const step of steps) {
		switch (step.kind) {
			case "pcm":
				for (let o = 0; o < step.bytes.length; o += WKAF_MAX_PCM_PAYLOAD) {
					const body = step.bytes.subarray(
						o,
						Math.min(step.bytes.length, o + WKAF_MAX_PCM_PAYLOAD),
					)
					parts.push(header(WKAF_T_PCM, body.length), body)
				}
				pos += step.bytes.length / width
				break
			case "gate":
				parts.push(
					header(step.open ? WKAF_T_GATE_OPEN : WKAF_T_GATE_CLOSE, 8),
					u64(pos),
				)
				break
			case "block": {
				const b = Buffer.alloc(16)
				u64(pos).copy(b, 0)
				b.writeFloatLE(step.powerDbfs, 8)
				b.writeFloatLE(step.quietingDb, 12)
				parts.push(header(WKAF_T_BLOCK, 16), b)
				break
			}
			case "reset":
			case "drop":
				parts.push(
					header(step.kind === "reset" ? WKAF_T_RESET : WKAF_T_DROP, 24),
					discontinuityPayload(pos, step.count, step.flags),
				)
				if (step.kind === "drop") pos += step.count
				break
			case "raw":
				parts.push(
					header(step.type, step.payload.length, step.reserved ?? 0),
					step.payload,
				)
				break
		}
	}
	return Buffer.concat(parts)
}

/** Splits `bytes` at sorted, deduplicated cut offsets. */
export function chunked(bytes: Buffer, cuts: readonly number[]): Buffer[] {
	const sorted = [...new Set(cuts)]
		.filter(c => c > 0 && c < bytes.length)
		.sort((a, b) => a - b)
	const out: Buffer[] = []
	let from = 0
	for (const c of [...sorted, bytes.length]) {
		out.push(Buffer.from(bytes.subarray(from, c)))
		from = c
	}
	return out
}

/** What a consumer observed: client bytes and the gate's verdicts, in input-sample terms. */
export interface Verdicts {
	client: Buffer
	/** Input-sample index of each latch (from `push`), in order. */
	latches: number[]
	/** Input samples pushed when each STE back-mute was taken, and its length. */
	steMutes: Array<{ at: number; back: number }>
	/** First and last non-zero client sample (s16), or -1. */
	firstPlayed: number
	lastPlayed: number
}

interface Probe {
	samples: number
	/** Stream byte offset of the chunk being processed. */
	chunkStart: number
	latches: number[]
	steMutes: Array<{ at: number; back: number }>
}

/** Real gate and pre-roll with probes on `push` and `takeSteBack`; positions in samples. */
function probedWiring(
	options: EvidenceGateOptions,
	probe: Probe,
): EvidenceWiring {
	const gate = new EvidenceGate(options)
	const push = gate.push.bind(gate)
	gate.push = (pcm, format, start, end): number => {
		const k = push(pcm, format, start, end)
		if (k >= 0) probe.latches.push(Math.floor((probe.chunkStart + k) / 2))
		probe.samples = Math.floor((probe.chunkStart + end) / 2)
		return k
	}
	const take = gate.takeSteBack.bind(gate)
	gate.takeSteBack = (): number => {
		const back = take()
		if (back > 0) probe.steMutes.push({ at: probe.samples, back })
		return back
	}
	return {
		gate,
		preRoll: new PreRoll({ rate: options.rate, format: "s16le" }),
		tailTag: "drop",
		aligned: false,
	}
}

function verdicts(out: Buffer[], probe: Probe): Verdicts {
	const client = Buffer.concat(out)
	let first = -1
	let last = -1
	for (let i = 0; i + 1 < client.length; i += 2)
		if (client.readInt16LE(i) !== 0) {
			if (first < 0) first = i / 2
			last = i / 2
		}
	return {
		client,
		latches: probe.latches,
		steMutes: probe.steMutes,
		firstPlayed: first,
		lastPlayed: last,
	}
}

function fullReset(wiring: EvidenceWiring): void {
	wiring.gate.reset()
	wiring.preRoll.clear()
	wiring.tailTag = "drop"
	wiring.aligned = false
}

/**
 * Canonical ordered-input reference (design, ordered reference). Written from the spec, not from
 * `applyFramedMarker`: stage-1 close before a latch resets and abandons; a block's carrier is noted
 * while stage 1 is open; RESET and DROP clear everything and set the flagged gate state; a burst
 * holds stage 1 closed until its closing record.
 */
export function orderedReference(
	steps: readonly Step[],
	options: EvidenceGateOptions,
	gateOpen = false,
): Verdicts {
	const probe: Probe = { samples: 0, chunkStart: 0, latches: [], steMutes: [] }
	const wiring = probedWiring(options, probe)
	const out: Buffer[] = []
	let open = gateOpen
	let burst = false
	let phase = 0
	let delivered = 0
	for (const step of steps) {
		if (step.kind === "pcm") {
			const chunk = Buffer.from(step.bytes)
			probe.chunkStart = delivered * 2
			processEvidenceChunk(
				wiring,
				chunk,
				phase,
				open && !burst,
				"s16le",
				options.rate,
			)
			phase = (phase + chunk.length) % 4
			delivered += chunk.length / 2
			out.push(chunk)
		} else if (step.kind === "gate") {
			open = step.open
			if (!open && wiring.gate.state === "waiting") {
				wiring.gate.reset()
				wiring.preRoll.abandon()
			}
		} else if (step.kind === "block") {
			if (open && !burst) {
				const carrier = !Number.isNaN(step.quietingDb) && step.quietingDb >= 6
				if ((wiring.gate.noteBlock(carrier) & EVIDENCE_NOTE_DISCARD) !== 0)
					wiring.preRoll.abandon()
			}
		} else if (step.kind === "reset" || step.kind === "drop") {
			fullReset(wiring)
			open = (step.flags & WKAF_FLAG_GATE_OPEN) !== 0
			burst = (step.flags & WKAF_FLAG_BURST_START) !== 0
		}
	}
	return verdicts(out, probe)
}

/** The production path below the socket for one framed byte stream, pushed in `chunks`. */
export function framedConsumer(
	chunks: readonly Buffer[],
	options: EvidenceGateOptions,
): Verdicts & { markers: FramedMarker[]; faults: FramedAudioFault[] } {
	const probe: Probe = { samples: 0, chunkStart: 0, latches: [], steMutes: [] }
	const wiring = probedWiring(options, probe)
	const out: Buffer[] = []
	const markers: FramedMarker[] = []
	const faults: FramedAudioFault[] = []
	let phase = 0
	let deliveredBytes = 0
	const parser: FramedAudioParser = new FramedAudioParser("s16le", {
		pcm: view => {
			probe.chunkStart = deliveredBytes
			// The client path rewrites the socket chunk in place (the views alias it).
			processEvidenceChunk(
				wiring,
				view,
				phase,
				parser.stage1Open,
				"s16le",
				options.rate,
			)
			phase = (phase + view.length) % 4
			deliveredBytes += view.length
			out.push(Buffer.from(view))
		},
		marker: marker => {
			markers.push(marker)
			applyFramedMarker(
				wiring,
				marker,
				parser.stage1Open,
				false,
				block => !Number.isNaN(block.quietingDb) && block.quietingDb >= 6,
				() => fullReset(wiring),
			)
		},
		fault: fault => faults.push(fault),
	})
	for (const chunk of chunks) parser.push(Buffer.from(chunk))
	return { ...verdicts(out, probe), markers, faults }
}

/**
 * The csdr shape: delivered PCM in fixed `chunkSamples` chunks, each gated by stage 1 at its
 * arrival (the state after every event before the chunk's first sample... as the stdout events
 * would have it), block notes taken after the chunk that holds the block's end.
 */
export function csdrConsumer(
	steps: readonly Step[],
	options: EvidenceGateOptions,
	chunkSamples: number,
): Verdicts {
	// Flatten to delivered samples with events at delivered positions.
	const pcm: Buffer[] = []
	const events: Array<{ at: number; step: Step }> = []
	let delivered = 0
	for (const step of steps) {
		if (step.kind === "pcm") {
			pcm.push(step.bytes)
			delivered += step.bytes.length / 2
		} else events.push({ at: delivered, step })
	}
	const all = Buffer.concat(pcm)
	const probe: Probe = { samples: 0, chunkStart: 0, latches: [], steMutes: [] }
	const wiring = probedWiring(options, probe)
	const out: Buffer[] = []
	let open = false
	let wasOpen = false
	let e = 0
	for (let s = 0; s * 2 < all.length; s += chunkSamples) {
		const end = Math.min(all.length / 2, s + chunkSamples)
		// Stage-1 edges at chunk arrival (the stdout gate event lands before the chunk).
		const blocks: boolean[] = []
		while (e < events.length && (events[e]?.at ?? Infinity) <= s) {
			const step = events[e]?.step
			e++
			if (step?.kind === "gate") open = step.open
			if (step?.kind === "reset" || step?.kind === "drop") {
				fullReset(wiring)
				open = (step.flags & WKAF_FLAG_GATE_OPEN) !== 0
			}
		}
		if (wasOpen && !open && wiring.gate.state === "waiting") {
			wiring.gate.reset()
			wiring.preRoll.abandon()
		}
		wasOpen = open
		const chunk = Buffer.from(all.subarray(s * 2, end * 2))
		probe.chunkStart = s * 2
		processEvidenceChunk(
			wiring,
			chunk,
			(s * 2) % 4,
			open,
			"s16le",
			options.rate,
		)
		out.push(chunk)
		// Blocks ending inside this chunk are noted after it (front-of-chain metrics).
		for (let k = e; k < events.length; k++) {
			const ev = events[k]
			if (ev === undefined || ev.at > end) break
			if (ev.step.kind === "block")
				blocks.push(
					!Number.isNaN(ev.step.quietingDb) && ev.step.quietingDb >= 6,
				)
		}
		if (open)
			for (const carrier of blocks)
				if ((wiring.gate.noteBlock(carrier) & EVIDENCE_NOTE_DISCARD) !== 0)
					wiring.preRoll.abandon()
		// Consume the blocks now noted so the arrival loop skips them.
		while (
			e < events.length &&
			(events[e]?.at ?? Infinity) <= end &&
			events[e]?.step.kind === "block"
		)
			e++
	}
	return verdicts(out, probe)
}

export interface OverSegment {
	/** Delivered PCM of this segment (already zero where Rust's stage 1 is closed). */
	pcm: Float32Array
	open: boolean
	/** Per-block quieting while this segment plays (NaN: none). */
	quietingDb: number
}

/**
 * Steps for consecutive segments, Rust-shaped: one PCM record per 10 ms block, the BLOCK record
 * at each block end and the gate marker for the next segment's state after it. Segment lengths
 * are whole blocks. `inserts` places discontinuities after the given delivered sample (they
 * split the PCM record there).
 */
export function overSteps(
	segments: readonly OverSegment[],
	inserts: ReadonlyArray<{ at: number; step: Step }> = [],
): Step[] {
	const steps: Step[] = []
	let gate = false
	let delivered = 0
	const pending = [...inserts].sort((a, b) => a.at - b.at)
	for (const seg of segments) {
		if (seg.open !== gate) {
			steps.push({ kind: "gate", open: seg.open })
			gate = seg.open
		}
		const bytes = toS16(seg.pcm)
		for (let o = 0; o < bytes.length; o += FRAMED_BLOCK * 2) {
			const block = bytes.subarray(
				o,
				Math.min(bytes.length, o + FRAMED_BLOCK * 2),
			)
			let from = 0
			const blockStart = delivered
			while (
				pending.length > 0 &&
				(pending[0]?.at ?? Infinity) < blockStart + block.length / 2
			) {
				const insert = pending.shift()
				if (insert === undefined) break
				const cut = (insert.at - blockStart) * 2
				if (cut > from)
					steps.push({ kind: "pcm", bytes: block.subarray(from, cut) })
				steps.push(insert.step)
				if (insert.step.kind === "reset" || insert.step.kind === "drop")
					gate = (insert.step.flags & WKAF_FLAG_GATE_OPEN) !== 0
				from = cut
			}
			if (block.length > from)
				steps.push({ kind: "pcm", bytes: block.subarray(from) })
			delivered += block.length / 2
			steps.push({
				kind: "block",
				powerDbfs: seg.open ? -20 : -90,
				quietingDb: seg.open ? seg.quietingDb : Number.NaN,
			})
			if (gate !== seg.open) {
				steps.push({ kind: "gate", open: seg.open })
				gate = seg.open
			}
		}
	}
	return steps
}

export function toS16(samples: Float32Array): Buffer {
	const b = Buffer.alloc(samples.length * 2)
	for (let i = 0; i < samples.length; i++) {
		const v = Math.max(-1, Math.min(1, samples[i] ?? 0))
		b.writeInt16LE(Math.round(v * 32_767), i * 2)
	}
	return b
}
