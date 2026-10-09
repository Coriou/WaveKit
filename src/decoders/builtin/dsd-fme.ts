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
 *
 * Call Handling Philosophy:
 * - Sync is a CANDIDATE context, not an event. We track the protocol but don't emit call_start on sync alone.
 * - Calls require minimum metadata (TGT+SRC for DMR/P25/NXDN, callsigns for D-Star, etc.)
 * - Calls end via explicit terminator (DMR TLC, P25 TDULC), protocol switch, or a
 *   fallback timeout without any line from the call (default 4 s, callTimeoutMs).
 *   DMR prints at least one line per 360 ms voice superframe; the fallback bridges
 *   short sync losses inside one transmission.
 * - Short calls (< 250ms) with weak metadata are suppressed as likely false positives.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { z } from "zod"
import { shellArg, shellCommand } from "../process-tools.js"
import { boundCsdrPipeline } from "../csdr-buffers.js"
import {
	AudioDemodDecoder,
	audioDemodRates,
	type AudioDecoderStdin,
} from "../audio-demod-decoder.js"
import { deemphasisStage } from "../csdr-stages.js"
import { pruneCallRecordings } from "./call-recordings.js"
import type {
	DecoderCaps,
	DecoderConfig,
	DecoderOutput,
	DemodulationConfig,
} from "../types.js"
import type { Logger } from "../../utils/logger.js"

// =============================================================================
// REGEX PATTERNS - Protocol-specific patterns for parsing dsd-fme output
// =============================================================================

/** Strip ANSI escape codes from dsd-fme colored output */
const ANSI_ESCAPE = /\x1b\[[0-9;]*m/g

/** Extract optional timestamp prefix: "17:04:58" or "2025-04-22 23:29:15" (reserved for future use) */
const _TS_PATTERN = /^(?:(?:\d{4}-\d{2}-\d{2}\s+)?\d{1,2}:\d{2}:\d{2})\s+/

/** Sync detection: "Sync: +DMR", "Sync: +P25p1", etc. */
const SYNC_PATTERN = /\bSync:\s*(?<pol>[+-])(?<proto>[A-Za-z0-9]+)\b/i

/** Error conditions - FEC, CRC, sync lost */
const ERROR_PATTERN = /\b(FEC ERR|CRC ERR|SYNC LOST|no sync)\b/i

// --- DMR Patterns ---
/** DMR color code: "Color Code=05" */
const DMR_COLOR_CODE = /\bColor\s+Code\s*=\s*(?<cc>\d+)\b/i
/** DMR slot inline format: "slot1" or "slot2" */
const DMR_SLOT_INLINE = /\bslot(?<slot>[12])\b/i
/** DMR slot word format: "SLOT 1" or "SLOT 2" */
const DMR_SLOT_WORD = /\bSLOT\s+(?<slot>[12])\b/i
/** DMR TGT/SRC format: "TGT=9 SRC=2060945" or "TGT: 9; SRC: 2060945" */
const DMR_TGT_SRC = /\bTGT[:=]\s*(?<tgt>\d+)\b.*\bSRC[:=]\s*(?<src>\d+)\b/i
/** DMR Voice event: "DMR Voice TGT: 00009001; SRC: 00001133;" */
const DMR_VOICE_EVENT =
	/\bDMR\s+Voice\b.*\bTGT:\s*(?<tgt>\d+);\s*SRC:\s*(?<src>\d+);/i
/** DMR TLC fields: "FLCO=0x00 FID=0x00 SVC=0x00" */
const DMR_TLC_FIELDS =
	/\bFLCO=0x(?<flco>[0-9A-F]+)\b.*\bFID=0x(?<fid>[0-9A-F]+)\b.*\bSVC=0x(?<svc>[0-9A-F]+)\b/i
/**
 * DMR call termination. dsd-fme labels each data burst in a "| <type>" column
 * (dmr_dburst.c); "| TLC" is the Terminator with Link Control that ends every
 * voice transmission. Keyword forms are kept for other builds.
 */
const DMR_END_HINT =
	/\|\s*TLC\b|\b(Terminator|Call\s+Termination|GC\s+End|UC\s+End|End\s+Voice)\b/i
/** BS-mode burst slot marker: the current slot is bracketed, e.g. "[slot1]". */
const DMR_CURRENT_SLOT = /\[slot(?<slot>[12])\]/i
/**
 * DMR privacy. dmr_flco.c prints "Encrypted " for service option bit 0x40 on
 * the voice link control line (after "TGT=%u SRC=%u ", same line), so it only
 * counts on a line with TGT/SRC: "Slot N - Encrypted PDU" (dmr_block.c) is a
 * data burst. The PI header and late entry print "ALG ID: %02X;" without 0x
 * (dmr_pi.c, dmr_le.c). "SVC=0x.." only appears with -Z, which is not passed.
 */
const DMR_ENCRYPTED = /\bEncrypted\b/i
const ALG_ID = /\bALG(?:\s+ID)?:\s*(?:0x)?(?<alg>[0-9A-F]{2,4})\b/i
/** DMR service options: bit 0x40 is privacy (ETSI TS 102 361-2). */
const DMR_SVC_PRIVACY = 0x40
/**
 * extraArgs that would change the decoder mode or the audio output format
 * (and so desync the voice stream): -f* (mode), -o (output), -y (float audio).
 */
const RESERVED_EXTRA_ARG = /^-(?:f|o|y$)/

// --- P25 Phase 1 Patterns ---
/** P25 Phase 1 sync (reserved - protocol detection uses SYNC_PATTERN) */
const _P25P1_HEAD = /\bSync:\s*\+P25p1\b/i
/** P25 NAC: "nac: [ 1B]" */
const P25_NAC = /\bnac:\s*\[\s*(?<nac>[0-9A-Fa-f]+)\s*\]/i
/** P25 src/tg: "src: [      0] tg: [   0]" */
const P25_SRC_TG =
	/\bsrc:\s*\[\s*(?<src>\d+)\s*\]\s*tg:\s*\[\s*(?<tg>\d+)\s*\]/i
/** P25 frame types (reserved for enhanced frame analysis) */
const _P25P1_FRAME_TYPE = /\b(LDU1|LDU2|TDULC|TSBK|MPDU|TSDU|HDU)\b/i
/** P25 call termination */
const P25_CALL_TERM = /\b(Call\s+Termination|TDULC)\b/i

// --- P25 Phase 2 Patterns ---
/** P25 Phase 2 VCH: "VCH 0 - TG 7070 SRC 40820" */
const P25P2_VCH =
	/\bVCH\s+(?<vch>[01])\s*-\s*TG\s+(?<tg>\d+)\s+SRC\s+(?<src>\d+)\b/i
/**
 * P25 encryption indicators. ALG ID 0x80 is "unencrypted" (TIA-102.AAAD),
 * so the algorithm decides; an MI line alone does not.
 */
const P25_CRYPTO =
	/\bALG\s+ID:\s*(?:0x)?(?<alg>[0-9A-F]+)\b|\bKEY\s+ID:\s*(?:0x)?(?<key>[0-9A-F]+)\b|\bMI\b/i

// --- YSF Patterns ---
/** YSF sync (reserved - protocol detection uses SYNC_PATTERN) */
const _YSF_HEAD = /\bSync:\s*\+YSF\b/i
/** YSF FICH block (reserved - YSF_CRC_OK is preferred) */
const _YSF_FICH = /\bFICH\b/i
/** YSF CRC status in same line */
const YSF_CRC_OK = /\bFICH\b(?!.*CRC\s+ERR)/i

// --- NXDN Patterns ---
/** NXDN sync (reserved - protocol detection uses SYNC_PATTERN) */
const _NXDN_HEAD = /\bSync:\s*\+NXDN(?<rate>48|96)\b/i
/** NXDN RAN (Radio Access Number): "RAN=50" */
const NXDN_RAN = /\bRAN\s*=\s*(?<ran>\d+)\b/i
/** NXDN voice/data indicator */
const NXDN_VOICE_DATA = /\b(VOICE|DATA)\b/i
/** NXDN TGT/SRC for VCALL */
const NXDN_TGT_SRC = /\bTGT[:=]\s*(?<tgt>\d+)\b.*\bSRC[:=]\s*(?<src>\d+)\b/i

// --- D-Star Patterns ---
/** D-Star sync (reserved - protocol detection uses SYNC_PATTERN) */
const _DSTAR_HEAD = /\bSync:\s*\+DSTAR\b/i
/** D-Star header fields: MY, UR, RPT1, RPT2 */
const DSTAR_MY = /\bMY[:=]\s*(?<val>[A-Z0-9\/ ]{3,8})\b/i
const DSTAR_UR = /\bUR[:=]\s*(?<val>[A-Z0-9\/ ]{3,8})\b/i
const DSTAR_RPT1 = /\bRPT1[:=]\s*(?<val>[A-Z0-9\/ ]{3,8})\b/i
const DSTAR_RPT2 = /\bRPT2[:=]\s*(?<val>[A-Z0-9\/ ]{3,8})\b/i

// --- ProVoice Patterns ---
/** ProVoice sync (reserved - protocol detection uses SYNC_PATTERN) */
const _PROVOICE_HEAD = /\bSync:\s*[-+]ProVoice\b/i
/** Input level indicator */
const INLVL = /\binlvl:\s*(?<inlvl>\d+)%\b/i

// =============================================================================
// TYPES
// =============================================================================

/** Supported DSD-FME decoder modes (Requirement 6.5) */
export type DsdFmeMode =
	| "auto"
	| "dmr"
	| "p25"
	| "ysf"
	| "dstar"
	| "nxdn"
	| "provoice"

/**
 * Audio output destination options. "udp" streams decoded voice to
 * udpHost:udpPort (the digital voice stream binds it); "wav" writes per-call
 * WAV files to wavDir (dsd-fme `-7 <dir> -P`) with no live audio.
 */
export type DsdFmeOutputType = "null" | "wav" | "udp"

/** TDMA voice slots to synthesise (dsd-fme `-V 1|2|3`). */
export type DsdFmeVoiceSlot = 1 | 2 | "both"

const VoiceSlotSchema = z.preprocess(
	value => (value === "1" ? 1 : value === "2" ? 2 : value),
	z.union([z.literal(1), z.literal(2), z.literal("both")]),
)

/** dsd-fme `-V` argument for a voice slot selection. */
export function dsdFmeVoiceSlotArg(slot: DsdFmeVoiceSlot): "1" | "2" | "3" {
	return slot === 1 ? "1" : slot === 2 ? "2" : "3"
}

/**
 * Channels in dsd-fme's `-o udp` voice datagrams for a mode (measured on the
 * pinned build, see docs/DIGITAL-VOICE.md): stereo (slot 1 left, slot 2
 * right) for auto and DMR, mono for the single-channel protocols.
 */
export function dsdFmeUdpChannels(mode: DsdFmeMode): 1 | 2 {
	return mode === "auto" || mode === "dmr" ? 2 : 1
}

/**
 * Voice call state published on the decoder's "voice-call" event, in the
 * same tick as the call_start / call_end outputs (and when a running call
 * turns out to be encrypted). Times are ISO 8601.
 */
export interface DsdFmeVoiceCallState {
	callId: string
	protocol: Exclude<DsdFmeProtocol, null> | null
	talkgroup: number | null
	source: number | null
	slot: number | null
	encrypted: boolean
	active: boolean
	startedAt: string
	endedAt?: string
}

/** Default per-call recording retention. */
export const PER_CALL_RECORDING_MAX_TOTAL_MB = 512
export const PER_CALL_RECORDING_MAX_AGE_HOURS = 168

/** Protocol types detected by sync pattern */
export type DsdFmeProtocol =
	| "dmr"
	| "p25p1"
	| "p25p2"
	| "ysf"
	| "dstar"
	| "nxdn48"
	| "nxdn96"
	| "provoice"
	| null

/** DMR-specific metadata */
interface DmrMetadata {
	cc?: number | undefined // Color Code
	flco?: string | undefined
	fid?: string | undefined
	svc?: string | undefined
}

/** P25-specific metadata */
interface P25Metadata {
	nac?: string | undefined
	sysid?: string | undefined
	wacn?: string | undefined
	alg?: string | undefined
	keyId?: string | undefined
	mi?: string | undefined
}

/** NXDN-specific metadata */
interface NxdnMetadata {
	ran?: number | undefined
}

/** D-Star-specific metadata */
interface DStarMetadata {
	my?: string | undefined
	ur?: string | undefined
	rpt1?: string | undefined
	rpt2?: string | undefined
}

/** YSF-specific metadata */
interface YsfMetadata {
	mode?: string | undefined
	callsign?: string | undefined
}

/** Call quality metrics */
interface CallQuality {
	inlvl?: number | undefined
	crcErrs: number
	fecErrs: number
}

/** Call state flags */
interface CallFlags {
	encrypted: boolean
	timeout: boolean // Ended via timeout vs explicit terminator
	badSignal: boolean // High error rate
	falsePositiveSuppressed: boolean
}

/**
 * Unified call state for all protocols.
 * This captures the complete state of an active call.
 */
interface DsdFmeCallState {
	/** Stable id shared by call_start, call_end and voice-call events. */
	callId: string
	protocol: DsdFmeProtocol
	talkgroup: number | null
	source: number | null
	slot?: number | undefined
	startTime: Date
	lastUpdate: Date
	wavFile?: string | undefined
	// Protocol-specific metadata
	dmr?: DmrMetadata | undefined
	p25?: P25Metadata | undefined
	nxdn?: NxdnMetadata | undefined
	dstar?: DStarMetadata | undefined
	ysf?: YsfMetadata | undefined
	// Quality tracking
	quality: CallQuality
	// Flags
	flags: CallFlags
}

/**
 * Configuration options for the DSD-FME decoder.
 */
export interface DsdFmeOptions {
	/** Decoder mode - which digital voice protocol to decode */
	mode: DsdFmeMode
	/** Audio output destination */
	output: DsdFmeOutputType
	/** Directory for per-call WAV files when output is 'wav' (default: perCallRecordingDir) */
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
	/** Minimum call duration in ms to emit (default: 250) */
	minCallDurationMs?: number | undefined
	/** Emit debug events like sync/errors to output (default: false) */
	emitDebugEvents?: boolean | undefined
	/** Delay in ms before emitting call_start to accumulate metadata (default: 100) */
	callStartDelayMs?: number | undefined
	/** Fallback call end after this long without any line from the call (default: 4000) */
	callTimeoutMs?: number | undefined
	/** TDMA voice slots to synthesise (`-V`); omitted leaves dsd-fme's default (both) */
	voiceSlot?: DsdFmeVoiceSlot | undefined
	/** Per-call recordings: prune oldest beyond this total size (default: 512 MB) */
	perCallRecordingMaxTotalMb: number
	/** Per-call recordings: delete files older than this (default: 168 h) */
	perCallRecordingMaxAgeHours: number
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

/** Minimum call duration threshold (ms) - calls shorter than this are likely false positives */
const MIN_CALL_DURATION_MS = 250

/**
 * Fallback call end (ms) when no line from the call arrives for this long. Calls
 * normally end on the protocol terminator; this only bridges decode holes. The
 * former 2 s split one 10 s PTT into two calls on a 2.5 s sync loss.
 */
const CALL_TIMEOUT_MS = 4000

/**
 * After a terminator, dsd-fme prints the terminator's link control (same
 * TGT/SRC) on the very next line; it must not start a new call. The window
 * is short so a fast re-key by the same radio still starts a new call.
 */
const TERMINATOR_TRAILER_MS = 700

const PositiveMsSchema = z.number().finite().positive()

/** Error rate threshold - if > 80% frames have errors, mark as bad signal */
const BAD_SIGNAL_ERROR_RATE = 0.8

/** Rolling window for error rate calculation (ms) */
const ERROR_WINDOW_MS = 500

/** Interval for checking call timeout (ms) - check every 500ms */
const CALL_TIMEOUT_CHECK_INTERVAL_MS = 500

/** Delay before emitting call_start to accumulate metadata (ms) */
const CALL_START_DELAY_MS = 100

/** Prune per-call recordings this long after a call ends (dsd-fme closes the file). */
const RECORDING_PRUNE_DELAY_MS = 2000

/** Algorithm ids that mean "no encryption" (P25 0x80, DMR/none 0x00). */
function isClearAlgorithm(alg: string): boolean {
	const value = parseInt(alg, 16)
	return value === 0x80 || value === 0
}

/** Fields of the call_start / call_end data this decoder publishes. */
interface CallEventData {
	callId?: string
	startedAt?: string
	endedAt?: string
	encrypted?: boolean
	protocol?: DsdFmeProtocol
	talkgroup?: number | null
	source?: number | null
	slot?: number | undefined
	flags?: { encrypted?: boolean; wavFileUpdate?: boolean }
}

/** Error event for rolling window tracking */
interface ErrorEvent {
	timestamp: number
	type: "crc" | "fec"
}

/**
 * Pending call state - buffered before emitting call_start
 * Allows accumulating metadata (CC, FLCO, etc.) before emission
 */
interface PendingCall {
	state: DsdFmeCallState
	emitAfter: number // Timestamp when call_start should be emitted
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
	private options: DsdFmeOptions

	// Current protocol detected from sync (candidate context, not event)
	private currentProtocol: DsdFmeProtocol = null

	// Active call state (null = no call in progress)
	private callState: DsdFmeCallState | null = null

	// Pending call waiting for delayed emission (accumulating metadata)
	private pendingCall: PendingCall | null = null

	// Last sync mode for deduplication
	private lastSyncMode: string | null = null

	// Rolling window of error events for quality tracking
	private errorWindow: ErrorEvent[] = []

	// Frame count for error rate calculation
	private frameCount = 0

	// Timer for periodic call timeout checking
	private callTimeoutTimer: NodeJS.Timeout | null = null

	// Call that just ended on a terminator (suppresses its trailing LC line)
	// Per-decoder call sequence (part of callId)
	private callSeq = 0

	// Debounced per-call recording retention
	private pruneTimer: NodeJS.Timeout | null = null
	private pruning = false

	private recentlyTerminated: {
		protocol: DsdFmeProtocol
		talkgroup: number | null
		source: number | null
		untilMs: number
	} | null = null

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
			extraArgs: this.parseExtraArgs(options["extraArgs"]),
			inputSampleRate: options["inputSampleRate"] as number | undefined,
			fmGain: options["fmGain"] as number | undefined,
			enableIqAgc: options["enableIqAgc"] as boolean | undefined,
			enablePerCallRecording:
				(options["enablePerCallRecording"] as boolean) ?? false,
			perCallRecordingDir:
				(options["perCallRecordingDir"] as string) ?? "/app/decoded_calls",
			minCallDurationMs:
				(options["minCallDurationMs"] as number) ?? MIN_CALL_DURATION_MS,
			emitDebugEvents: (options["emitDebugEvents"] as boolean) ?? false,
			callStartDelayMs:
				(options["callStartDelayMs"] as number) ?? CALL_START_DELAY_MS,
			callTimeoutMs:
				PositiveMsSchema.safeParse(options["callTimeoutMs"]).data ??
				CALL_TIMEOUT_MS,
			voiceSlot: this.parseVoiceSlot(options["voiceSlot"]),
			perCallRecordingMaxTotalMb:
				PositiveMsSchema.safeParse(options["perCallRecordingMaxTotalMb"])
					.data ?? PER_CALL_RECORDING_MAX_TOTAL_MB,
			perCallRecordingMaxAgeHours:
				PositiveMsSchema.safeParse(options["perCallRecordingMaxAgeHours"])
					.data ?? PER_CALL_RECORDING_MAX_AGE_HOURS,
		}
	}

	private parseVoiceSlot(value: unknown): DsdFmeVoiceSlot | undefined {
		if (value === undefined) return undefined
		const parsed = VoiceSlotSchema.safeParse(value)
		if (parsed.success) return parsed.data
		this.logger.warn(
			{ voiceSlot: value },
			'Invalid voiceSlot (expected 1, 2 or "both"); using the dsd-fme default',
		)
		return undefined
	}

	/**
	 * Drops extraArgs that set the mode or the audio output (-f*, -o and its
	 * value, -y): WaveKit owns both, and the voice stream depends on them.
	 */
	private parseExtraArgs(value: unknown): string[] | undefined {
		if (!Array.isArray(value)) return undefined
		const kept: string[] = []
		const dropped: string[] = []
		for (let i = 0; i < value.length; i++) {
			const arg = String(value[i])
			if (RESERVED_EXTRA_ARG.test(arg)) {
				dropped.push(arg)
				// "-o <device>": the device is the next argument.
				if (arg === "-o" && i + 1 < value.length)
					dropped.push(String(value[++i]))
				continue
			}
			kept.push(arg)
		}
		if (dropped.length > 0) {
			this.logger.warn(
				{ dropped },
				"Ignoring extraArgs that set the dsd-fme mode or audio output",
			)
		}
		return kept
	}

	/**
	 * Absolute directory for per-call WAV files, or null when recording is off.
	 * Absolute because dsd-fme runs after `cd <dir>`: a relative -7 would nest.
	 */
	private recordingDir(): string | null {
		if (this.options.output === "wav") {
			return path.resolve(
				this.options.wavDir ??
					this.options.perCallRecordingDir ??
					"/app/decoded_calls",
			)
		}
		if (this.options.enablePerCallRecording) {
			return path.resolve(
				this.options.perCallRecordingDir ?? "/app/decoded_calls",
			)
		}
		return null
	}

	/**
	 * Re-parses options when updated dynamically (e.g., sample rate change).
	 * Called by BaseDecoder.updateOptions().
	 */
	protected override onOptionsUpdated(): void {
		this.options = this.parseOptions(this.config.options)
		this.logger.debug(
			{ inputSampleRate: this.options.inputSampleRate },
			"DSD-FME options re-parsed after update",
		)
	}

	/**
	 * Starts the decoder and sets up the call timeout timer.
	 * The timer periodically checks for stale calls and emits call_end events
	 * even when no new output is being received from dsd-fme.
	 */
	override async start(): Promise<void> {
		await super.start()

		// Start periodic call timeout check timer
		this.callTimeoutTimer = setInterval(() => {
			this.checkCallTimeoutAsync()
		}, CALL_TIMEOUT_CHECK_INTERVAL_MS)

		this.logger.debug("Call timeout timer started")
		this.schedulePrune(0)
	}

	/**
	 * Stops the decoder and cleans up resources.
	 * Ends any active call and clears the timeout timer.
	 */
	override async stop(): Promise<void> {
		// Clear the timeout timer
		if (this.callTimeoutTimer) {
			clearInterval(this.callTimeoutTimer)
			this.callTimeoutTimer = null
			this.logger.debug("Call timeout timer stopped")
		}

		if (this.pruneTimer) {
			clearTimeout(this.pruneTimer)
			this.pruneTimer = null
		}

		// End any active or pending call before stopping
		const now = new Date()
		if (this.pendingCall) {
			// Promote pending call to active and end it
			this.callState = this.pendingCall.state
			this.pendingCall = null
		}
		if (this.callState) {
			const endEvent = this.endCall(now, true)
			if (endEvent) {
				this.emitOutput(endEvent)
			}
		}

		await super.stop()
	}

	/**
	 * Publishes an output and, for call_start / call_end, the matching
	 * "voice-call" state in the same tick (the digital voice stream's call
	 * metadata is derived from exactly these events).
	 */
	protected override emitOutput(output: DecoderOutput): void {
		super.emitOutput(output)
		if (output.type !== "call_start" && output.type !== "call_end") return
		const data = output.data as CallEventData
		if (data.flags?.wavFileUpdate || data.callId === undefined) return
		const active = output.type === "call_start"
		const state: DsdFmeVoiceCallState = {
			callId: data.callId,
			protocol: data.protocol ?? null,
			talkgroup: data.talkgroup ?? null,
			source: data.source ?? null,
			slot: data.slot ?? null,
			encrypted: active
				? data.encrypted === true
				: data.flags?.encrypted === true,
			active,
			startedAt: data.startedAt ?? output.timestamp.toISOString(),
			...(data.endedAt !== undefined ? { endedAt: data.endedAt } : {}),
		}
		this.emit("voice-call", state)
		if (!active) this.schedulePrune(RECORDING_PRUNE_DELAY_MS)
	}

	/**
	 * Flags a call encrypted. An already announced call publishes the change
	 * on "voice-call" so its audio is muted from now on.
	 */
	private markEncrypted(call: DsdFmeCallState): void {
		if (call.flags.encrypted) return
		call.flags.encrypted = true
		this.logger.info(
			{
				callId: call.callId,
				protocol: call.protocol,
				talkgroup: call.talkgroup,
			},
			"Encrypted call: voice stays muted",
		)
		if (call !== this.callState) return
		const state: DsdFmeVoiceCallState = {
			callId: call.callId,
			protocol: call.protocol,
			talkgroup: call.talkgroup,
			source: call.source,
			slot: call.slot ?? null,
			encrypted: true,
			active: true,
			startedAt: call.startTime.toISOString(),
		}
		this.emit("voice-call", state)
	}

	/** Runs per-call recording retention after `delayMs` (debounced). */
	private schedulePrune(delayMs: number): void {
		const dir = this.recordingDir()
		if (dir === null || this.pruneTimer) return
		this.pruneTimer = setTimeout(() => {
			this.pruneTimer = null
			void this.pruneRecordings(dir)
		}, delayMs)
		this.pruneTimer.unref()
	}

	private async pruneRecordings(dir: string): Promise<void> {
		if (this.pruning) return
		this.pruning = true
		try {
			const result = await pruneCallRecordings([dir, path.join(dir, "WAV")], {
				maxTotalMb: this.options.perCallRecordingMaxTotalMb,
				maxAgeHours: this.options.perCallRecordingMaxAgeHours,
			})
			if (result.deleted.length > 0) {
				this.logger.info(
					{
						deleted: result.deleted.length,
						keptFiles: result.keptFiles,
						keptBytes: result.keptBytes,
					},
					"Pruned per-call recordings",
				)
			}
		} catch (err) {
			this.logger.warn({ err, dir }, "Per-call recording retention failed")
		} finally {
			this.pruning = false
		}
	}

	/**
	 * Checks for call timeout asynchronously (called by timer).
	 * Emits call_end event if a stale call is detected.
	 */
	private checkCallTimeoutAsync(): void {
		const now = new Date()
		const nowMs = now.getTime()

		// First, check if pending call should be promoted to active
		const promotedEvent = this.checkPendingCallEmission(now, nowMs)
		if (promotedEvent) {
			this.emitOutput(promotedEvent)
		}

		// Then check for call timeout
		const timeoutEvent = this.checkCallTimeout(now)
		if (timeoutEvent) {
			this.emitOutput(timeoutEvent)
		}
	}

	/**
	 * Checks if a pending call should be emitted as call_start.
	 * Returns call_start event if ready, null otherwise.
	 */
	private checkPendingCallEmission(
		now: Date,
		nowMs: number,
	): DecoderOutput | null {
		if (!this.pendingCall) return null

		// Check if delay has expired
		if (nowMs < this.pendingCall.emitAfter) return null

		// Promote pending call to active call
		this.callState = this.pendingCall.state
		this.pendingCall = null

		this.logger.info(
			{
				protocol: this.callState.protocol,
				talkgroup: this.callState.talkgroup,
				source: this.callState.source,
				slot: this.callState.slot,
				dmrCc: this.callState.dmr?.cc,
			},
			"Call started (after metadata accumulation)",
		)

		return {
			timestamp: now,
			decoder: this.id,
			type: "call_start",
			data: {
				callId: this.callState.callId,
				startedAt: this.callState.startTime.toISOString(),
				encrypted: this.callState.flags.encrypted,
				protocol: this.callState.protocol,
				talkgroup: this.callState.talkgroup,
				source: this.callState.source,
				slot: this.callState.slot,
				dmr: this.callState.dmr,
				p25: this.callState.p25,
				nxdn: this.callState.nxdn,
				dstar: this.callState.dstar,
				ysf: this.callState.ysf,
			},
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
			// No filterTransition: the decimation filter is matched to the 12.5 kHz
			// channel (a fixed 0.05 was ~102 kHz wide at 2.048 Msps).
			enableIqAgc: this.options.enableIqAgc ?? true, // Try IQ AGC for weak signals
			// No DC blocker: TDMA (DMR) arrives in 30 ms bursts, and between bursts
			// the discriminator sits on the receiver's DC spike (-offsetHz). csdr
			// dcblock (R 0.998, tau ~10 ms at 47.6 kHz) turned every burst's step
			// into a transient of ~2.4x the 4FSK decision half-spacing over its
			// first 10 ms (run8: AMBE errors 2460 vs 88, decoded voice 20.6 % vs
			// 1.0 % muted). dsd-fme tracks the symbol levels per burst itself.
			skipDcBlock: true,
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

	/** dsd-fme reads a sox WAV stream (S16LE mono) at the output rate. */
	protected override getDecoderStdin(): AudioDecoderStdin {
		return { format: "wav-s16le", rateHz: this.getDemodConfig().sampleRate }
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

		// Integer decimation to the ACTUAL demod rate (clamped to >= 1); sox must
		// use that rate. Shared with getRateAdapter() via audioDemodRates().
		const outputRate = config.sampleRate
		const { inputSampleRate, targetDemodRate, decimation, actualDemodRate } =
			audioDemodRates(config)

		// Generate debug filename if debug recording is enabled
		const debugFile = this.debugRecording
			? `${this.debugRecording.path}/${this.getDebugFilename("final", "raw")}`
			: null

		// Build csdr pipeline stages (Using jketterl/csdr v0.18+ syntax)
		// Channel IQ (cf32) has no front stages and starts at fmdemod.
		const front = this.buildIqFrontStages(config, inputSampleRate, decimation)
		const csdrStages: string[] = []
		if (front.convert) csdrStages.push(front.convert) // U8 IQ -> complex float
		if (front.shift) csdrStages.push(front.shift) // offsetHz -> DC
		if (front.decimate) csdrStages.push(front.decimate) // Channel-matched decimation (complex)
		csdrStages.push("csdr fmdemod") // FM demod: complex -> real audio

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
			csdrStages.push(deemphasisStage("nfm", actualDemodRate).stage)
		}

		// Convert to S16LE audio
		csdrStages.push("csdr convert -i float -o s16")

		// Join csdr stages
		let pipelineStr = boundCsdrPipeline(csdrStages, this.logger)

		// DEBUG: Record raw audio at demod rate before sox processing
		if (debugFile && this.debugRecording) {
			pipelineStr += ` | ${shellCommand("tee", [debugFile])}`
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
		let dsdFmeCommand = shellCommand("dsd-fme", dsdFmeArgs)

		// If per-call recording is enabled, ensure we run in the correct directory
		const dir = this.recordingDir()
		if (dir !== null) {
			// We ensure directory exists and cd into it
			dsdFmeCommand = `(mkdir -p ${shellArg(dir)} && cd ${shellArg(dir)} && ${dsdFmeCommand})`
		}

		// Combine into full pipeline
		const pipeline = `${pipelineStr} | ${dsdFmeCommand}`

		this.logger.debug(
			{
				inputSampleRate,
				targetDemodRate,
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

		// Per-call WAV files: -7 <dir> must precede -P (-w is one static file).
		const recordingDir = this.recordingDir()
		if (recordingDir !== null) {
			args.push("-7", recordingDir, "-P")
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

		// Set output destination. Never leave -o unset: dsd-fme defaults to
		// PulseAudio, which the container does not have.
		if (
			this.options.output === "udp" &&
			this.options.udpHost &&
			this.options.udpPort
		) {
			args.push("-o", `udp:${this.options.udpHost}:${this.options.udpPort}`)
		} else {
			if (this.options.output === "udp") {
				this.logger.warn(
					{ udpHost: this.options.udpHost, udpPort: this.options.udpPort },
					"output udp needs udpHost and udpPort; voice output disabled",
				)
			}
			args.push("-o", "null")
		}

		// TDMA voice slot selection (dsd-fme default is both).
		if (this.options.voiceSlot !== undefined) {
			args.push("-V", dsdFmeVoiceSlotArg(this.options.voiceSlot))
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
	 * Implementation follows these principles:
	 * 1. Sync is a CANDIDATE context, not an event - we track protocol but don't emit call_start
	 * 2. Calls require minimum metadata (TGT+SRC for DMR/P25/NXDN, callsigns for D-Star)
	 * 3. Calls end via explicit terminator, protocol switch, or 2-second metadata timeout
	 * 4. Short calls (< 250ms) with weak metadata are suppressed as likely false positives
	 * 5. Error events (FEC/CRC) are tracked for quality but not emitted unless debug mode is on
	 */
	protected override parseOutput(line: string): DecoderOutput | null {
		const now = new Date()
		const nowMs = now.getTime()

		// STEP 1: Strip ANSI escape codes from colored output
		const cleanLine = line.replace(ANSI_ESCAPE, "")

		// STEP 2: Check for stale calls (timeout-based call end). Publish the
		// end now and keep parsing: this line may start the next call.
		const timeoutEvent = this.checkCallTimeout(now)
		if (timeoutEvent) {
			this.emitOutput(timeoutEvent)
		}

		// STEP 3: Track errors for quality metrics (rolling window)
		this.updateErrorWindow(cleanLine, nowMs)

		// STEP 4: Check for sync (protocol detection)
		const syncResult = this.handleSync(cleanLine, now)
		if (syncResult !== undefined) {
			return syncResult
		}

		// STEP 5: Protocol-specific call handling
		const callEvent = this.handleProtocolLine(cleanLine, now)
		if (callEvent) {
			return callEvent
		}

		// STEP 6: Check for explicit call termination
		const termEvent = this.handleTermination(cleanLine, now)
		if (termEvent) {
			return termEvent
		}

		// STEP 7: Emit error events only in debug mode
		if (this.options.emitDebugEvents) {
			const errorMatch = ERROR_PATTERN.exec(cleanLine)
			if (errorMatch) {
				return {
					timestamp: now,
					decoder: this.id,
					type: "error",
					data: { message: errorMatch[1] },
				}
			}
		}

		// Line didn't produce an event
		return null
	}

	// =========================================================================
	// HELPER METHODS FOR parseOutput
	// =========================================================================

	/**
	 * Checks if the current call has timed out (no metadata for CALL_TIMEOUT_MS).
	 * Also handles pending calls that have been abandoned.
	 * Returns a call_end event if timeout occurred, otherwise null.
	 */
	private checkCallTimeout(now: Date): DecoderOutput | null {
		// Check pending call timeout (promote and end if stale)
		if (this.pendingCall && !this.callState) {
			const pendingSilence =
				now.getTime() - this.pendingCall.state.lastUpdate.getTime()
			if (pendingSilence > this.callTimeoutMs()) {
				// Promote pending to active and end it
				this.callState = this.pendingCall.state
				this.pendingCall = null
				return this.endCall(now, true)
			}
		}

		// Check active call timeout
		if (!this.callState) return null

		const silenceDuration = now.getTime() - this.callState.lastUpdate.getTime()
		if (silenceDuration <= this.callTimeoutMs()) return null

		return this.endCall(now, true)
	}

	private callTimeoutMs(): number {
		return this.options.callTimeoutMs ?? CALL_TIMEOUT_MS
	}

	/**
	 * Updates the rolling error window for quality tracking.
	 * Tracks errors for both active and pending calls.
	 */
	private updateErrorWindow(line: string, nowMs: number): void {
		// Prune old errors outside the window
		this.errorWindow = this.errorWindow.filter(
			e => nowMs - e.timestamp < ERROR_WINDOW_MS,
		)

		// Get the call state to update (active call takes precedence, then pending)
		const targetCall = this.callState ?? this.pendingCall?.state ?? null

		// Track FEC errors
		if (/\bFEC\s+ERR\b/i.test(line)) {
			this.errorWindow.push({ timestamp: nowMs, type: "fec" })
			if (targetCall) {
				targetCall.quality.fecErrs++
			}
		}

		// Track CRC errors
		if (/\bCRC\s+ERR\b/i.test(line)) {
			this.errorWindow.push({ timestamp: nowMs, type: "crc" })
			if (targetCall) {
				targetCall.quality.crcErrs++
			}
		}

		// Increment frame count for error rate calculation
		this.frameCount++
	}

	/**
	 * Handles sync line - updates currentProtocol but does NOT start a call.
	 * Returns undefined to continue processing, or a DecoderOutput for debug events.
	 */
	private handleSync(
		line: string,
		now: Date,
	): DecoderOutput | null | undefined {
		const syncMatch = SYNC_PATTERN.exec(line)
		if (!syncMatch?.groups) return undefined

		const proto = syncMatch.groups["proto"]?.toUpperCase() ?? ""
		const newProtocol = this.parseProtocol(proto)

		// If protocol changed, we may need to end the current call
		if (this.callState && newProtocol !== this.currentProtocol) {
			const endEvent = this.endCall(now, false)
			this.currentProtocol = newProtocol
			this.lastSyncMode = proto
			return endEvent
		}

		// Update protocol tracking
		this.currentProtocol = newProtocol

		// Deduplicate sync events for debug output
		if (proto === this.lastSyncMode) {
			return undefined
		}
		this.lastSyncMode = proto

		// Only emit sync events in debug mode
		if (this.options.emitDebugEvents) {
			return {
				timestamp: now,
				decoder: this.id,
				type: "sync",
				data: { mode: proto, protocol: newProtocol },
			}
		}

		// Keep parsing: a sync line also carries the burst type (VLC/VC*/TLC).
		return undefined
	}

	/**
	 * Parses protocol string from sync output to typed protocol.
	 */
	private parseProtocol(proto: string): DsdFmeProtocol {
		const upper = proto.toUpperCase()
		if (upper === "DMR") return "dmr"
		if (upper === "P25P1" || upper === "P25") return "p25p1"
		if (upper === "P25P2") return "p25p2"
		if (upper === "YSF") return "ysf"
		if (upper === "DSTAR") return "dstar"
		if (upper === "NXDN48") return "nxdn48"
		if (upper === "NXDN96") return "nxdn96"
		if (upper === "PROVOICE") return "provoice"
		// Also handle NXDN without rate suffix
		if (upper === "NXDN") return "nxdn96" // Default to 96
		return null
	}

	/**
	 * Handles protocol-specific line parsing and call state management.
	 * Routes to appropriate handler based on currentProtocol.
	 */
	private handleProtocolLine(line: string, now: Date): DecoderOutput | null {
		switch (this.currentProtocol) {
			case "dmr":
				return this.handleDmrLine(line, now)
			case "p25p1":
				return this.handleP25P1Line(line, now)
			case "p25p2":
				return this.handleP25P2Line(line, now)
			case "nxdn48":
			case "nxdn96":
				return this.handleNxdnLine(line, now)
			case "ysf":
				return this.handleYsfLine(line, now)
			case "dstar":
				return this.handleDStarLine(line, now)
			case "provoice":
				return this.handleProVoiceLine(line, now)
			default:
				// No protocol detected yet, try to extract metadata anyway
				return this.handleUnknownProtocol(line, now)
		}
	}

	/**
	 * Handles DMR-specific line parsing.
	 * Requires TGT+SRC to start a call.
	 */
	private handleDmrLine(line: string, now: Date): DecoderOutput | null {
		// Try to extract TGT/SRC from various DMR formats
		let tgt: number | null = null
		let src: number | null = null
		let slot: number | undefined

		// Format 1: "DMR Voice TGT: 00009001; SRC: 00001133;"
		const voiceMatch = DMR_VOICE_EVENT.exec(line)
		if (voiceMatch?.groups) {
			tgt = parseInt(voiceMatch.groups["tgt"] ?? "0", 10)
			src = parseInt(voiceMatch.groups["src"] ?? "0", 10)
		}

		// Format 2: "TGT=9 SRC=2060945" or "TGT: 9; SRC: 2060945"
		if (tgt === null) {
			const tgtSrcMatch = DMR_TGT_SRC.exec(line)
			if (tgtSrcMatch?.groups) {
				tgt = parseInt(tgtSrcMatch.groups["tgt"] ?? "0", 10)
				src = parseInt(tgtSrcMatch.groups["src"] ?? "0", 10)
			}
		}

		// Extract slot
		const slotInline = DMR_SLOT_INLINE.exec(line)
		const slotWord = DMR_SLOT_WORD.exec(line)
		slot = slotInline?.groups?.["slot"]
			? parseInt(slotInline.groups["slot"], 10)
			: slotWord?.groups?.["slot"]
				? parseInt(slotWord.groups["slot"], 10)
				: undefined

		// Extract color code
		const ccMatch = DMR_COLOR_CODE.exec(line)
		const cc = ccMatch?.groups?.["cc"]
			? parseInt(ccMatch.groups["cc"], 10)
			: undefined

		// Extract TLC fields if present
		const tlcMatch = DMR_TLC_FIELDS.exec(line)
		const dmrMeta: DmrMetadata | undefined = tlcMatch?.groups
			? {
					flco: tlcMatch.groups["flco"],
					fid: tlcMatch.groups["fid"],
					svc: tlcMatch.groups["svc"],
				}
			: cc !== undefined
				? { cc }
				: undefined

		const svc = tlcMatch?.groups?.["svc"]
		const alg = ALG_ID.exec(line)?.groups?.["alg"]
		const encrypted =
			(tgt !== null && DMR_ENCRYPTED.test(line)) ||
			(svc !== undefined && (parseInt(svc, 16) & DMR_SVC_PRIVACY) !== 0) ||
			(alg !== undefined && !isClearAlgorithm(alg))

		// If we have TGT+SRC, process call state
		if (tgt !== null && src !== null) {
			const event = this.processCallMetadata(
				now,
				"dmr",
				tgt,
				src,
				slot,
				dmrMeta,
			)
			if (encrypted) this.markDmrEncrypted(slot)
			return event
		}
		if (encrypted) this.markDmrEncrypted(slot)

		// Any DMR line (voice superframe, data burst) keeps the call alive.
		const ongoing = this.callState ?? this.pendingCall?.state ?? null
		if (ongoing && ongoing.protocol === "dmr") {
			if (cc !== undefined && !ongoing.dmr?.cc) {
				ongoing.dmr = { ...ongoing.dmr, cc }
			}
			if (slot !== undefined && ongoing.slot === undefined) {
				ongoing.slot = slot
			}
			ongoing.lastUpdate = now
		}

		return null
	}

	/** Marks the ongoing DMR call encrypted (unless the line is for the other slot). */
	private markDmrEncrypted(slot: number | undefined): void {
		const call = this.callState ?? this.pendingCall?.state ?? null
		if (!call || call.protocol !== "dmr") return
		if (slot !== undefined && call.slot !== undefined && slot !== call.slot) {
			return
		}
		this.markEncrypted(call)
	}

	/** Applies a P25 crypto line (ALG/KEY ID) to the ongoing call of `protocol`. */
	private applyP25Crypto(line: string, protocol: "p25p1" | "p25p2"): void {
		const cryptoMatch = P25_CRYPTO.exec(line)
		if (!cryptoMatch) return
		const call = this.callState ?? this.pendingCall?.state ?? null
		if (!call || call.protocol !== protocol) return
		const alg = ALG_ID.exec(line)?.groups?.["alg"]
		const keyId = cryptoMatch.groups?.["key"]
		if (alg !== undefined) call.p25 = { ...call.p25, alg }
		if (keyId !== undefined) call.p25 = { ...call.p25, keyId }
		if (alg !== undefined && !isClearAlgorithm(alg)) this.markEncrypted(call)
	}

	/**
	 * Handles P25 Phase 1 line parsing.
	 * Requires tg+src to start a call.
	 */
	private handleP25P1Line(line: string, now: Date): DecoderOutput | null {
		// Extract NAC
		const nacMatch = P25_NAC.exec(line)
		const nac = nacMatch?.groups?.["nac"]

		// Extract src/tg
		const srcTgMatch = P25_SRC_TG.exec(line)
		if (srcTgMatch?.groups) {
			const tg = parseInt(srcTgMatch.groups["tg"] ?? "0", 10)
			const src = parseInt(srcTgMatch.groups["src"] ?? "0", 10)

			// Only process if we have valid identifiers (not all zeros)
			if (tg > 0 || src > 0) {
				const p25Meta: P25Metadata | undefined = nac ? { nac } : undefined
				return this.processCallMetadata(
					now,
					"p25p1",
					tg,
					src,
					undefined,
					undefined,
					p25Meta,
				)
			}
		}

		// Check for encryption indicators
		this.applyP25Crypto(line, "p25p1")

		return null
	}

	/**
	 * Handles P25 Phase 2 line parsing.
	 * Uses VCH format: "VCH 0 - TG 7070 SRC 40820"
	 */
	private handleP25P2Line(line: string, now: Date): DecoderOutput | null {
		const vchMatch = P25P2_VCH.exec(line)
		if (vchMatch?.groups) {
			const tg = parseInt(vchMatch.groups["tg"] ?? "0", 10)
			const src = parseInt(vchMatch.groups["src"] ?? "0", 10)
			const vch = parseInt(vchMatch.groups["vch"] ?? "0", 10)

			if (tg > 0 || src > 0) {
				return this.processCallMetadata(
					now,
					"p25p2",
					tg,
					src,
					vch, // VCH acts like slot
				)
			}
		}

		// Check encryption
		this.applyP25Crypto(line, "p25p2")

		return null
	}

	/**
	 * Handles NXDN line parsing.
	 * Requires RAN + VOICE indicator, optionally TGT/SRC.
	 */
	private handleNxdnLine(line: string, now: Date): DecoderOutput | null {
		// Check for VOICE indicator (required for call)
		if (!NXDN_VOICE_DATA.test(line) || !/\bVOICE\b/i.test(line)) {
			return null
		}

		// Extract RAN
		const ranMatch = NXDN_RAN.exec(line)
		const ran = ranMatch?.groups?.["ran"]
			? parseInt(ranMatch.groups["ran"], 10)
			: undefined

		// Try to extract TGT/SRC
		const tgtSrcMatch = NXDN_TGT_SRC.exec(line)
		let tgt: number | null = null
		let src: number | null = null
		if (tgtSrcMatch?.groups) {
			tgt = parseInt(tgtSrcMatch.groups["tgt"] ?? "0", 10)
			src = parseInt(tgtSrcMatch.groups["src"] ?? "0", 10)
		}

		// For NXDN, we can start a call with just VOICE + RAN
		if (ran !== undefined) {
			const nxdnMeta: NxdnMetadata = { ran }
			return this.processCallMetadata(
				now,
				this.currentProtocol as "nxdn48" | "nxdn96",
				tgt ?? 0,
				src ?? 0,
				undefined,
				undefined,
				undefined,
				nxdnMeta,
			)
		}

		return null
	}

	/**
	 * Handles YSF line parsing.
	 * Requires at least one CRC-OK FICH block to start a call.
	 */
	private handleYsfLine(line: string, now: Date): DecoderOutput | null {
		// YSF requires a CRC-OK FICH block to be considered valid
		if (!YSF_CRC_OK.test(line)) {
			return null
		}

		// YSF doesn't have traditional TGT/SRC, but we track calls anyway
		// Use 0 as placeholder for talkgroup/source
		return this.processCallMetadata(now, "ysf", 0, 0)
	}

	/**
	 * Handles D-Star line parsing.
	 * Requires MY/UR/RPT1/RPT2 header fields to start a call.
	 */
	private handleDStarLine(line: string, now: Date): DecoderOutput | null {
		// Extract D-Star header fields
		const myMatch = DSTAR_MY.exec(line)
		const urMatch = DSTAR_UR.exec(line)
		const rpt1Match = DSTAR_RPT1.exec(line)
		const rpt2Match = DSTAR_RPT2.exec(line)

		const my = myMatch?.groups?.["val"]?.trim()
		const ur = urMatch?.groups?.["val"]?.trim()
		const rpt1 = rpt1Match?.groups?.["val"]?.trim()
		const rpt2 = rpt2Match?.groups?.["val"]?.trim()

		// Need at least one field to consider this a valid call
		if (my ?? ur ?? rpt1 ?? rpt2) {
			const dstarMeta: DStarMetadata = { my, ur, rpt1, rpt2 }
			return this.processCallMetadata(
				now,
				"dstar",
				0,
				0,
				undefined,
				undefined,
				undefined,
				undefined,
				dstarMeta,
			)
		}

		return null
	}

	/**
	 * Handles ProVoice line parsing.
	 * Requires VOICE indicator and reasonable input level.
	 */
	private handleProVoiceLine(line: string, now: Date): DecoderOutput | null {
		// Check for VOICE indicator
		if (!/\bVOICE\b/i.test(line)) {
			return null
		}

		// Extract input level
		const inlvlMatch = INLVL.exec(line)
		const inlvl = inlvlMatch?.groups?.["inlvl"]
			? parseInt(inlvlMatch.groups["inlvl"], 10)
			: undefined

		// Require minimum input level (e.g., > 10%) to filter noise
		if (inlvl !== undefined && inlvl > 10) {
			return this.processCallMetadata(now, "provoice", 0, 0)
		}

		return null
	}

	/**
	 * Handles lines when no protocol has been detected yet.
	 * Tries to detect protocol from metadata patterns.
	 */
	private handleUnknownProtocol(line: string, now: Date): DecoderOutput | null {
		// Try DMR patterns
		const dmrVoice = DMR_VOICE_EVENT.exec(line)
		if (dmrVoice?.groups) {
			this.currentProtocol = "dmr"
			return this.handleDmrLine(line, now)
		}

		// Try P25P2 VCH
		if (P25P2_VCH.test(line)) {
			this.currentProtocol = "p25p2"
			return this.handleP25P2Line(line, now)
		}

		// Try P25P1
		if (P25_SRC_TG.test(line)) {
			this.currentProtocol = "p25p1"
			return this.handleP25P1Line(line, now)
		}

		return null
	}

	/**
	 * Checks for explicit call termination patterns.
	 * Handles both active and pending calls.
	 */
	private handleTermination(line: string, now: Date): DecoderOutput | null {
		// Get target call (active or pending)
		const targetCall = this.callState ?? this.pendingCall?.state ?? null
		if (!targetCall) return null

		// Protocol-specific termination patterns
		let isTerminator = false

		switch (targetCall.protocol) {
			case "dmr": {
				// In BS (repeater) mode only the bracketed slot's terminator counts.
				const burstSlot = DMR_CURRENT_SLOT.exec(line)?.groups?.["slot"]
				isTerminator =
					DMR_END_HINT.test(line) &&
					(burstSlot === undefined ||
						targetCall.slot === undefined ||
						Number(burstSlot) === targetCall.slot)
				break
			}
			case "p25p1":
			case "p25p2":
				isTerminator = P25_CALL_TERM.test(line)
				break
			default:
				// Other protocols mostly rely on timeout
				break
		}

		if (isTerminator) {
			// If we have a pending call, promote it first so we can end it properly
			if (this.pendingCall && !this.callState) {
				this.callState = this.pendingCall.state
				this.pendingCall = null
			}
			this.recentlyTerminated = {
				protocol: targetCall.protocol,
				talkgroup: targetCall.talkgroup,
				source: targetCall.source,
				untilMs: now.getTime() + TERMINATOR_TRAILER_MS,
			}
			return this.endCall(now, false)
		}

		return null
	}

	/**
	 * Processes call metadata and manages call state.
	 * Uses delayed emission pattern: buffers metadata before emitting call_start
	 * to accumulate CC, FLCO, and other metadata that may arrive on subsequent lines.
	 */
	private processCallMetadata(
		now: Date,
		protocol: NonNullable<DsdFmeProtocol>,
		tgt: number,
		src: number,
		slot?: number,
		dmr?: DmrMetadata,
		p25?: P25Metadata,
		nxdn?: NxdnMetadata,
		dstar?: DStarMetadata,
		ysf?: YsfMetadata,
	): DecoderOutput | null {
		const nowMs = now.getTime()

		// Check if we have an active call that matches
		const activeKeyMatches =
			this.callState &&
			this.callState.protocol === protocol &&
			this.callState.talkgroup === tgt &&
			this.callState.source === src

		// Check if we have a pending call that matches
		const pendingKeyMatches =
			this.pendingCall &&
			this.pendingCall.state.protocol === protocol &&
			this.pendingCall.state.talkgroup === tgt &&
			this.pendingCall.state.source === src

		// Case 1: Active call with matching key - update metadata
		if (activeKeyMatches && this.callState) {
			this.callState.lastUpdate = now
			if (slot !== undefined && this.callState.slot === undefined) {
				this.callState.slot = slot
			}
			if (dmr) {
				this.callState.dmr = { ...this.callState.dmr, ...dmr }
			}
			if (p25) {
				this.callState.p25 = { ...this.callState.p25, ...p25 }
			}
			if (nxdn) {
				this.callState.nxdn = { ...this.callState.nxdn, ...nxdn }
			}
			if (dstar) {
				this.callState.dstar = { ...this.callState.dstar, ...dstar }
			}
			if (ysf) {
				this.callState.ysf = { ...this.callState.ysf, ...ysf }
			}
			return null // No new event, just updated metadata
		}

		// Case 2: Pending call with matching key - update metadata, extend delay
		if (pendingKeyMatches && this.pendingCall) {
			this.pendingCall.state.lastUpdate = now
			if (slot !== undefined && this.pendingCall.state.slot === undefined) {
				this.pendingCall.state.slot = slot
			}
			if (dmr) {
				this.pendingCall.state.dmr = {
					...this.pendingCall.state.dmr,
					...dmr,
				}
			}
			if (p25) {
				this.pendingCall.state.p25 = {
					...this.pendingCall.state.p25,
					...p25,
				}
			}
			if (nxdn) {
				this.pendingCall.state.nxdn = {
					...this.pendingCall.state.nxdn,
					...nxdn,
				}
			}
			if (dstar) {
				this.pendingCall.state.dstar = {
					...this.pendingCall.state.dstar,
					...dstar,
				}
			}
			if (ysf) {
				this.pendingCall.state.ysf = {
					...this.pendingCall.state.ysf,
					...ysf,
				}
			}
			return null // No new event, metadata accumulated in pending call
		}

		// The terminator's own link control (same key, right after it) is not a new call.
		const trailer = this.recentlyTerminated
		if (
			!this.callState &&
			!this.pendingCall &&
			trailer &&
			nowMs <= trailer.untilMs &&
			trailer.protocol === protocol &&
			trailer.talkgroup === tgt &&
			trailer.source === src
		) {
			this.recentlyTerminated = null
			return null
		}

		// Case 3: Different call detected - end previous, start new pending
		if (this.callState) {
			const endEvent = this.endCall(now, false)
			this.logger.debug(
				{
					oldProtocol: this.callState?.protocol,
					oldTg: this.callState?.talkgroup,
					oldSrc: this.callState?.source,
					newProtocol: protocol,
					newTg: tgt,
					newSrc: src,
				},
				"Call switch detected, ending previous call",
			)
			// Start new pending call
			this.startPendingCall(
				now,
				nowMs,
				protocol,
				tgt,
				src,
				slot,
				dmr,
				p25,
				nxdn,
				dstar,
				ysf,
			)
			return endEvent
		}

		// Case 4: Different pending call - discard old, start new
		if (this.pendingCall) {
			this.logger.debug(
				{
					oldProtocol: this.pendingCall.state.protocol,
					oldTg: this.pendingCall.state.talkgroup,
					newProtocol: protocol,
					newTg: tgt,
				},
				"New call before pending emitted, discarding previous",
			)
			this.pendingCall = null
		}

		// Case 5: No active or pending call - start new pending call
		this.startPendingCall(
			now,
			nowMs,
			protocol,
			tgt,
			src,
			slot,
			dmr,
			p25,
			nxdn,
			dstar,
			ysf,
		)
		return null // call_start will be emitted after delay
	}

	/**
	 * Creates a new pending call that will be emitted after the configured delay.
	 */
	private startPendingCall(
		now: Date,
		nowMs: number,
		protocol: NonNullable<DsdFmeProtocol>,
		tgt: number,
		src: number,
		slot?: number,
		dmr?: DmrMetadata,
		p25?: P25Metadata,
		nxdn?: NxdnMetadata,
		dstar?: DStarMetadata,
		ysf?: YsfMetadata,
	): void {
		const delayMs = this.options.callStartDelayMs ?? CALL_START_DELAY_MS

		this.pendingCall = {
			state: {
				callId: `${this.id}-${nowMs.toString(36)}-${++this.callSeq}`,
				protocol,
				talkgroup: tgt,
				source: src,
				slot,
				startTime: now,
				lastUpdate: now,
				dmr,
				p25,
				nxdn,
				dstar,
				ysf,
				quality: { crcErrs: 0, fecErrs: 0 },
				flags: {
					encrypted: false,
					timeout: false,
					badSignal: false,
					falsePositiveSuppressed: false,
				},
			},
			emitAfter: nowMs + delayMs,
		}

		this.logger.debug(
			{ protocol, tgt, src, slot, delayMs },
			"Pending call created, will emit after delay",
		)
	}

	/**
	 * Finds the WAV file created by dsd-fme for a completed call.
	 *
	 * dsd-fme filename format: YYYYMMDD_HHMMSS_XXXXX_PROTO_CC_N_CALLTYPE_TGT_N_SRC_N.wav
	 * Where XXXXX is an internal frame ID we cannot predict.
	 *
	 * Strategy:
	 * 1. Build a regex pattern from known call metadata (proto, CC, TGT, SRC)
	 * 2. Search in the recording directory AND common subdirectories (dsd-fme creates WAV/)
	 * 3. Filter files matching the pattern with timestamps within call window (±10s tolerance)
	 * 4. Return the best match (prefer exact timestamp match, then closest)
	 */
	private findWavFile(
		call: DsdFmeCallState,
		callEndTime: Date,
	): string | undefined {
		const baseDir = this.recordingDir()
		if (baseDir === null) return undefined

		// dsd-fme creates a WAV subdirectory inside the output directory
		// Search in both the base directory and common subdirectories
		const dirsToSearch = [
			baseDir,
			path.join(baseDir, "WAV"),
			path.join(baseDir, "wav"),
		]

		for (const dir of dirsToSearch) {
			const result = this.searchForWavFile(call, callEndTime, dir)
			if (result) return result
		}

		return undefined
	}

	/**
	 * Async WAV file search with retries.
	 * dsd-fme may still be writing the file when call ends, so we retry a few times.
	 * Emits a wav_file event when the file is found.
	 */
	private findWavFileAsync(call: DsdFmeCallState, callEndTime: Date): void {
		const baseDir = this.recordingDir()
		if (baseDir === null) return

		// dsd-fme creates a WAV subdirectory inside the output directory
		const dirsToSearch = [
			baseDir,
			path.join(baseDir, "WAV"),
			path.join(baseDir, "wav"),
		]

		const maxRetries = 5
		const retryDelayMs = 200 // 200ms between retries = up to 1 second total

		let attempt = 0
		const tryFind = (): void => {
			attempt++

			// Search all directories
			for (const dir of dirsToSearch) {
				const wavFile = this.searchForWavFile(call, callEndTime, dir)
				if (wavFile) {
					// Found it! Emit an event so the UI can update
					this.emitOutput({
						timestamp: new Date(),
						decoder: this.id,
						type: "call_end",
						data: {
							callId: call.callId,
							startedAt: call.startTime.toISOString(),
							endedAt: callEndTime.toISOString(),
							protocol: call.protocol,
							talkgroup: call.talkgroup,
							source: call.source,
							slot: call.slot,
							duration: callEndTime.getTime() - call.startTime.getTime(),
							dmr: call.dmr,
							p25: call.p25,
							nxdn: call.nxdn,
							dstar: call.dstar,
							ysf: call.ysf,
							quality: call.quality,
							flags: { ...call.flags, wavFileUpdate: true },
							wavFile,
						},
					})
					this.logger.debug(
						{ wavFile, attempt, dir },
						"Found WAV file after async search",
					)
					return
				}
			}

			// Not found in any directory, retry if attempts remain
			if (attempt < maxRetries) {
				setTimeout(tryFind, retryDelayMs)
			} else {
				this.logger.debug(
					{
						proto: call.protocol,
						tg: call.talkgroup,
						src: call.source,
						attempts: attempt,
						dirsSearched: dirsToSearch,
					},
					"WAV file not found after max retries",
				)
			}
		}

		// Start first retry after initial delay (give dsd-fme time to write)
		setTimeout(tryFind, retryDelayMs)
	}

	/**
	 * Core WAV file search logic - searches directory for matching file.
	 */
	private searchForWavFile(
		call: DsdFmeCallState,
		callEndTime: Date,
		dir: string,
	): string | undefined {
		// Check if directory exists
		if (!fs.existsSync(dir)) {
			this.logger.debug({ dir }, "Recording directory does not exist")
			return undefined
		}

		const proto = call.protocol?.toUpperCase().replace(/\d+$/, "") ?? "UNK"
		const tg = call.talkgroup ?? 0
		const src = call.source ?? 0
		const cc = call.dmr?.cc ?? call.p25?.nac

		// Build regex pattern for dsd-fme filename format
		// Format: YYYYMMDD_HHMMSS_XXXXX_PROTO_CC_N_CALLTYPE_TGT_N_SRC_N.wav
		const ccPattern = cc !== undefined ? `_CC_${cc}` : "_CC_\\d+"
		const pattern = new RegExp(
			`^(\\d{8}_\\d{6})_\\d+_${proto}${ccPattern}_(?:GROUP|UNIT)_TGT_${tg}_SRC_${src}\\.wav$`,
			"i",
		)

		// Time window for matching (call start - 5s to call end + 5s)
		const windowStartMs = call.startTime.getTime() - 5000
		const windowEndMs = callEndTime.getTime() + 5000

		try {
			const files = fs.readdirSync(dir)
			const candidates: Array<{ file: string; timestamp: Date; diff: number }> =
				[]

			for (const file of files) {
				const match = pattern.exec(file)
				if (!match) continue

				// Parse timestamp from filename (YYYYMMDD_HHMMSS)
				const tsStr = match[1]
				if (!tsStr) continue

				const fileTimestamp = this.parseFilenameTimestamp(tsStr)
				if (!fileTimestamp) continue

				const fileMs = fileTimestamp.getTime()

				// Check if file timestamp falls within call window
				if (fileMs >= windowStartMs && fileMs <= windowEndMs) {
					// Calculate how close this file's timestamp is to call start
					const diff = Math.abs(fileMs - call.startTime.getTime())
					candidates.push({ file, timestamp: fileTimestamp, diff })
				}
			}

			if (candidates.length === 0) {
				return undefined
			}

			// Sort by timestamp difference (closest to call start first)
			candidates.sort((a, b) => a.diff - b.diff)
			const bestMatch = candidates[0]

			if (bestMatch) {
				const fullPath = path.join(dir, bestMatch.file)
				this.logger.debug(
					{
						file: bestMatch.file,
						callStart: call.startTime.toISOString(),
						fileTimestamp: bestMatch.timestamp.toISOString(),
						diffMs: bestMatch.diff,
						candidates: candidates.length,
					},
					"Found matching WAV file for call",
				)
				return fullPath
			}

			return undefined
		} catch (err) {
			this.logger.warn(
				{ dir, error: err instanceof Error ? err.message : String(err) },
				"Error searching for WAV file",
			)
			return undefined
		}
	}

	/**
	 * Parses a timestamp string from dsd-fme filename format.
	 * Format: YYYYMMDD_HHMMSS
	 */
	private parseFilenameTimestamp(tsStr: string): Date | null {
		// Expected format: YYYYMMDD_HHMMSS (e.g., 20260109_105327)
		const match = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})$/.exec(tsStr)
		if (!match) return null

		const [, year, month, day, hours, mins, secs] = match
		if (!year || !month || !day || !hours || !mins || !secs) return null

		return new Date(
			parseInt(year, 10),
			parseInt(month, 10) - 1, // Month is 0-indexed
			parseInt(day, 10),
			parseInt(hours, 10),
			parseInt(mins, 10),
			parseInt(secs, 10),
		)
	}

	/**
	 * Ends the current call and returns a call_end event.
	 * Generates expected WAV filename if per-call recording is enabled.
	 */
	private endCall(now: Date, timeout: boolean): DecoderOutput | null {
		if (!this.callState) return null

		// A timeout is detected late: the call really ended at its last line.
		const endTime = timeout ? this.callState.lastUpdate : now
		const duration = endTime.getTime() - this.callState.startTime.getTime()
		const callInfo = this.callState

		// Calculate error rate
		const totalErrors = callInfo.quality.crcErrs + callInfo.quality.fecErrs
		const errorRate = this.frameCount > 0 ? totalErrors / this.frameCount : 0
		callInfo.flags.badSignal = errorRate > BAD_SIGNAL_ERROR_RATE

		// Check for false positive suppression
		const minDuration = this.options.minCallDurationMs ?? MIN_CALL_DURATION_MS
		const hasWeakMetadata =
			(callInfo.talkgroup === 0 || callInfo.talkgroup === null) &&
			(callInfo.source === 0 || callInfo.source === null)

		if (duration < minDuration && hasWeakMetadata) {
			callInfo.flags.falsePositiveSuppressed = true
			this.logger.debug(
				{ protocol: callInfo.protocol, duration },
				"Short call with weak metadata suppressed as likely false positive",
			)
			this.callState = null
			this.frameCount = 0
			return null // Don't emit for likely false positives
		}

		// Try to find the WAV file immediately
		const wavFile = this.findWavFile(callInfo, endTime)

		// Also trigger async search with retries - dsd-fme may still be writing
		// This will emit an update event if the file is found later
		if (!wavFile) {
			this.findWavFileAsync(callInfo, endTime)
		}

		// Clear state
		this.callState = null
		this.frameCount = 0
		callInfo.flags.timeout = timeout

		this.logger.info(
			{
				protocol: callInfo.protocol,
				talkgroup: callInfo.talkgroup,
				source: callInfo.source,
				duration,
				timeout,
				quality: callInfo.quality,
				badSignal: callInfo.flags.badSignal,
				wavFile,
			},
			"Call ended",
		)

		return {
			timestamp: now,
			decoder: this.id,
			type: "call_end",
			data: {
				callId: callInfo.callId,
				startedAt: callInfo.startTime.toISOString(),
				endedAt: endTime.toISOString(),
				protocol: callInfo.protocol,
				talkgroup: callInfo.talkgroup,
				source: callInfo.source,
				slot: callInfo.slot,
				duration,
				dmr: callInfo.dmr,
				p25: callInfo.p25,
				nxdn: callInfo.nxdn,
				dstar: callInfo.dstar,
				ysf: callInfo.ysf,
				quality: callInfo.quality,
				flags: callInfo.flags,
				wavFile,
			},
		}
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
