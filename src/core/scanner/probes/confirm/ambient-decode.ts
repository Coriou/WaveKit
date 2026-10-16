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
}

/** Evidence plus the decode's RF frequency (Hz). */
export type AmbientDecode = DecodeEvidence & { hz: number }

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
