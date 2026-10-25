/**
 * Acceptance memory shared by the confirm interpreters (spec H2, § 6.6): a value is accepted on its
 * second CRC-clean occurrence; single-shot rules mark values accepted directly.
 */
import type { DecodeEvidence } from "../../types.js"

/** Structural subset of DecoderOutput (src/decoders/types.ts). */
export interface DecoderOutputLike {
	type: string
	data: unknown
	timestamp: Date
	/** Placement binding of a channel decoder's output (validated where read). */
	provenanceBinding?: unknown
}

const MAX_VALUES_PER_KEY = 256
const MAX_ACCEPTED = 4096

/**
 * Cross-instance pairing (confirm-memory.ts): asked on the first CRC-clean occurrence of
 * `value` under `key` in this memory; true when another instance on the same discovery
 * already saw it, so this occurrence is the second. Must not throw (a throw counts as false).
 */
export type ConfirmPair = (key: string, value: string) => boolean

export class DoubleMatch {
	private readonly counts = new Map<string, Map<string, number>>()
	private readonly accepted = new Set<string>()

	constructor(private readonly pair?: ConfirmPair) {}

	private paired(key: string, value: string): boolean {
		if (!this.pair) return false
		try {
			return this.pair(key, value) === true
		} catch {
			return false
		}
	}

	/** True exactly once: on the second CRC-clean occurrence of `value` under `key`. */
	accept(key: string, value: string, crcClean: boolean): boolean {
		if (!crcClean || this.isAccepted(key, value)) return false
		let values = this.counts.get(key)
		if (values === undefined) {
			values = new Map()
			this.counts.set(key, values)
		}
		const seen = (values.get(value) ?? 0) + 1
		values.delete(value)
		if (seen >= 2 || (seen === 1 && this.paired(key, value))) {
			this.markAccepted(key, value)
			return true
		}
		values.set(value, seen)
		if (values.size > MAX_VALUES_PER_KEY) {
			const oldest = values.keys().next()
			if (oldest.done !== true) values.delete(oldest.value)
		}
		return false
	}

	isAccepted(key: string, value: string): boolean {
		return this.accepted.has(`${key}\u0000${value}`)
	}

	markAccepted(key: string, value: string): void {
		const id = `${key}\u0000${value}`
		if (this.accepted.has(id)) return
		this.accepted.add(id)
		if (this.accepted.size > MAX_ACCEPTED) {
			const oldest = this.accepted.values().next()
			if (oldest.done !== true) this.accepted.delete(oldest.value)
		}
	}
}

export interface InterpreterState {
	epoch: number
	origin: "probe" | "ambient"
	probeId?: string
	decoderId?: string
	nxdn: "nxdn48" | "nxdn96"
	match: DoubleMatch
	accepted: Map<string, string>
}

export function createInterpreterState(opts: {
	epoch: number
	origin: "probe" | "ambient"
	probeId?: string
	decoderId?: string
	nxdn?: "nxdn48" | "nxdn96"
	/** Shared per-discovery pairing (confirm-memory.ts); absent: this state pairs alone. */
	pair?: ConfirmPair
}): InterpreterState {
	const state: InterpreterState = {
		epoch: opts.epoch,
		origin: opts.origin,
		nxdn: opts.nxdn ?? "nxdn96",
		match: new DoubleMatch(opts.pair),
		accepted: new Map(),
	}
	if (opts.probeId !== undefined) state.probeId = opts.probeId
	if (opts.decoderId !== undefined) state.decoderId = opts.decoderId
	return state
}

/** Fields every accepted evidence shares. */
export function evidenceBase(
	state: InterpreterState,
	at: number,
): Pick<
	DecodeEvidence,
	"crcClean" | "at" | "epoch" | "origin" | "probeId" | "decoderId"
> {
	const base: Pick<
		DecodeEvidence,
		"crcClean" | "at" | "epoch" | "origin" | "probeId" | "decoderId"
	> = {
		crcClean: true,
		at,
		epoch: state.epoch,
		origin: state.origin,
	}
	if (state.probeId !== undefined) base.probeId = state.probeId
	if (state.decoderId !== undefined) base.decoderId = state.decoderId
	return base
}
