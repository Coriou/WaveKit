// Small pure helpers of the tuned card.
import type { LiveAudioLevel } from "@wavekit/api-types"

/** With squelch off, a channel this far above the noise floor counts as carrying a signal. */
export const PRESENT_SNR_DB = 6

/**
 * Whether the tuned channel carries a signal: true, false, or null when the core cannot say. With
 * squelch on, the core's squelch decides. With it off (threshold 0 dBFS, the core's default
 * `liveDemod.squelch: 0`), `squelchOpen` is always true, so the channel's level over the noise floor
 * decides, one way only: the core's floor is a lower envelope seeded by the first block after a retune
 * (src/core/live-demodulator.ts measureRun), so on a carrier that was already up the floor equals the
 * carrier and the SNR reads 0. A rise of PRESENT_SNR_DB means a signal; no rise proves nothing (null).
 */
export function signalPresent(
	level: Pick<
		LiveAudioLevel,
		"squelchOpen" | "thresholdDbfs" | "channelPowerDbfs" | "noiseFloorDbfs"
	>,
): boolean | null {
	if (level.thresholdDbfs < 0) return level.squelchOpen
	if (level.channelPowerDbfs === null || level.noiseFloorDbfs === null)
		return null
	return level.channelPowerDbfs - level.noiseFloorDbfs >= PRESENT_SNR_DB
		? true
		: null
}

/** The card's 5-bar signal glyph: lit bars for an SNR in dB (null: none lit). */
export function signalBars(snrDb: number | null): number {
	if (snrDb === null || !Number.isFinite(snrDb)) return 0
	const steps = [3, 8, 14, 20, 28]
	return steps.filter(s => snrDb >= s).length
}

const DECODER: Readonly<Record<string, string>> = {
	"dsd-fme": "Digital voice",
	"ais-catcher": "AIS",
	"multimon-ng": "Pager",
	direwolf: "APRS",
	rtl433: "ISM sensors",
	acarsdec: "ACARS",
	dumpvdl2: "VDL2",
	"lora-meshtastic": "Meshtastic",
	readsb: "ADS-B",
	dump1090: "ADS-B",
}

/** What a decoder type decodes, in words ("AIS" for ais-catcher); the type itself when unknown. */
export function decoderLabel(type: string): string {
	return DECODER[type] ?? type
}
