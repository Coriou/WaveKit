/**
 * Fake evidence squelch ports for the live demodulator wiring tests (docs/specs/evidence-squelch,
 * plan W.2): a scripted gate that latches at a chosen stream byte, and a pre-roll that records
 * every call with absolute stream offsets. No real DSP.
 */
import type {
	EvidenceGateOptions,
	EvidenceGatePort,
	EvidencePcmFormat,
	EvidenceSquelchFactory,
	PreRollOptions,
	PreRollPort,
	PreRollTag,
} from "../../../src/core/evidence-squelch/contract.js"
import type { LiveAudioAutoSquelchEvidence } from "@wavekit/api-types"
import {
	createDemodHarness,
	type DemodHarnessOptions,
} from "./live-demodulator-continuity-fakes.js"

export interface StreamCursor {
	/** Absolute stream byte of the current chunk's first byte. */
	base: number
}

export class FakeGate implements EvidenceGatePort {
	state: "waiting" | "open" = "waiting"
	evidence: LiveAudioAutoSquelchEvidence | null = null
	readonly ops: string[] = []
	readonly notes: boolean[] = []
	/** Bytes seen through push() and closed() since construction. */
	seen = 0
	private guardLeft = 0

	constructor(
		readonly options: EvidenceGateOptions,
		/** Absolute stream byte (a sample boundary) at which the gate latches, or null. */
		public latchAtByte: number | null,
		public guardBytes: number,
		readonly latchEvidence: LiveAudioAutoSquelchEvidence = "voice",
	) {}

	noteBlock(carrier: boolean): void {
		this.notes.push(carrier)
	}

	push(
		_pcm: Buffer,
		_format: EvidencePcmFormat,
		start: number,
		end: number,
	): number {
		const length = end - start
		const at = this.latchAtByte
		let k = -1
		if (
			this.state === "waiting" &&
			at !== null &&
			at >= this.seen &&
			at < this.seen + length
		) {
			k = start + (at - this.seen)
			this.state = "open"
			this.evidence = this.latchEvidence
			this.ops.push("latched")
		}
		if (this.state === "open") this.guardLeft = this.guardBytes
		this.seen += length
		return k
	}

	closed(byteCount: number): number {
		this.seen += byteCount
		if (this.state !== "open") return 0
		const g = Math.min(byteCount, this.guardLeft)
		this.guardLeft -= g
		return g
	}

	reset(): void {
		this.ops.push("reset")
		this.state = "waiting"
		this.evidence = null
		this.latchAtByte = null
	}
}

export interface PreRollCall {
	start: number
	end: number
	tag: PreRollTag
}

export class FakePreRoll implements PreRollPort {
	readonly calls: PreRollCall[] = []
	readonly ops: string[] = []

	constructor(
		readonly options: PreRollOptions,
		private readonly cursor: StreamCursor,
		public delaySamples: number,
		/** When true, process() zeroes its range (a stand-in rewrite). */
		private readonly rewrite: boolean,
	) {}

	process(chunk: Buffer, start: number, end: number, tag: PreRollTag): void {
		if (end <= start) throw new Error("empty pre-roll range")
		this.calls.push({
			start: this.cursor.base + start,
			end: this.cursor.base + end,
			tag,
		})
		if (this.rewrite) chunk.fill(0, start, end)
	}

	latch(): void {
		this.ops.push("latch")
		this.calls.push({ start: -1, end: -1, tag: "pass" })
	}

	abandon(): void {
		this.ops.push("abandon")
	}

	clear(): void {
		this.ops.push("clear")
	}
}

export interface FakeFactoryOptions {
	latchAtByte?: number | null
	guardBytes?: number
	delaySamples?: number
	rewrite?: boolean
	failGate?: boolean
}

export function fakeFactory(
	cursor: StreamCursor,
	options: FakeFactoryOptions = {},
): EvidenceSquelchFactory & { gates: FakeGate[]; preRolls: FakePreRoll[] } {
	const gates: FakeGate[] = []
	const preRolls: FakePreRoll[] = []
	return {
		gates,
		preRolls,
		createGate(gateOptions) {
			if (options.failGate === true) throw new Error("gate unavailable")
			const gate = new FakeGate(
				gateOptions,
				options.latchAtByte ?? null,
				options.guardBytes ?? 0,
			)
			gates.push(gate)
			return gate
		},
		createPreRoll(preRollOptions) {
			const preRoll = new FakePreRoll(
				preRollOptions,
				cursor,
				options.delaySamples ?? 0,
				options.rewrite ?? false,
			)
			preRolls.push(preRoll)
			return preRoll
		},
	}
}

type Harness = Awaited<ReturnType<typeof createDemodHarness>>

export interface EvidenceRunInternals {
	run: {
		squelch: object
		stream: { rate: number; format: "s16le" | "f32le" }
		noiseFloorDbfs: number | null
		gateHeld: boolean
	} | null
	options: { evidenceSquelch?: EvidenceSquelchFactory }
	handleAudioData(chunk: Buffer): void
	publishSquelchChange(): void
	measureRun(
		run: unknown,
		sample?: { powerDbfs: number | null; quieted: boolean },
	): void
}

/**
 * A started demodulator on fake stages with the fake evidence factory injected (A5), stage 1
 * scripted through the squelch's `open` getter, and a stream cursor fed by the `pcm` event
 * (emitted before any rewrite of the chunk).
 */
export async function startEvidenceHarness(
	config: Record<string, unknown>,
	factoryOptions: FakeFactoryOptions = {},
	harnessOptions: Omit<DemodHarnessOptions, "config"> = {},
) {
	const cursor: StreamCursor = { base: 0 }
	const factory = fakeFactory(cursor, factoryOptions)
	const h: Harness = await createDemodHarness({
		...harnessOptions,
		config,
	})
	const internals = h.demod as unknown as EvidenceRunInternals
	internals.options.evidenceSquelch = factory
	let total = 0
	const pcm: Buffer[] = []
	h.demod.on("pcm", (chunk: Buffer) => {
		cursor.base = total
		total += chunk.length
		pcm.push(Buffer.from(chunk))
	})
	await h.demod.start()
	const stage = { open: false }
	const script = () => {
		const run = internals.run
		if (run === null) return
		Object.defineProperty(run.squelch, "open", {
			configurable: true,
			get: () => stage.open,
		})
	}
	script()
	return {
		h,
		factory,
		internals,
		stage,
		/** Re-applies the stage-1 script after a restart built a new run. */
		script,
		pcm,
		/** Delivers one chunk synchronously (as the back stage's data handler does). */
		feed(chunk: Buffer) {
			internals.handleAudioData(chunk)
		},
	}
}

/** Recorded pre-roll ranges merged where adjacent ranges share a tag (latch markers kept). */
export function mergedCalls(calls: readonly PreRollCall[]): PreRollCall[] {
	const out: PreRollCall[] = []
	for (const call of calls) {
		const last = out[out.length - 1]
		if (
			last !== undefined &&
			call.start >= 0 &&
			last.start >= 0 &&
			last.tag === call.tag &&
			last.end === call.start
		)
			last.end = call.end
		else out.push({ ...call })
	}
	return out
}

/** Tag of each sample by the call that delivered its first byte (A3). */
export function sampleTags(
	calls: readonly PreRollCall[],
	width: number,
	totalBytes: number,
): Array<PreRollTag | null> {
	const tags: Array<PreRollTag | null> = new Array<PreRollTag | null>(
		Math.ceil(totalBytes / width),
	).fill(null)
	for (const call of calls) {
		if (call.start < 0) continue
		const first = Math.ceil(call.start / width) * width
		for (let byte = first; byte < call.end; byte += width)
			tags[byte / width] = call.tag
	}
	return tags
}
