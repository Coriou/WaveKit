/**
 * Shared shapes for the WG7 ambient interpreters (AIS, ACARS, VDL2, Meshtastic; design
 * "Ambient identify (lane AMB)", requirements 1.2-1.3).
 */
import { SCANNER_AMBIENT_TARGET_TOLERANCE_HZ } from "@wavekit/api-types"
import type { DecodeEvidence, Identity, ScannerProtocol } from "../../types.js"
import { evidenceBase } from "./double-match.js"
import type { InterpreterState } from "./double-match.js"

export interface AmbientInterpretCtx {
	/** The decoder's own target frequencies (Hz). */
	targetsHz: readonly number[]
	/** Actual channel placement, never a band default. */
	channelHz?: number
}

/** Evidence plus the decode's RF frequency (Hz). */
export type AmbientDecode = DecodeEvidence & { hz: number }

/**
 * A decode parsed without touching acceptance memory: AmbientEvidence checks trust at `hz`
 * before `acceptAmbient` may record the identity (an untrusted decode never primes H2).
 */
export interface AmbientParsed {
	hz: number
	timestamp: Date
	protocol: ScannerProtocol
	crcClean: boolean
	/** The raw frame when the decoder gave one (an exact repeat is not a new message). */
	frame?: string
	identity: { key: string; kind: Identity["kind"]; value: string | undefined }
}

/** The accept step: evidence for a parsed decode, recording its identity in `state`. */
export function acceptAmbient(
	state: InterpreterState,
	p: AmbientParsed,
): AmbientDecode[] {
	return ambientEvidence(
		state,
		p.timestamp,
		p.hz,
		p.protocol,
		p.crcClean,
		p.identity,
	)
}

/** Parse then accept (no trust gate); for callers that already trust every target. */
export function interpretWith<C>(
	parse: (out: C, ctx: AmbientInterpretCtx) => AmbientParsed | null,
): (
	out: C,
	state: InterpreterState,
	ctx: AmbientInterpretCtx,
) => AmbientDecode[] {
	return (out, state, ctx) => {
		const p = parse(out, ctx)
		return p ? acceptAmbient(state, p) : []
	}
}

/** True when `hz` is finite and within the ambient tolerance of one of `targetsHz`. */
export function nearTarget(hz: number, targetsHz: readonly number[]): boolean {
	if (!Number.isFinite(hz)) return false
	for (const t of targetsHz) {
		if (
			Number.isFinite(t) &&
			Math.abs(hz - t) <= SCANNER_AMBIENT_TARGET_TOLERANCE_HZ
		)
			return true
	}
	return false
}

/**
 * One ambient evidence: identity attached when `value` is already accepted under `key` or this
 * CRC-clean occurrence is its second within the state (H2); never when `crcClean` is false.
 * Returns [] for an invalid timestamp.
 */
export function ambientEvidence(
	state: InterpreterState,
	timestamp: Date,
	hz: number,
	protocol: ScannerProtocol,
	crcClean: boolean,
	identity: { key: string; kind: Identity["kind"]; value: string | undefined },
): AmbientDecode[] {
	const at = timestamp instanceof Date ? timestamp.getTime() : Number.NaN
	if (!Number.isFinite(at)) return []
	const ev: AmbientDecode = {
		...evidenceBase(state, at),
		crcClean,
		protocol,
		metadata: {},
		hz,
	}
	const value = identity.value
	if (
		crcClean &&
		value !== undefined &&
		(state.match.isAccepted(identity.key, value) ||
			state.match.accept(identity.key, value, true))
	)
		ev.identity = { kind: identity.kind, value }
	return [ev]
}

/** Plain-object guard: field reads on anything else yield nothing. */
export function asRecord(data: unknown): Record<string, unknown> | undefined {
	return typeof data === "object" && data !== null && !Array.isArray(data)
		? (data as Record<string, unknown>)
		: undefined
}

/** Missing/zero decoder frequency is usable only with an actual channel placement. */
export function placedFrequency(
	raw: unknown,
	ctx: AmbientInterpretCtx,
): unknown {
	return raw === undefined || raw === 0 ? (ctx.channelHz ?? raw) : raw
}
