/**
 * WG7 req 1.3: the ambient trust rule, kept free of scanner runtime imports so the startup
 * composition (`src/index.ts`) can use it without pulling in the probe pool.
 */
import { SCANNER_AMBIENT_TARGET_TOLERANCE_HZ } from "@wavekit/api-types"
import type { TuningTrust } from "../../spectrum/types.js"

export const isTrusted = (t: TuningTrust | undefined): boolean =>
	t === "commanded" || t === "relay"

/** The provenance binding fields the ambient trust rule reads (structural ActivityDecoderBinding). */
export interface AmbientTrustBinding {
	sourceId: string | null
	targetFrequenciesHz: readonly number[]
	tuningTrust: TuningTrust
}

/**
 * WG7 req 1.3: trust of an ambient decode at `hz` on `sourceId` from the decoder's provenance
 * binding. Fail closed: only `commanded`/`relay`, only when the binding's source is `sourceId`
 * (a binding without a source belongs to an external-input decoder and never counts), and only
 * when `hz` lies within
 * SCANNER_AMBIENT_TARGET_TOLERANCE_HZ of one of the binding's own target frequencies (the
 * frequencies the trust was proven for). Anything else, a throw included, is undefined.
 */
export function ambientTrustFromBinding(
	binding: AmbientTrustBinding | null | undefined,
	hz: number,
	sourceId: string,
): TuningTrust | undefined {
	try {
		if (!binding || !isTrusted(binding.tuningTrust)) return undefined
		if (!Number.isFinite(hz)) return undefined
		if (typeof binding.sourceId !== "string" || binding.sourceId !== sourceId)
			return undefined
		const near = binding.targetFrequenciesHz.some(
			t =>
				Number.isFinite(t) &&
				Math.abs(t - hz) <= SCANNER_AMBIENT_TARGET_TOLERANCE_HZ,
		)
		return near ? binding.tuningTrust : undefined
	} catch {
		return undefined
	}
}
