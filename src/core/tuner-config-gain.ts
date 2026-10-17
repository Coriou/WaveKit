/**
 * Configured gain and AGC frames for a source (WG11 req 4.1, 4.2).
 *
 * Pure: no runtime imports, so the startup composition can use it without
 * pulling the tuner controller into other bundles. The opcodes mirror
 * `RTL_TCP_COMMANDS` in `tuner-controller.ts` (pinned by a test).
 */
import type { SourceTunerConfig } from "../config.js"

/** rtl_tcp SET_GAIN_MODE (0 = auto, 1 = manual). */
export const CONFIG_GAIN_MODE_COMMAND = 0x03
/** rtl_tcp SET_GAIN (tenths of a dB). */
export const CONFIG_GAIN_COMMAND = 0x04
/** rtl_tcp SET_AGC_MODE (RTL2832 digital AGC, 0 or 1). */
export const CONFIG_AGC_MODE_COMMAND = 0x08

/**
 * Frames in write order: gain mode, then gain (manual only), then AGC (when
 * given). Gain is `round(gainDb × 10)` tenths; the validated config bounds it
 * to 0..500, the controller's `VALIDATION.gain` range.
 */
export function configuredTuningFrames(
	tuner: SourceTunerConfig,
): ReadonlyArray<readonly [command: number, value: number]> {
	const frames: Array<readonly [number, number]> = []
	const manual = tuner.gainMode === "manual"
	frames.push([CONFIG_GAIN_MODE_COMMAND, manual ? 1 : 0])
	if (manual && tuner.gainDb !== undefined) {
		frames.push([CONFIG_GAIN_COMMAND, Math.round(tuner.gainDb * 10)])
	}
	if (tuner.agcMode !== undefined) {
		frames.push([CONFIG_AGC_MODE_COMMAND, tuner.agcMode ? 1 : 0])
	}
	return frames
}

/**
 * Startup composition: hand each rtl_tcp source's configured tuning to the
 * controller. A source without `tuner` is not touched (defaults stay
 * byte-identical); a non-rtl_tcp source with `tuner` is skipped and reported
 * once through `warn`.
 */
export function applyConfiguredTuning(
	sources: ReadonlyArray<{
		id: string
		type: string
		tuner?: SourceTunerConfig | undefined
	}>,
	controller: {
		setConfiguredTuning(id: string, t: SourceTunerConfig | undefined): void
	},
	warn: (sourceId: string) => void,
): void {
	for (const source of sources) {
		if (source.tuner === undefined) continue
		if (source.type === "rtl_tcp")
			controller.setConfiguredTuning(source.id, source.tuner)
		else warn(source.id)
	}
}
