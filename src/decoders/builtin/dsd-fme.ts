/**
 * DSD-FME Decoder - Digital voice signal decoder
 *
 * Requirements:
 * - 6.1: WHEN started, THE DSD_Decoder SHALL spawn dsd-fme with the configured mode and options
 * - 6.2: WHEN dsd-fme outputs sync information, THE DSD_Decoder SHALL parse it into structured sync events
 * - 6.3: WHEN dsd-fme decodes a call, THE DSD_Decoder SHALL emit call events with talkgroup, source, and duration
 * - 6.4: WHEN dsd-fme encounters errors, THE DSD_Decoder SHALL emit error events with the error message
 * - 6.5: THE DSD_Decoder SHALL support modes: auto, dmr, p25, ysf, dstar, nxdn, provoice
 *
 * This decoder now uses AudioDemodDecoder to consume IQ data and perform internal FM
 * demodulation using csdr, eliminating dependency on SDR++ audio output and providing
 * optimal demodulation settings for digital voice.
 */

import { AudioDemodDecoder } from "../audio-demod-decoder.js"
import type {
	DecoderCaps,
	DecoderConfig,
	DecoderOutput,
	DemodulationConfig,
} from "../types.js"
import type { Logger } from "../../utils/logger.js"

/** Supported DSD-FME decoder modes (Requirement 6.5) */
export type DsdFmeMode =
	| "auto"
	| "dmr"
	| "p25"
	| "ysf"
	| "dstar"
	| "nxdn"
	| "provoice"

/** Audio output destination options */
export type DsdFmeOutputType = "null" | "wav" | "udp"

/**
 * Configuration options for the DSD-FME decoder.
 */
export interface DsdFmeOptions {
	/** Decoder mode - which digital voice protocol to decode */
	mode: DsdFmeMode
	/** Audio output destination */
	output: DsdFmeOutputType
	/** Directory for WAV file output (when output is 'wav') */
	wavDir?: string | undefined
	/** UDP host for audio output (when output is 'udp') */
	udpHost?: string | undefined
	/** UDP port for audio output (when output is 'udp') */
	udpPort?: number | undefined
	/** Additional command line arguments */
	extraArgs?: string[] | undefined
	/** IQ sample rate from source (default: 2400000) */
	inputSampleRate?: number | undefined
	/** FM Gain to apply (default: 2.0 for digital voice) */
	fmGain?: number | undefined
	/** Enable IQ-level AGC before FM demod (default: true, helps weak signals) */
	enableIqAgc?: boolean | undefined
	/** Enable per-call WAV recording (default: false) */
	enablePerCallRecording?: boolean | undefined
	/** Directory for per-call WAV files (default: /app/decoded_calls) */
	perCallRecordingDir?: string | undefined
}

/** All supported DSD-FME modes */
export const DSD_FME_MODES: readonly DsdFmeMode[] = [
	"auto",
	"dmr",
	"p25",
	"ysf",
	"dstar",
	"nxdn",
	"provoice",
] as const

// Output parsing regex patterns
// dsd-fme output format: "Sync: +DMR MS/DM MODE/MONO | Color Code=01 | VLC"
const SYNC_PATTERN = /Sync:\s*\+?([\w]+)/i // Captured group 1 is protocol
// Call info format: "SLOT 1 TGT=9 SRC=2060945 Group Call"
// Note: TGT and SRC are usually integers
const CALL_PATTERN = /TGT=(\d+)\s+SRC=(\d+)/i
// Slot extraction: "SLOT 1 ..."
const SLOT_PATTERN = /SLOT\s+(\d+)/i
const ERROR_PATTERN = /(FEC ERR|CRC ERR|SYNC LOST)/i
// Termination pattern (TLC = Terminator Link Control, or implicit End of transmission)
// Look for "TLC" or typical end messages.
const TERM_PATTERN = /\b(TLC|Terminator)\b/i

interface DsdFmeCallState {
	talkgroup: number
	source: number
	slot?: number
	startTime: Date
	lastUpdate: Date
	wavFile?: string
}

/**
 * DSD-FME Decoder - Decodes digital voice signals.
 *
 * Supports DMR, P25, YSF, D-Star, NXDN, and ProVoice protocols.
 * Parses dsd-fme output into structured sync, call, and error events.
 *
 * Now extends AudioDemodDecoder to consume IQ data directly and perform
 * optimal FM demodulation (12.5kHz NFM without de-emphasis) before
 * feeding audio to dsd-fme.
 */
export class DsdFmeDecoder extends AudioDemodDecoder {
	private readonly options: DsdFmeOptions

	// State for call tracking / deduplication
	private callState: DsdFmeCallState | null = null

	private lastSyncMode: string | null = null

	constructor(config: DecoderConfig, logger: Logger) {
		super(config, logger)
		this.options = this.parseOptions(config.options)
		// DSD-FME outputs data to stderr, and we route audio to stdout (which we drain)
		this.parseStdout = false
	}

	/**
	 * Parses and validates decoder options from config.
	 */
	private parseOptions(options: Record<string, unknown>): DsdFmeOptions {
		const mode = (options["mode"] as DsdFmeMode) ?? "auto"
		const output = (options["output"] as DsdFmeOutputType) ?? "null"

		// Validate mode
		if (!DSD_FME_MODES.includes(mode)) {
			this.logger.warn(
				{ mode, validModes: DSD_FME_MODES },
				"Invalid mode, defaulting to auto",
			)
		}

		return {
			mode: DSD_FME_MODES.includes(mode) ? mode : "auto",
			output,
			wavDir: options["wavDir"] as string | undefined,
			udpHost: options["udpHost"] as string | undefined,
			udpPort: options["udpPort"] as number | undefined,
			extraArgs: options["extraArgs"] as string[] | undefined,
			inputSampleRate: options["inputSampleRate"] as number | undefined,
			fmGain: options["fmGain"] as number | undefined,
			enableIqAgc: options["enableIqAgc"] as boolean | undefined,
			enablePerCallRecording:
				(options["enablePerCallRecording"] as boolean) ?? false,
			perCallRecordingDir:
				(options["perCallRecordingDir"] as string) ?? "/app/decoded_calls",
		}
	}

	/**
	 * Returns the demodulation configuration for DSD-FME.
	 * Uses 12.5kHz NFM bandwidth (via 48ksps demod rate) with no de-emphasis.
	 *
	 * Optimal gain tuning (tested with DMR IQ captures):
	 * - Gain 5.0 with limiter: 34 audio errors (best)
	 * - Gain 2.0 with limiter: 35 audio errors
	 * - Gain 0.5 no limiter: 80 audio errors
	 * - Gain 0.25 no limiter: 145 audio errors
	 *
	 * Higher gain + limiter provides better symbol detection for 4FSK.
	 * The limiter prevents hard clipping distortion.
	 *
	 * IQ AGC (2026-01-09): Enabled to help with weak signals. Theory is that
	 * IQ-level AGC normalizes envelope amplitude BEFORE FM demod, so frequency
	 * content (which is what FM extracts) should be preserved. May help decode
	 * weak signals without distorting 4FSK symbol levels as much as audio AGC.
	 */
	protected getDemodConfig(): DemodulationConfig {
		return {
			bandwidth: 12500, // 12.5 kHz NFM - standard for digital voice
			sampleRate: 48000, // 48 kHz output - dsd-fme native rate
			demodSampleRate: 48000, // Demod at 48ksps for proper bandwidth
			inputSampleRate: this.options.inputSampleRate ?? 2_400_000,
			deEmphasis: false, // Critical: no de-emphasis for digital signals
			fmGain: this.options.fmGain ?? 2.0, // Tuned: balanced gain minimizes clipping + FEC errors
			filterTransition: 0.05,
			enableIqAgc: this.options.enableIqAgc ?? true, // Try IQ AGC for weak signals
			// DC block is REQUIRED for DMR - centers 4FSK symbol levels
		}
	}

	/**
	 * Returns the decoder command.
	 * Note: This is only used for getDecoderArgs(), we override buildPipelineCommand()
	 * to handle the sox WAV wrapper needed by dsd-fme.
	 */
	protected getDecoderCommand(): string {
		return "dsd-fme"
	}

	/**
	 * Overrides buildPipelineCommand to add sox WAV wrapper.
	 *
	 * dsd-fme doesn't support raw S16LE stdin - it expects WAV format.
	 * We use sox to wrap the S16LE audio as a WAV stream before piping to dsd-fme.
	 *
	 * Pipeline: IQ -> csdr (demod at demodRate) -> S16LE -> sox (WAV wrapper) -> dsd-fme
	 */
	protected override buildPipelineCommand(): string {
		const config = this.getDemodConfig()

		// Determine rates
		const demodRate = config.demodSampleRate ?? config.sampleRate
		const outputRate = config.sampleRate
		const inputSampleRate = config.inputSampleRate || 2_400_000
		// IMPORTANT: csdr firdecimate requires integer decimation factor
		const decimation = Math.round(inputSampleRate / demodRate)
		// CRITICAL: Calculate ACTUAL demod rate after integer decimation
		// sox must use the ACTUAL rate, not the configured rate
		const actualDemodRate = inputSampleRate / decimation

		// Generate debug filename if debug recording is enabled
		const debugFile = this.debugRecording
			? `${this.debugRecording.path}/${this.getDebugFilename("final", "raw")}`
			: null

		// Build csdr pipeline stages (Using jketterl/csdr v0.18+ syntax)
		const transition = config.filterTransition ?? 0.05
		const csdrStages: string[] = [
			"csdr convert -i char -o float", // U8 IQ -> complex float
			`csdr firdecimate ${decimation} ${transition}`, // Decimate + filter (complex)
			"csdr fmdemod", // FM demod: complex -> real audio
		]

		// Optional DC block (skip for digital signals as it distorts them)
		if (!config.skipDcBlock) {
			csdrStages.push("csdr dcblock")
		}

		csdrStages.push(
			`csdr gain ${config.fmGain ?? 5.0}`, // Tuned: high gain with limiter for best 4FSK detection
			"csdr limit", // Essential: prevents clipping distortion at high gain
		)

		// Optional de-emphasis (should be false for digital voice)
		if (config.deEmphasis) {
			csdrStages.push(`csdr deemphasis ${actualDemodRate}`)
		}

		// Convert to S16LE audio
		csdrStages.push("csdr convert -i float -o s16")

		// Join csdr stages
		let pipelineStr = csdrStages.join(" | ")

		// DEBUG: Record raw audio at demod rate before sox processing
		if (debugFile && this.debugRecording) {
			pipelineStr += ` | tee "${debugFile}"`
			this.logger.warn(
				{ file: debugFile, rate: actualDemodRate },
				"DEBUG: Recording raw audio BEFORE sox",
			)
		}

		// Build sox command for WAV wrapper
		// CRITICAL: Use actualDemodRate (not configured rate) to match csdr output
		const soxCommand = [
			"sox",
			"-t raw",
			`-r ${actualDemodRate}`, // Input rate from csdr
			"-e signed -b 16 -c 1",
			"-",
			"-t wav",
			`-r ${outputRate}`, // Output rate for dsd-fme
			"-",
		].join(" ")

		pipelineStr += ` | ${soxCommand}`

		// Build dsd-fme command
		const dsdFmeArgs = this.getDecoderArgs()
		let dsdFmeCommand = `dsd-fme ${dsdFmeArgs.join(" ")}`

		// If per-call recording is enabled, ensure we run in the correct directory
		if (this.options.enablePerCallRecording) {
			const dir = this.options.perCallRecordingDir ?? "/app/decoded_calls"
			// We ensure directory exists and cd into it
			dsdFmeCommand = `(mkdir -p "${dir}" && cd "${dir}" && ${dsdFmeCommand})`
		}

		// Combine into full pipeline
		const pipeline = `${pipelineStr} | ${dsdFmeCommand}`

		this.logger.debug(
			{
				inputSampleRate,
				targetDemodRate: demodRate,
				actualDemodRate,
				outputSampleRate: outputRate,
				decimation,
				skipDcBlock: config.skipDcBlock,
				pipeline,
			},
			"Built dsd-fme pipeline with WAV wrapper",
		)

		return pipeline
	}

	/**
	 * Generates a timestamped filename for debug recordings.
	 */
	private getDebugFilename(stage: string, ext: string): string {
		const now = new Date()
		const ts = now
			.toISOString()
			.replace(/[:.]/g, "-")
			.replace("T", "_")
			.slice(0, 19)
		return `${ts}_${this.config.id}_${stage}.${ext}`
	}

	/**
	 * Returns decoder-specific command line arguments for dsd-fme.
	 * Note: We use /dev/stdin because dsd-fme reads WAV from stdin (via sox wrapper).
	 */
	protected getDecoderArgs(): string[] {
		const args: string[] = []

		// Input from stdin (receives WAV stream from sox)
		args.push("-i", "/dev/stdin")

		// Enable per-call recording if configured
		if (this.options.enablePerCallRecording) {
			args.push("-P")
		}

		// Set decoder mode with explicit flag
		switch (this.options.mode) {
			case "dmr":
				// DMR TDMA BS and MS Simplex
				args.push("-fs")
				break
			case "p25":
				// P25 Phase 1
				args.push("-f1")
				break
			case "ysf":
				args.push("-fy")
				break
			case "dstar":
				args.push("-fd")
				break
			case "nxdn":
				// NXDN96 (12.5 kHz)
				args.push("-fn")
				break
			case "provoice":
				args.push("-fp")
				break
			case "auto":
			default:
				// Auto-detection mode
				args.push("-fa")
				break
		}

		// Set output destination
		switch (this.options.output) {
			case "wav":
				if (this.options.wavDir) {
					args.push("-w", this.options.wavDir)
				}
				break
			case "udp":
				if (this.options.udpHost && this.options.udpPort) {
					args.push("-o", `udp:${this.options.udpHost}:${this.options.udpPort}`)
				}
				break
			case "null":
			default:
				// Disable audio output to avoid PulseAudio issues
				args.push("-o", "null")
				break
		}

		// Add any extra arguments
		if (this.options.extraArgs) {
			args.push(...this.options.extraArgs)
		}

		return args
	}

	/**
	 * Returns the decoder's capabilities (Requirement 17.1).
	 * DSD-FME now consumes IQ data (via AudioDemodDecoder's csdr pipeline).
	 */
	protected override getCaps(): DecoderCaps {
		return {
			input: "iq",
			wantsExclusiveSource: false,
			preferredSampleRates: [48000],
			output: "text",
			integrationPattern: "pure_consumer",
		}
	}

	/**
	 * Parses dsd-fme output lines into DecoderOutput objects.
	 *
	 * Handles:
	 * - Sync events
	 * - Call events (with deduplication)
	 * - Error events
	 */
	protected override parseOutput(line: string): DecoderOutput | null {
		const now = new Date()

		// FIRST: Check for stale calls on EVERY line, not just at the end
		// This ensures we detect call end even when receiving Sync/FEC lines
		if (this.callState) {
			const silenceDuration =
				now.getTime() - this.callState.lastUpdate.getTime()
			if (silenceDuration > 2000) {
				// 2 seconds without TGT/SRC = call ended
				const duration =
					this.callState.lastUpdate.getTime() -
					this.callState.startTime.getTime()
				const callInfo = this.callState
				this.callState = null

				this.logger.info(
					{
						talkgroup: callInfo.talkgroup,
						source: callInfo.source,
						duration,
						silenceDuration,
					},
					"Call ended due to metadata timeout",
				)

				// Emit call_end, then continue processing this line
				// (it might be a new call starting)
				return {
					timestamp: now,
					decoder: this.id,
					type: "call_end",
					data: {
						talkgroup: callInfo.talkgroup,
						source: callInfo.source,
						slot: callInfo.slot,
						duration,
						timeout: true,
					},
				}
			}
		}

		// Check for sync information
		const syncMatch = SYNC_PATTERN.exec(line)
		if (syncMatch) {
			const mode = syncMatch[1]?.toUpperCase() ?? "UNKNOWN"

			// Deduplicate Sync events: only emit if mode changed
			if (this.lastSyncMode === mode) {
				return null
			}

			this.lastSyncMode = mode

			return {
				timestamp: now,
				decoder: this.id,
				type: "sync",
				data: { mode },
			}
		}

		// Check for call information header
		const callMatch = CALL_PATTERN.exec(line)
		if (callMatch) {
			const talkgroup = parseInt(callMatch[1] ?? "0", 10)
			const source = parseInt(callMatch[2] ?? "0", 10)
			const slotMatch = SLOT_PATTERN.exec(line)
			const slot = slotMatch?.[1] ? parseInt(slotMatch[1], 10) : undefined

			// Detect if this is a new call or continuation
			const keyMatches =
				this.callState &&
				this.callState.talkgroup === talkgroup &&
				this.callState.source === source

			// If we have an active call but parameters changed, end the previous one
			if (this.callState && !keyMatches) {
				const duration = now.getTime() - this.callState.startTime.getTime()
				const endEvent: DecoderOutput = {
					timestamp: now,
					decoder: this.id,
					type: "call_end",
					data: {
						talkgroup: this.callState.talkgroup,
						source: this.callState.source,
						slot: this.callState.slot,
						duration,
						file: this.callState.wavFile,
					},
				}

				// Log the switch for debugging
				this.logger.info(
					{
						oldTg: this.callState.talkgroup,
						oldSrc: this.callState.source,
						newTg: talkgroup,
						newSrc: source,
					},
					"Call switch detected mid-stream, ending previous call",
				)

				// Force close old state
				this.callState = null

				// IMPORTANT: Return the end event for the OLD call.
				// The NEXT line from dsd-fme will trigger the new call's call_start.
				return endEvent
			}

			// Start new call if needed
			if (!this.callState) {
				// Construct filename if recording is enabled
				// Pattern: YYYYMMDD_HHMMSS_talkgroup_source.wav
				let wavFile: string | undefined
				if (this.options.enablePerCallRecording) {
					// We don't know the exact filename dsd-fme generates,
					// but standard format is often used or we could try to predict it.
					// For now, we'll leave it undefined.
				}

				// Create state object
				const newState: DsdFmeCallState = {
					talkgroup,
					source,
					startTime: now,
					lastUpdate: now,
				}

				// Handle optional properties respecting strict types
				if (wavFile !== undefined) {
					newState.wavFile = wavFile
				}
				if (slot !== undefined) {
					newState.slot = slot
				}

				this.callState = newState

				return {
					timestamp: now,
					decoder: this.id,
					type: "call_start",
					data: {
						talkgroup,
						source,
						slot,
					},
				}
			} else {
				// Existing call
				// Check if we have new information (e.g., slot was undefined and now we have it)
				if (this.callState.slot === undefined && slot !== undefined) {
					this.callState.slot = slot
					this.callState.lastUpdate = now

					// Re-emit call_start with fuller info so UI gets the slot
					// Alternatively we could add a "call_update" type, but call_start is idempotent-ish for this purpose
					return {
						timestamp: now,
						decoder: this.id,
						type: "call_start",
						data: {
							talkgroup,
							source,
							slot,
						},
					}
				}

				// Just update heartbeat
				this.callState.lastUpdate = now

				// Optional: Update slot if it was missing (already handled above, but good for safety)
				if (slot !== undefined && this.callState.slot === undefined) {
					this.callState.slot = slot
				}

				// SUPPRESS output (deduplication)
				return null
			}
		}

		// Check for Terminator (End of Call)
		const termMatch = TERM_PATTERN.exec(line)
		if (termMatch && this.callState) {
			const duration = now.getTime() - this.callState.startTime.getTime()
			const callInfo = this.callState
			this.callState = null // Clear state

			return {
				timestamp: now,
				decoder: this.id,
				type: "call_end",
				data: {
					talkgroup: callInfo.talkgroup,
					source: callInfo.source,
					slot: callInfo.slot,
					duration,
					// If we can parse the filename from dsd-fme output (sometimes it prints "Saving to..."),
					// we could add it here. For now, just basic stats.
				},
			}
		}

		// Check for error conditions
		const errorMatch = ERROR_PATTERN.exec(line)
		if (errorMatch) {
			// Optional: Don't emit errors if they are just FEC errors during a valid call?
			// User said "Resolve persistent FEC ERR".
			// We'll keep reporting them for now as they indicate signal quality issues.
			return {
				timestamp: now,
				decoder: this.id,
				type: "error",
				data: {
					message: errorMatch[1],
				},
			}
		}

		// Line didn't match any known pattern - skip it
		return null
	}
}

/**
 * Factory function for creating DSD-FME decoder instances.
 * Used by the DecoderRegistry.
 */
export function createDsdFmeDecoder(
	config: DecoderConfig,
	logger: Logger,
): DsdFmeDecoder {
	return new DsdFmeDecoder(config, logger)
}

/**
 * Capabilities for the DSD-FME decoder.
 * Used when registering with the DecoderRegistry.
 */
export const DSD_FME_CAPS: DecoderCaps = {
	input: "iq",
	wantsExclusiveSource: false,
	preferredSampleRates: [48000],
	output: "text",
	integrationPattern: "pure_consumer",
}
