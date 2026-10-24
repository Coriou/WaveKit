/**
 * Live demodulator pipeline plan (pure).
 *
 * The live chain runs as two shell pipelines with Node in between:
 *
 *   front: capture IQ → float → [shift offsetHz to DC] → channel firdecimate
 *          (complex float32 channel IQ at the demod rate)
 *   Node:  channel-power squelch (zeros the IQ while closed)
 *   back:  demodulate → [de-emphasis] → [agc] → [low-pass] → dcblock → gain → limit
 *          → [s16] [| sox high/low-pass]
 *
 * Squelching on channel IQ is the only place a dBFS threshold means anything;
 * after an FM discriminator noise is louder than a quieted carrier.
 */

import type { LiveDemodConfig, SourceCaps } from "../config.js"
import {
	boundCsdrPipeline,
	type CsdrBufferPolicy,
	getCsdrBufferPolicy,
} from "../decoders/csdr-buffers.js"
import {
	channelDecimationStage,
	deemphasisStage,
	shiftStage,
	validateChannelOffset,
} from "../decoders/csdr-stages.js"
import type { Logger } from "../utils/logger.js"

export const DEFAULT_IQ_SAMPLE_RATE = 2_400_000

/** AGC target ahead of the audio gain: the default gain 2 lands at 0.8. */
const AGC_REFERENCE = 0.4

export type LiveDemodAgcMode = NonNullable<LiveDemodConfig["agc"]>

/**
 * Effective AGC mode of the live chain. Raw never gets AGC; absent `agc`
 * keeps the modulation default (fast for AM family and SSB, off for FM).
 */
export function effectiveAgc(
	modulation: LiveDemodConfig["modulation"],
	agc?: LiveDemodAgcMode,
): LiveDemodAgcMode {
	if (modulation === "raw") return "off"
	if (agc !== undefined) return agc
	return modulation === "nfm" || modulation === "wfm" ? "off" : "fast"
}

function agcStage(mode: LiveDemodAgcMode): string | null {
	return mode === "off"
		? null
		: `csdr agc -f float -p ${mode} -r ${AGC_REFERENCE}`
}

export interface FilterSettings {
	lowPass: number
	highPass: number
}

const NOISE_REDUCTION_PRESETS: Record<
	LiveDemodConfig["noiseReduction"],
	FilterSettings
> = {
	off: { lowPass: 0, highPass: 0 },
	voice: { lowPass: 3000, highPass: 300 },
	"noaa-apt": { lowPass: 2400, highPass: 0 },
	"narrow-band": { lowPass: 2000, highPass: 300 },
}

export interface DemodRateInfo {
	iqSampleRate: number
	decimation: number
	effectiveSampleRate: number
}

/** Integer decimation to about twice the configured bandwidth. */
export function liveDemodRates(
	iqSampleRate: number,
	config: LiveDemodConfig,
): DemodRateInfo {
	const bandwidth =
		config.bandwidth > 0 ? config.bandwidth : Math.max(1, iqSampleRate / 2)
	const nyquistRate = Math.max(1, bandwidth * 2)
	const decimation = Math.max(1, Math.round(iqSampleRate / nyquistRate))
	return {
		iqSampleRate,
		decimation,
		effectiveSampleRate: iqSampleRate / decimation,
	}
}

export function resolveLiveDemodFilters(
	config: LiveDemodConfig,
	effectiveSampleRate: number,
): FilterSettings {
	let lowPass = config.lowPass
	let highPass = config.highPass

	if (config.noiseReduction !== "off") {
		const preset = NOISE_REDUCTION_PRESETS[config.noiseReduction]
		if (lowPass <= 0) lowPass = preset.lowPass
		if (highPass <= 0) highPass = preset.highPass
	}

	const nyquist = effectiveSampleRate / 2
	if (lowPass > 0) lowPass = Math.min(lowPass, Math.max(0, nyquist - 1))
	if (highPass > 0) highPass = Math.min(highPass, Math.max(0, nyquist - 1))

	if (lowPass > 0 && highPass > 0 && highPass >= lowPass) {
		highPass = 0
	}

	return { lowPass, highPass }
}

export interface LiveDemodPipelineInput {
	config: LiveDemodConfig
	iqSampleRate: number
	iqFormat: SourceCaps["format"] | undefined
	decimation: number
	logger: Pick<Logger, "info">
	bufferPolicy?: CsdrBufferPolicy
}

export interface LiveDemodPipelinePlan {
	/** Shell command: capture IQ on stdin → channel complex float32 on stdout. */
	front: string
	/** Shell command: channel IQ on stdin → audio on stdout. */
	back: string
	frontStages: string[]
	backStages: string[]
	sox: string | null
	/** Demod (= audio) sample rate in Hz; may be fractional. */
	channelSampleRate: number
	filters: FilterSettings
	/** Non-fatal configuration notes for the operator log. */
	warnings: string[]
}

export function planLiveDemodPipeline(
	input: LiveDemodPipelineInput,
): LiveDemodPipelinePlan {
	const { config, iqSampleRate, decimation } = input
	const policy = input.bufferPolicy ?? getCsdrBufferPolicy()
	const channelSampleRate = iqSampleRate / decimation
	const warnings: string[] = []

	const inputFormat = input.iqFormat === "S16_IQ" ? "s16" : "char"
	if (
		input.iqFormat &&
		input.iqFormat !== "U8_IQ" &&
		input.iqFormat !== "S16_IQ"
	) {
		warnings.push(
			`Unsupported IQ format ${input.iqFormat}, reading it as U8 IQ`,
		)
	}
	if (config.iqDcBlock) {
		warnings.push(
			"iqDcBlock is ignored: csdr dcblock is real-only and corrupted interleaved I/Q; set offsetHz to move the channel off the DC spike",
		)
	}

	const sideband = config.modulation === "usb" || config.modulation === "lsb"
	const filterMode =
		sideband || config.modulation === "raw" ? "nyquist" : "channel"

	validateChannelOffset(config.offsetHz, iqSampleRate, config.bandwidth)
	const frontStages = [`csdr convert -i ${inputFormat} -o float`]
	const shift = shiftStage(config.offsetHz, iqSampleRate)
	if (shift) frontStages.push(shift)
	frontStages.push(
		channelDecimationStage(
			iqSampleRate,
			decimation,
			config.bandwidth,
			filterMode,
		),
	)

	const filters = resolveLiveDemodFilters(config, channelSampleRate)
	const backStages: string[] = []
	const agc = agcStage(effectiveAgc(config.modulation, config.agc))
	switch (config.modulation) {
		case "am":
		case "cw":
		case "dsb":
			backStages.push("csdr amdemod")
			if (agc) backStages.push(agc)
			break
		case "usb":
		case "lsb": {
			const sidebandWidth = Math.min(
				0.5,
				Math.max(0.01, config.bandwidth / channelSampleRate),
			)
			const low = config.modulation === "lsb" ? -sidebandWidth : 0
			const high = config.modulation === "lsb" ? 0 : sidebandWidth
			backStages.push(
				`csdr bandpass --fft --low ${low.toFixed(4)} --high ${high.toFixed(4)} 0.05`,
				"csdr realpart",
			)
			if (agc) backStages.push(agc)
			break
		}
		case "raw":
			backStages.push("csdr realpart")
			break
		case "wfm":
		case "nfm":
		default: {
			backStages.push("csdr fmdemod")
			if (config.deEmphasis) {
				const kind = config.modulation === "wfm" ? "wfm" : "nfm"
				const deemphasis = deemphasisStage(
					kind,
					channelSampleRate,
					config.deEmphasisTau,
				)
				backStages.push(deemphasis.stage)
			}
			if (agc) backStages.push(agc)
			break
		}
	}

	const useSox = filters.highPass > 0
	if (!useSox && filters.lowPass > 0) {
		const normalizedCutoff = filters.lowPass / channelSampleRate
		backStages.push(`csdr lowpass -f float ${normalizedCutoff.toFixed(4)}`)
	}

	backStages.push("csdr dcblock", `csdr gain ${config.gain}`, "csdr limit")

	if (!useSox && config.audioFormat === "s16le") {
		backStages.push("csdr convert -i float -o s16")
	}

	let sox: string | null = null
	if (useSox) {
		const outputFormat =
			config.audioFormat === "s16le"
				? "-e signed -b 16"
				: "-e floating-point -b 32"
		const effects: string[] = []
		if (filters.highPass > 0) effects.push(`highpass ${filters.highPass}`)
		if (filters.lowPass > 0) effects.push(`lowpass ${filters.lowPass}`)
		sox = [
			"sox",
			"-t raw",
			`-r ${channelSampleRate}`,
			"-e floating-point -b 32 -c 1",
			"-",
			"-t raw",
			`-r ${channelSampleRate}`,
			`${outputFormat} -c 1`,
			"-",
			effects.join(" "),
		]
			.filter(Boolean)
			.join(" ")
	}

	const front = boundCsdrPipeline(frontStages, input.logger, policy)
	let back = boundCsdrPipeline(backStages, input.logger, policy)
	if (sox) back = `${back} | ${sox}`

	return {
		front,
		back,
		frontStages,
		backStages,
		sox,
		channelSampleRate,
		filters,
		warnings,
	}
}

/**
 * Evidence squelch guard (amendment A16 revision, 2026-10-24): the lag, in channel samples, between
 * the IQ block the carrier observer measures and the PCM samples it becomes at the client path.
 * The NFM back chain runs at the channel rate (no decimation), so the lag is the stages' filter
 * delay plus any input window a stage retains before it can emit:
 *
 * - `csdr fmdemod`: 1 sample (the previous sample of the phase difference).
 * - `csdr dcblock`, `gain`, `limit`, `convert`: 0 (memoryless or a one-pole IIR with no
 *   retained input; CSDR AnyLengthModule stages emit what they read).
 * - `csdr lowpass` and `csdr deemphasis --nfm` (FIR): 120 (an 81-tap window at the default
 *   0.05 transition: 80 retained + 40 group delay; an estimate, not measured).
 * - `csdr deemphasis --wfm` (one-pole IIR): 1.
 * - `sox` (high-pass): 4 096 (two 8 192-byte float32 buffers in flight; an estimate).
 *
 * The default live NFM chain (`fmdemod | dcblock | gain | limit | convert`) lags 1 sample. Live
 * run6 (2026-10-24) agrees: the client's noise began within one 10 ms block of the carrier drop.
 */
export function backChainDrainSamples(backCommand: string): number {
	let lag = 0
	for (const raw of backCommand.split("|")) {
		const stage = raw.trim()
		if (stage.includes("csdr fmdemod")) lag += 1
		else if (stage.includes("csdr lowpass")) lag += 120
		else if (stage.includes("csdr deemphasis --nfm")) lag += 120
		else if (stage.includes("csdr deemphasis")) lag += 1
		else if (/(^|\s)sox(\s|$)/.test(stage)) lag += 4_096
	}
	return lag
}
