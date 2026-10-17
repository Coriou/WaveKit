/**
 * WG9 requirement 3.1: the one shared, fail-closed rule that derives a tuning trust label
 * from tuner state. `unverified` whenever frequency or sample rate is unknown or only
 * declared (never written by this core nor seen in an accepted relay command since the
 * start or the last reset reconnect); otherwise `relay` for external control and
 * `commanded` for internal control. Anything missing, malformed or unrecognised is
 * `unverified`. Types only: no runtime imports.
 */
import type { TunerState } from "@wavekit/api-types"
import type { TuningTrust } from "./spectrum/types.js"

/** The tuner state fields the rule reads (a full `TunerState` satisfies it). */
export type TuningTrustInput = Pick<
	TunerState,
	"controlMode" | "unknownFields" | "declaredOnlyFields"
>

const TUNING_FIELDS: readonly string[] = ["frequency", "sampleRate"]

/** True only for a missing list or a real array of strings none of which is a tuning field. */
function clearOfTuning(list: unknown): boolean {
	if (list === undefined) return true
	if (!Array.isArray(list)) return false
	for (const entry of list as unknown[]) {
		if (typeof entry !== "string") return false
		if (TUNING_FIELDS.includes(entry)) return false
	}
	return true
}

export function tuningTrustOf(
	state: TuningTrustInput | null | undefined,
): TuningTrust {
	if (state === null || typeof state !== "object") return "unverified"
	if (!clearOfTuning(state.unknownFields)) return "unverified"
	if (!clearOfTuning(state.declaredOnlyFields)) return "unverified"
	const mode: unknown = state.controlMode
	if (mode === "external") return "relay"
	if (mode === "internal") return "commanded"
	return "unverified"
}
