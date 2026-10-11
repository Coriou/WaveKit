import { CHANNEL_POWER_FLOOR_DBFS } from "../../channel-squelch.js"
import { WaveKitError } from "../../../utils/errors.js"

function finite(value: number): void {
	if (!Number.isFinite(value))
		throw new WaveKitError(
			"Channel level must be finite",
			"SCANNER_LEVEL_INPUT",
		)
}

/** |z| = 1 is 0 dBFS; requires complete interleaved complex samples. */
export function meanPowerDbfs(cf32: Float32Array): number {
	if (cf32.length % 2 !== 0)
		throw new WaveKitError("Incomplete complex sample", "SCANNER_LEVEL_INPUT")
	let power = 0
	for (const value of cf32) {
		finite(value)
		power += value * value
	}
	return power === 0
		? CHANNEL_POWER_FLOOR_DBFS
		: Math.max(
				CHANNEL_POWER_FLOOR_DBFS,
				10 * Math.log10(power / (cf32.length / 2)),
			)
}

/** P = S + N; stable even for very large finite SNR values. */
export function noiseFromActiveDbfs(
	channelPowerDbfs: number,
	snrDb: number,
): number {
	finite(channelPowerDbfs)
	finite(snrDb)
	const noise =
		channelPowerDbfs -
		Math.max(0, snrDb) -
		(10 / Math.LN10) * Math.log1p(Math.exp((-Math.abs(snrDb) * Math.LN10) / 10))
	finite(noise)
	return noise
}

export function squelchThresholdDbfs(
	noiseDbfs: number,
	squelchDb: number,
): number {
	finite(noiseDbfs)
	finite(squelchDb)
	const threshold = noiseDbfs + squelchDb
	finite(threshold)
	return threshold
}

/** EWMA in dB while closed; jumps above 3 dB are signal onset. */
export class ChannelNoiseTracker {
	private readonly alpha: number
	private value: number | null = null
	constructor(opts: { alpha?: number } = {}) {
		this.alpha = opts.alpha ?? 0.02
		if (!Number.isFinite(this.alpha) || this.alpha <= 0 || this.alpha > 1)
			throw new WaveKitError(
				"Invalid noise EWMA alpha",
				"SCANNER_LEVEL_OPTIONS",
			)
	}
	get noiseDbfs(): number | null {
		return this.value
	}
	reset(): void {
		this.value = null
	}
	seed(noiseDbfs: number): void {
		finite(noiseDbfs)
		this.value = noiseDbfs
	}
	update(powerDbfs: number, gateOpen: boolean): void {
		finite(powerDbfs)
		if (gateOpen) return
		if (this.value === null) this.value = powerDbfs
		else if (powerDbfs <= this.value + 3)
			this.value = (1 - this.alpha) * this.value + this.alpha * powerDbfs
	}
}
