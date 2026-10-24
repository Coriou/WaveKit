/**
 * Pure engine selection (requirement 1.3, property 7). No I/O.
 *
 * `engine: "csdr"` never falls back. `engine: "rust"` falls back to csdr on
 * the first matching condition, in this order: a latched unstable process,
 * a binary that cannot be spawned, a protocol older than the demod protocol,
 * a source that is not cu8, a modulation other than nfm or am, then an open
 * that would be rejected (including bandwidth outside 2 500..40 000 Hz).
 */

export const DEMOD_PROTOCOL = 2
/** A18: binaries at this protocol or later frame the audio socket on request. */
export const DEMOD_FRAMING_PROTOCOL = 3
export const RUST_AUDIO_RATE_HZ = 48_000
export const DEMOD_MIN_BANDWIDTH_HZ = 2_500
export const DEMOD_MAX_BANDWIDTH_HZ = 40_000
export const RUST_FALLBACK_LOG =
	"Live demodulation Rust engine fell back to csdr"

export const ENGINE_FALLBACK_REASONS = [
	"binary-unavailable",
	"protocol-unsupported",
	"input-format-unsupported",
	"modulation-unsupported",
	"open-rejected",
	"process-unstable",
] as const

export type EngineName = "csdr" | "rust"
export type EngineFallbackReason = (typeof ENGINE_FALLBACK_REASONS)[number]

export interface EngineSelectionConfig {
	engine?: EngineName | undefined
	modulation: string
	bandwidth: number
}

/** Version-probe result plus the latches selection also consults. */
export interface EngineProbe {
	/** False when the binary is missing, fails to spawn, or the probe times out. */
	available: boolean
	/** Parsed `protocol N`, or null when the process produced no usable line. */
	protocol: number | null
	openRejected?: boolean | undefined
	processUnstable?: boolean | undefined
}

export interface EngineSelectionInput {
	config: EngineSelectionConfig
	caps: { format: string } | null
	probe: EngineProbe
}

export interface EngineSelection {
	engine: EngineName
	fallback?: EngineFallbackReason
}

const RUST_MODULATIONS = new Set(["nfm", "am"])

/** Capture formats the demod channel can read. Source caps say `U8_IQ`. */
export function isCu8Format(format: string | undefined): boolean {
	return format === "U8_IQ" || format === "cu8"
}

export function bandwidthAccepted(bandwidthHz: number): boolean {
	return (
		Number.isFinite(bandwidthHz) &&
		bandwidthHz >= DEMOD_MIN_BANDWIDTH_HZ &&
		bandwidthHz <= DEMOD_MAX_BANDWIDTH_HZ
	)
}

export function selectEngine(input: EngineSelectionInput): EngineSelection {
	if (input.config.engine !== "rust") return { engine: "csdr" }
	const probe = input.probe
	if (probe.processUnstable)
		return { engine: "csdr", fallback: "process-unstable" }
	if (!probe.available)
		return { engine: "csdr", fallback: "binary-unavailable" }
	if (probe.protocol === null || probe.protocol < DEMOD_PROTOCOL)
		return { engine: "csdr", fallback: "protocol-unsupported" }
	if (!isCu8Format(input.caps?.format))
		return { engine: "csdr", fallback: "input-format-unsupported" }
	if (!RUST_MODULATIONS.has(input.config.modulation))
		return { engine: "csdr", fallback: "modulation-unsupported" }
	if (probe.openRejected || !bandwidthAccepted(input.config.bandwidth))
		return { engine: "csdr", fallback: "open-rejected" }
	return { engine: "rust" }
}
