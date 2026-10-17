/**
 * Operator retune settle (WG9 requirement 3.4). A retune that is not the scanner's own (REST,
 * relay, caps change, host-centre demotion) gets a short display settle instead of the scanner's
 * `scanner.sweep.settleMs.network`, a stale-content discard capped at the same value, and the
 * frames between that settle and the configured network settle are labelled `unverified`.
 *
 * Markers are not used for these retunes: bracketing needs TEST_MODE writes around the operator's
 * command (tuner-controller), which replaces the shared stream with counter bytes for every
 * consumer (live audio, decoders) and is only known to work once the scanner measured it.
 *
 * Pure: no imports beyond types.
 */
import type { TuningTrust } from "./types.js"

/**
 * Display settle for a non-scanner retune, in ms (≤ 300 by requirement 3.4). Chosen by the
 * fake rtl_tcp harness (tests/integration/retune-latency.test.ts): 150 ms settle + one 50 ms
 * block + ≤ 50 ms frame pacing keeps p90 under 300 ms at no injected delay, and settle plus the
 * capped stale discard (2 × 150 ms) covers an injected bridge delay up to 300 ms.
 */
export const OPERATOR_RETUNE_SETTLE_MS = 150

export interface OperatorRetuneTiming {
	/** Timer settle for the pending epoch. */
	settleSamples: number
	/** Stale-content discard cap for the pending epoch. */
	staleMaxMs: number
	/** First sample whose frames may carry the epoch's own label; null = no unverified window. */
	verifiedFromSample: number | null
}

/** Settle, stale cap and unverified window of a non-scanner retune. */
export function operatorRetuneTiming(input: {
	commandSample: number
	bufferedSamples: number
	sampleRateHz: number
	networkSettleMs: number
}): OperatorRetuneTiming {
	const network = Math.max(0, input.networkSettleMs)
	const settleMs = Math.min(network, OPERATOR_RETUNE_SETTLE_MS)
	const settleSamples = Math.round((settleMs * input.sampleRateHz) / 1000)
	const networkSamples = Math.round((network * input.sampleRateHz) / 1000)
	return {
		settleSamples,
		staleMaxMs: OPERATOR_RETUNE_SETTLE_MS,
		verifiedFromSample:
			networkSamples > settleSamples
				? input.commandSample + input.bufferedSamples + networkSamples
				: null,
	}
}

/** Samples per pipeline block (as SpectrumPipeline computes it, no overlap dependency). */
export function blockSamplesOf(
	integrationMs: number,
	sampleRateHz: number,
	fftSize: number,
): number {
	return (
		Math.max(1, Math.round((integrationMs * sampleRateHz) / (fftSize * 1000))) *
		fftSize
	)
}

/** A block that starts before `verifiedFromSample` is `unverified`; otherwise its epoch's label. */
export function frameTrust(
	trust: TuningTrust,
	blockStartSample: number,
	verifiedFromSample: number | null,
): TuningTrust {
	if (verifiedFromSample === null) return trust
	return blockStartSample < verifiedFromSample ? "unverified" : trust
}

/** The weaker of two labels: `unverified` beats `relay`, which beats `commanded`. */
export function mergeTrust(a: TuningTrust, b: TuningTrust): TuningTrust {
	if (a === "unverified" || b === "unverified") return "unverified"
	if (a === "relay" || b === "relay") return "relay"
	return "commanded"
}
