/**
 * WG10 frozen contract (docs/specs/web-gaps-10, requirement 3): the analog evidence port identify
 * reads. Lane ID implements it (`src/core/scanner/analog-evidence.ts`) from the live
 * demodulator's transmission events; Main wires it into the scanner service. Types only.
 */
import type { TuningTrust } from "@wavekit/api-types"

/** One live-audio transmission as identify sees it (from `live-audio:transmission` events). */
export interface AnalogEvidenceTransmission {
	transmissionId: string
	sourceId: string
	startedAtMs: number
	/** Null while the transmission is open. */
	endedAtMs: number | null
	/** Frequency sampled at open (tuner centre + live-audio offset). */
	hz: number
	tuningTrust: TuningTrust
	modulation: "nfm" | "wfm" | "am" | "usb" | "lsb" | "dsb" | "cw" | "raw"
	/** Closed events only; null when none qualified. */
	ctcssHz: number | null
	dcs: { code: string; polarity: "normal" | "inverted" } | null
}

/**
 * Identify's read side. Synchronous, no IO, never throws for the caller (a throwing
 * implementation is treated as no evidence and not monitoring: fail closed).
 */
export interface IdentifyAnalogEvidence {
	/**
	 * Transmissions on `sourceId` whose frequency lies within `toleranceHz` of `hz` and that are
	 * open or ended at or after `sinceMs`; newest first; at most IDENTIFY_ANALOG_MAX_TRANSMISSIONS.
	 */
	transmissionsNear(
		sourceId: string,
		hz: number,
		toleranceHz: number,
		sinceMs: number,
	): readonly AnalogEvidenceTransmission[]
	/** True when live audio is running on `sourceId` now with its channel (known frequency) within `toleranceHz` of `hz`. */
	monitoring(sourceId: string, hz: number, toleranceHz: number): boolean
	/**
	 * WG10 R2 (optional): the tracker's held opening that is not yet published because it has not
	 * reached the minimum audio (activity hygiene), as an open transmission, when it lies on
	 * `sourceId` within `toleranceHz` of `hz`; else empty. Absent: no pending evidence.
	 */
	pendingNear?(
		sourceId: string,
		hz: number,
		toleranceHz: number,
	): readonly AnalogEvidenceTransmission[]
}
