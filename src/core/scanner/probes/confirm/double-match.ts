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

/** The shared, scoped acceptance memory (ConfirmMemory in confirm-memory.ts). */
export interface SharedConfirmMemory {
	pair(scope: string, key: string, value: string): boolean
	pairMessage?(
		scope: string,
		key: string,
		value: string,
		message: string,
	): boolean
	isAccepted(scope: string, key: string, value: string): boolean
	markAccepted(scope: string, key: string, value: string): void
}

/**
 * a DoubleMatch backed by the shared memory. `scope` names the discovery (or
 * observation) of the decode being interpreted, read on every call; null (or a throw) means
 * the decode has no single discovery, so this instance's own memory decides as before.
 */
export interface SharedConfirm {
	memory: SharedConfirmMemory
	scope: () => string | null
	message?: () => string | null
	/** A composed scanner never primes acceptance without unambiguous placement. */
	requireScope?: boolean
}

export class DoubleMatch {
	private readonly counts = new Map<string, Map<string, number>>()
	private readonly accepted = new Set<string>()

	constructor(private readonly shared?: SharedConfirm) {}

	/** The scope of the current decode when shared pairing governs it, else null. */
	scope(): string | null {
		if (!this.shared) return null
		try {
			const scope = this.shared.scope()
			return typeof scope === "string" && scope !== "" ? scope : null
		} catch {
			return null
		}
	}

	/**
	 * True exactly once per scope: on the second CRC-clean occurrence of `value` under `key`.
	 * With a shared scope, the shared memory alone decides and records the occurrence (its
	 * separation and window bounds apply to repeats inside this instance too).
	 */
	accept(key: string, value: string, crcClean: boolean): boolean {
		if (!crcClean || this.isAccepted(key, value)) return false
		const scope = this.scope()
		if (scope === null && this.shared?.requireScope) return false
		if (scope !== null) {
			let paired = false
			try {
				const message = this.shared?.message?.()
				paired =
					message && this.shared!.memory.pairMessage
						? this.shared!.memory.pairMessage(scope, key, value, message)
						: this.shared!.memory.pair(scope, key, value) === true
				if (paired) this.shared!.memory.markAccepted(scope, key, value)
			} catch {
				return false
			}
			return paired
		}
		let values = this.counts.get(key)
		if (values === undefined) {
			values = new Map()
			this.counts.set(key, values)
		}
		const seen = (values.get(value) ?? 0) + 1
		values.delete(value)
		if (seen >= 2) {
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
		const scope = this.scope()
		if (scope === null && this.shared?.requireScope) return false
		if (scope !== null) {
			try {
				return this.shared!.memory.isAccepted(scope, key, value) === true
			} catch {
				return false
			}
		}
		return this.accepted.has(`${key}\u0000${value}`)
	}

	markAccepted(key: string, value: string): void {
		const scope = this.scope()
		if (scope === null && this.shared?.requireScope) return
		if (scope !== null) {
			try {
				this.shared!.memory.markAccepted(scope, key, value)
			} catch {
				// no acceptance recorded (the safe answer)
			}
			return
		}
		const id = `${key}\u0000${value}`
		if (this.accepted.has(id)) return
		this.accepted.add(id)
		if (this.accepted.size > MAX_ACCEPTED) {
			const oldest = this.accepted.values().next()
			if (oldest.done !== true) this.accepted.delete(oldest.value)
		}
	}
}

/**
 * dsd-fme's accepted link identity per protocol, kept per scope of the DoubleMatch (so an
 * identity accepted on one discovery is never this decoder's identity on another). Bounded
 * at MAX_ACCEPTED entries, oldest first.
 */
class ScopedAccepted extends Map<string, string> {
	constructor(private readonly match: DoubleMatch) {
		super()
	}
	private id(key: string): string {
		return `${this.match.scope() ?? ""}\u0000${key}`
	}
	override get(key: string): string | undefined {
		return super.get(this.id(key))
	}
	override has(key: string): boolean {
		return super.has(this.id(key))
	}
	override set(key: string, value: string): this {
		const id = this.id(key)
		super.delete(id)
		super.set(id, value)
		if (this.size > MAX_ACCEPTED) {
			const oldest = this.keys().next()
			if (oldest.done !== true) super.delete(oldest.value)
		}
		return this
	}
	override delete(key: string): boolean {
		return super.delete(this.id(key))
	}
}

export interface InterpreterState {
	/** Configured ambient decoders require two messages even for FCS-valid APRS/paging. */
	requirePair?: boolean
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
	/** Shared per-discovery acceptance (confirm-memory.ts); absent: this state pairs alone. */
	shared?: SharedConfirm
	requirePair?: boolean
}): InterpreterState {
	const match = new DoubleMatch(opts.shared)
	const state: InterpreterState = {
		...(opts.requirePair ? { requirePair: true } : {}),
		epoch: opts.epoch,
		origin: opts.origin,
		nxdn: opts.nxdn ?? "nxdn96",
		match,
		accepted: opts.shared ? new ScopedAccepted(match) : new Map(),
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
