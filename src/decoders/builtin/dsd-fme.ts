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
import { csdrNumber, deemphasisStage } from "../csdr-stages.js"
import {
	readExtraArgsOption,
	readNumericOption,
	type NumericOptionRule,
} from "../option-values.js"
import {
	DSD_FME_DURATION_MS_MAX,
	DSD_FME_FM_GAIN_MAX,
	DSD_FME_RECORDING_MAX_AGE_HOURS_MAX,
	DSD_FME_RECORDING_MAX_TOTAL_MB_MAX,
	DSD_FME_SAMPLE_RATE_MAX_HZ,
	DSD_FME_SAMPLE_RATE_MIN_HZ,
} from "../options/dsd-fme.js"
import {
	DMR_RECORDING_LINK_ENABLED,
	pruneCallRecordings,
} from "./call-recordings.js"
import { receiveFilterEffect } from "./dsd-fme-filter.js"
import {
	classifyDmrLine,
	DMR_SOURCE_MAX,
	DMR_TALKGROUP_MAX,
	DmrClearance,
	dmrIdsPlausible,
	newDmrRoute,
	type DmrDecision,
	type DmrLane,
} from "./dsd-fme-dmr-clearance.js"
import type {
	DecoderCaps,
	DecoderConfig,
	DecoderOutput,
	DemodulationConfig,
} from "../types.js"
import type { DecoderCounterName } from "@wavekit/api-types"
import type { Logger } from "../../utils/logger.js"
import type { DsdFmeLinkLine } from "./dsd-fme-link.js"
import type { DecoderChannelRequestResult } from "../../core/channelizer/types.js"

/**
 * Largest carrier frequency correction (Hz either way). The 12.5 kHz channel is
 * flat to +-6.25 kHz and 4800 symbols/s 4FSK (DMR, P25, YSF) occupies about
 * +-4.25 kHz, so a carrier up to 6.25 - 4.25 = 2 kHz off still lies inside the
 * passband; past that the channel filter cuts the signal anyway.
 */
export const DSD_FME_CARRIER_CORRECTION_MAX_HZ = 2000

// =============================================================================
// REGEX PATTERNS - Protocol-specific patterns for parsing dsd-fme output
// =============================================================================

/** Strip ANSI escape codes from dsd-fme colored output */
const ANSI_ESCAPE = /\x1b\[[0-9;]*m/g

/** Extract optional timestamp prefix: "17:04:58" or "2025-04-22 23:29:15" (reserved for future use) */
const _TS_PATTERN = /^(?:(?:\d{4}-\d{2}-\d{2}\s+)?\d{1,2}:\d{2}:\d{2})\s+/

/** Sync detection: "Sync: +DMR", "Sync: +P25p1", etc. */
// dsd_frame_sync.c prints signed P25/DMR/YSF/dPMR/DSTAR;
// nxdn_frame.c prints unsigned NXDN48/NXDN96.
const SYNC_PATTERN = /\bSync:\s*(?<pol>[+-])?(?<proto>(?!no\b)[A-Za-z0-9]+)\b/i

/** Error conditions - FEC, CRC, sync lost */
const ERROR_PATTERN = /\b(FEC ERR|CRC ERR|SYNC LOST|no sync)\b/i

/** A line whose link control failed its CRC: never identity, never encryption. */
const CRC_ERR = /\bCRC(?:16|32)?\s+ERR\b/i
const FEC_ERR_ALL = /\bFEC\s+ERR\b/gi

/** The frame counters dsd-fme output supports (countLine, emitLink). */
const DSD_FME_COUNTERS = [
	"detections",
	"framesOk",
	"crcBad",
	"fecBad",
] as const satisfies readonly DecoderCounterName[]

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
/**
 * P25 voice link control as p25_lcw.c prints it (" Group Voice Channel User
 * - Group 4321 Source 1234567", " Unit to Unit Voice Channel User - Target 7
 * Source 9"). Both callers, LDU1 and TDULC, print it only after the
 * RS(24,12,13) check passed (otherwise " LCW FEC ERR "), so it is checked.
 */
const P25_LCW_GROUP =
	/\bGroup Voice Channel User - Group (?<tg>\d+) Source (?<src>\d+)\b/
/** Unit to unit: the target is a unit ID, not a talkgroup. */
const P25_LCW_UNIT =
	/\bUnit to Unit Voice Channel User - Target (?<target>\d+) Source (?<src>\d+)\b/
/** NAC of a P25 sync line ("NAC/CC: 2A5;"); a failed NID prints "duid:EE". */
const P25_NAC_PRINT = /\bNAC(?:\/CC)?:\s*([0-9A-F]{3});/i
/** P25 call termination */
const P25_CALL_TERM = /\b(Call\s+Termination|TDULC)\b/i
/** The plain terminator data unit (DUID 3) on a P25 phase 1 sync line. */
const P25_TDU = /\bTDU\b/

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
/** YSF CRC status in same line (the -Z payload print "FICH: [..]") */
const YSF_CRC_OK = /\bFICH\b(?!.*(?:CRC|FEC)\s+ERR)/i
/**
 * A YSF frame whose FICH decoded: ysf.c prints the frame type and number
 * ("HC FN: 1/7", "CC FN: 2/7", "TC FN: 1/7") only when the FICH check
 * passed; a failed FICH prints "FN: 10/10 FICH (CRC ERR)" instead.
 */
const YSF_FICH_OK = /\b(?:HC|CC|TC|XX) FN: [1-8]\/[1-8]\b/
/** A YSF header frame whose FICH decoded: the start of an over. */
const YSF_HEADER_FRAME = /\bHC FN: [1-8]\/[1-8]\b/
/** A YSF terminator frame whose FICH decoded: the end of the over. */
const YSF_TERMINATOR = /\bTC FN: [1-8]\/[1-8]\b/

// --- NXDN Patterns ---
/** NXDN sync (reserved - protocol detection uses SYNC_PATTERN) */
const _NXDN_HEAD = /\bSync:\s*[+-]?NXDN(?<rate>48|96)\b/i
/** NXDN voice/data indicator */
const NXDN_VOICE_DATA = /\b(VOICE|DATA)\b/i
/**
 * NXDN SACCH as nxdn_deperm.c prints it: " RAN 05 PF 2/4" (superframe) or
 * "PF 1/1". The RAN printed is the one stored by the last SACCH whose CRC-6
 * passed (it is updated after the print); "PF X/n" marks this frame's SACCH
 * as failed, a digit as passed.
 */
const NXDN_SACCH_RAN = /\bRAN (?<ran>\d{2}) PF (?<pf>[1-4X])\/[14]\b/
/** A frame whose own SACCH passed its CRC (with or without a RAN print). */
const NXDN_SACCH_OK = /\bPF [1-4]\/[14]\b/
/**
 * NXDN VCALL / TX_REL as nxdn_element.c prints it: "Src=1234 - Dst/TG=5678",
 * only for a FACCH1 or SACCH superframe whose CRC passed.
 */
const NXDN_SRC_DST = /\bSrc=(?<src>\d+) - Dst\/TG=(?<tgt>\d+)\b/
/**
 * Two NXDN frames are consecutive within this window: 500 ms is 6 NXDN48
 * frames of 80 ms (12 NXDN96 frames of 40 ms), above line-delivery jitter.
 */
const NXDN_CONSECUTIVE_MS = 500
/**
 * nxdn_deperm.c nxdn_message_type prints the message name at the end of the
 * frame line; the IDs line that follows belongs to it. Only VCALL (0x01) is a
 * call on this channel: VCALL_ASSGN / DCALL_ASSGN grant another channel, and
 * TX_REL / DISC end a call (DISC may be dsd-fme's own Src=0 lock-out).
 */
const NXDN_VCALL_LINE = /\bVCALL\s*$/
/** A traffic channel frame (nxdn_frame.c lich_rf): RDCH, RTCH, RTCH_C, RTCH2; not RCCH. */
const NXDN_TRAFFIC_LINE = /\b(?:RDCH|RTCH|RTCH_C|RTCH2)\b/
/** A clean NXDN frame line naming a release or disconnect: the call ends. */
const NXDN_RELEASE_LINE = /\b(?:TX_REL|TX_REL_EX|DISC)\s*$/
/**
 * A call heard by RAN alone takes the VCALL IDs only this soon after it
 * started: three NXDN48 SACCH superframes (3 x 4 frames x 80 ms = 960 ms).
 * Tuned in mid-superframe, the next complete superframe ends up to 5 frames
 * (400 ms) after the call starts; one failed SACCH costs one superframe more
 * (720 ms); the third superframe leaves margin. NXDN96 frames are 40 ms.
 */
const NXDN_ADOPT_IDS_MS = 960

// --- D-Star Patterns ---
/** D-Star sync (reserved - protocol detection uses SYNC_PATTERN) */
const _DSTAR_HEAD = /\bSync:\s*\+DSTAR\b/i

/**
 * D-STAR header as dstar_header.c and dstar.c print it: " RPT 2: %s RPT 1:
 * %s DST: %s SRC: %s" with 8, 8, 8 and 12 (MY + suffix) characters. On a
 * "+DSTAR HEADER" line the first block is the radio header, printed without
 * an FCS check (dstar_header.c TODO); the slow-data copy that may follow is
 * printed only when its CRC matches (dstar.c processDSTAR_SD, otherwise
 * " SLOW DATA - HEADER FORMAT (CRC ERR)"). A "+DSTAR VOICE" line carries
 * only slow data, so its block is the checked one.
 */
const DSTAR_HEADER_BLOCK =
	/ RPT 2: (?<rpt2>.{8}) RPT 1: (?<rpt1>.{8}) DST: (?<ur>.{8}) SRC: (?<my>.{8})(?<suffix>.{4})/g
const DSTAR_HEADER_SYNC = /\bSync:\s*[+-]DSTAR HEADER\b/
/** A plausible D-STAR or YSF callsign field once trimmed. */
const CALLSIGN_FIELD = /^[A-Z0-9][A-Z0-9/-]{0,9}$/

/** The CRC-checked header block of a D-STAR line, if it has one. */
function checkedDstarHeader(
	line: string,
): { my: string; ur: string; rpt1: string; rpt2: string } | undefined {
	const blocks = [...line.matchAll(DSTAR_HEADER_BLOCK)]
	const checked = blocks[DSTAR_HEADER_SYNC.test(line) ? 1 : 0]?.groups
	if (checked === undefined || !SYNC_PATTERN.test(line)) return undefined
	const my = (checked["my"] ?? "").trim()
	if (!CALLSIGN_FIELD.test(my)) return undefined
	return {
		my,
		ur: (checked["ur"] ?? "").trim(),
		rpt1: (checked["rpt1"] ?? "").trim(),
		rpt2: (checked["rpt2"] ?? "").trim(),
	}
}

/**
 * The source callsign of a YSF line, from a DCH whose own CRC passed (ysf.c
 * prints "DCH (CRC ERR)" / "DCH2 (CRC ERR)" instead): CSD1 of a header or
 * terminator "DST: %s SRC: %s" (10 characters each), or V/D type 2 frame 1
 * "FN: 2/7 SRC: %s".
 */
const YSF_CSD1 = /\bDST: (?<dst>.{10}) SRC: (?<src>.{10})/
const YSF_VD2_SRC = /\bFN: \d\/\d SRC: (?<src>.{1,10})/
function ysfSourceCallsign(line: string): string | undefined {
	const src = (
		YSF_CSD1.exec(line)?.groups?.["src"] ??
		YSF_VD2_SRC.exec(line)?.groups?.["src"] ??
		""
	).trim()
	return CALLSIGN_FIELD.test(src) ? src : undefined
}

/** A dPMR called or calling ID print that is not "(CRC ERR)". */
const DPMR_ID_PRINT = /\b(?:TG|Src)=[0-9*]{7}\b/
/**
 * The ID values of a dPMR print, compared between consecutive prints. Only
 * the values: another process (sox) may write onto the same stderr line.
 */
const DPMR_IDS = /\bTG=(?<tg>[0-9*]{7}) Src=(?<src>[0-9*]{7})\b/
/**
 * A dPMR call needs two identical ID prints this close: one print per FS2
 * pair, every 160 ms (2 x 80 ms frames), plus 50 % for delivery jitter.
 */
const DPMR_CONSECUTIVE_MS = 240

// --- ProVoice Patterns ---
/** ProVoice sync (reserved - protocol detection uses SYNC_PATTERN) */
const _PROVOICE_HEAD = /\bSync:\s*[-+]ProVoice\b/i
/** Input level indicator */
const INLVL = /\binlvl:\s*(?<inlvl>\d+)%\b/i

// =============================================================================
// TYPES
// =============================================================================

/** Supported DSD-FME decoder modes (Requirement 6.5; nxdn48/dpmr: signal discovery spec § 6.4) */
export type DsdFmeMode =
	| "auto"
	| "dmr"
	| "p25"
	| "ysf"
	| "dstar"
	| "nxdn"
	| "nxdn48"
	| "dpmr"
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
	/**
	 * false: the call started before its link control said whether it is
	 * encrypted (call-first), so it is not clear yet; true once that is known
	 * (`encrypted` then says which). Absent: known from the start.
	 */
	encryptionKnown?: boolean
	active: boolean
	startedAt: string
	endedAt?: string
	/** An end the decoder's restart forced (the call tap's "restart"). */
	endReason?: "restart"
	/** WG2 (lane X fills these): DMR colour code. */
	colourCode?: number
	/** P25 NAC, upper-case hex. */
	nac?: string
	/** Encryption algorithm id (hex). */
	algorithmId?: string
	keyId?: string
	/** NXDN RAN. */
	ran?: number
	errors?: { crc: number; fec: number }
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
	| "dpmr"
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
	/** Unit to unit call: the target unit (the call has no talkgroup). */
	unitTarget?: number | undefined
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
	/** Ended because the decoder restarted (a crash restart): the tap's "restart". */
	restart?: true
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
	/**
	 * The start as wall time, fixed when the call was created: every
	 * reported startedAt, endedAt (start + the monotonic duration) and the
	 * recording filename match use it, so a wall step mid-call moves none.
	 */
	startWallMs: number
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
	/** Its call_start went out (callStartEvent). */
	announced?: boolean | undefined
	/** Started on its voice frames (startOnFrames), not on an identity. */
	onFrames?: boolean | undefined
	/**
	 * false: not known yet; true: known (clear, or encrypted with
	 * flags.encrypted). DMR calls always carry it; known with encrypted
	 * false only once the clearance machine settled a proof
	 * (dsd-fme-dmr-clearance.ts). Absent (other protocols): known from the
	 * start.
	 */
	encryptionKnown?: boolean | undefined
	/**
	 * Started on its voice frames without an identity: its frames ran long
	 * enough to be an over (UNNAMED_EVIDENCE_SYNCS, unnamedEvidenceSpanMs).
	 */
	evidenced?: boolean | undefined
	/**
	 * A DMR terminator ended it before its IDs, or before a call with IDs
	 * knew its encryption: its call_end waits for the trailer
	 * (DMR_TRAILER_HOLD_MS).
	 */
	heldEnd?: HeldEnd | undefined
	/**
	 * DMR: when the call's lane printed its first voice burst (VC1 to VC6,
	 * VC*) while the call ran, or the burst it started on. A link control
	 * re-keys only after it (dmrRekey).
	 */
	voiceAtMs?: number | undefined
	/**
	 * DMR: one checked link control after a voice burst named other IDs than
	 * the call's (rival): the call is no longer known clear, and a second
	 * agreeing copy is the next talker (handleDmrIds).
	 */
	rival?: { talkgroup: number; source: number; voiceSeq: number } | undefined
	/**
	 * DMR: the call started on a terminator's link control (TLC + LC) with
	 * no call of those IDs just ended on the lane: an over whose voice
	 * dsd-fme did not decode, known only from its terminator train
	 * (handleDmrTrainIds). The train's own terminators do not end it; it
	 * ends CALL_TIMEOUT_MS after its last burst, on the next talker, or at
	 * its last line when a voice or header burst of the lane follows (the
	 * next over, handleDmrSync).
	 */
	train?: boolean | undefined
}

/**
 * The call_end of an identity-less DMR call held after its terminator, for
 * the terminator's own link control (handleTermination, resolveHeldEnd).
 */
interface HeldEnd {
	/** The terminator line: where the call ends. */
	atMs: number
	/** The last line time that may still be its trailer: atMs + DMR_TRAILER_HOLD_MS. */
	untilMs: number
	/** The trailer's IDs line arrived (clean). */
	lc: boolean
	/** An error line printed in the terminator's burst: its link control is not checked. */
	errored: boolean
	/**
	 * The trailer's IDs: they attach at closeHeldEnd (through bindDmrCall)
	 * only if the burst closed clean (an error line after the IDs line leaves
	 * the call unnamed).
	 */
	ids?: { talkgroup: number; source: number } | undefined
}

/** The terminator's own link control, expected right after it (TERMINATOR_TRAILER_MS). */
interface CallTrailer {
	protocol: DsdFmeProtocol
	talkgroup: number | null
	source: number | null
	untilMs: number
}

/**
 * The run of voice frame syncs of one protocol on one lane, each at most
 * SYNC_CHAIN_MS of the protocol after the previous: the frames an over
 * printed before its call starts. `clean` counts the frames without an error.
 */
interface SyncChain {
	protocol: NonNullable<DsdFmeProtocol>
	startMs: number
	lastMs: number
	clean: number
	/**
	 * P25: the NAC the chain's syncs printed (a frame printing another starts
	 * a new chain). DMR: the colour code of its latest sync that printed one;
	 * another one does not break the chain (recorded overs print a garbled
	 * code on their first syncs: 13, 07, 05, 02, 00) but restarts `run`.
	 */
	tag?: string | undefined
	/**
	 * DMR: the clean syncs since the colour code last changed ("XX" changes
	 * nothing) and when the first of them arrived: a call starts on two of
	 * one code, and an unnamed one is evidenced by three of one code.
	 */
	run?: number | undefined
	runStartMs?: number | undefined
	/** DMR: the chain began at a header burst (dmrHeaderLine). */
	header?: boolean | undefined
	/** YSF: the first checked source callsign its frames printed before the call started. */
	lead?: string | undefined
	/**
	 * The ongoing call's last line with its own identity (markChain), the
	 * chain's first sync after it and the sync before that one: where the
	 * next over can have begun when the identity changes.
	 */
	markMs?: number | undefined
	afterMarkMs?: number | undefined
	beforeMarkMs?: number | undefined
}

/**
 * One call lane: DMR repeater slot 1 or 2, or 0 for every other line (one
 * channel). Each lane runs its own call, so two busy TDMA slots give two
 * concurrent calls.
 */
interface CallLane {
	callState: DsdFmeCallState | null
	pendingCall: PendingCall | null
	recentlyTerminated: CallTrailer | null
	chain: SyncChain | null
	lastVoiceSyncMs: number | undefined
	/** The lane's voice burst syncs seen so far (a rival's copy order). */
	voiceSeq: number
	laneSync: LaneSync | undefined
	candidate: VlcCandidate | undefined
}

const emptyLane = (): CallLane => ({
	callState: null,
	pendingCall: null,
	recentlyTerminated: null,
	chain: null,
	lastVoiceSyncMs: undefined,
	voiceSeq: 0,
	laneSync: undefined,
	candidate: undefined,
})

/**
 * The last DMR sync line routed to a lane (the "preceding sync" of the
 * lane's next link control): a voice LC header, a voice burst, a
 * terminator, or any other burst (idle, CSBK, PI, data, a failed slot type).
 */
interface LaneSync {
	kind: "vlc" | "voice" | "tlc" | "other"
	clean: boolean
	atMs: number
}

/**
 * The checked IDs of a voice LC header whose own sync printed an error: the
 * over's IDs if its voice follows within DMR_VLC_CANDIDATE_MS (startOnFrames).
 */
interface VlcCandidate {
	talkgroup: number
	source: number
	slot: number | undefined
	encrypted: boolean
	atMs: number
	/** A sync line of the lane followed it: a later error line is not its burst's. */
	sealed: boolean
}

/**
 * The adapter's clocks. Every elapsed-time decision (call timeout, pending
 * emission, evidence spans, candidate and trailer windows, re-key gaps)
 * runs on `mono`, which never steps; `wall` is read only for what is
 * reported (output timestamps, startedAt / endedAt, link times) and for the
 * recording filename search, whose names carry wall time. The
 * `HH:MM:SS` prefix dsd-fme prints on its lines is never used for timing.
 */
export interface DsdFmeClock {
	/** Monotonic ms (any origin). */
	mono(): number
	/** Wall-clock ms since the epoch. */
	wall(): number
}

const SYSTEM_CLOCK: DsdFmeClock = {
	mono: () => performance.now(),
	wall: () => Date.now(),
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
	/**
	 * Receive filter on the discriminator output, chosen per mode
	 * (dsd-fme-filter.ts); default true, false feeds dsd-fme unfiltered.
	 */
	receiveFilter: boolean
	/**
	 * Carrier frequency correction in the channelizer while a carrier is present
	 * (DSD_FME_CARRIER_CORRECTION_MAX_HZ); default true. Channel IQ only: the
	 * raw-IQ csdr chain has none.
	 */
	carrierCorrection: boolean
	/** Per-call recordings: prune oldest beyond this total size (default: 512 MB) */
	perCallRecordingMaxTotalMb: number
	/** Per-call recordings: delete files older than this (default: 168 h) */
	perCallRecordingMaxAgeHours: number
	/** Run the per-call recording pruner (default true; scanner probes pass false and retain via EvidenceStore) */
	perCallRecordingPrune: boolean
}

/** All supported DSD-FME modes */
export const DSD_FME_MODES: readonly DsdFmeMode[] = [
	"auto",
	"dmr",
	"p25",
	"ysf",
	"dstar",
	"nxdn",
	"nxdn48",
	"dpmr",
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

/**
 * Call-first: the longest step between two voice frame syncs of one over
 * that still chains them (SyncChain), per protocol: two of its sync periods
 * (one sync may be lost between them) plus 40 ms of line latency jitter.
 * DMR one sync per 360 ms voice superframe per slot: 2 × 360 + 40 = 760;
 * P25 phase 1 one HDU/LDU per 180 ms: 2 × 180 + 40 = 400; D-STAR one sync
 * per 420 ms superframe: 2 × 420 + 40 = 880; YSF 100 ms frames: 2 × 100 +
 * 40 = 240; NXDN48 and dPMR 80 ms frames: 2 × 80 + 40 = 200 (NXDN96's 40 ms
 * frames fit too).
 */
/**
 * A call's start is back-dated to its chain's first sync, but at most this
 * many of the protocol's SYNC_CHAIN_MS windows before the line that starts
 * it: DMR 4 × 760 = 3 040 ms, P25 4 × 400 = 1 600, D-STAR 4 × 880 = 3 520,
 * YSF 4 × 240 = 960, NXDN and dPMR 4 × 200 = 800. Call-first starts on the
 * second clean frame, so a chain longer than that is a weak signal's run of
 * errored frames: its first sync is too uncertain to be the over's start.
 */
export const BACKDATE_MAX_CHAIN_WINDOWS = 4

export const SYNC_CHAIN_MS: Readonly<
	Partial<Record<NonNullable<DsdFmeProtocol>, number>>
> = {
	dmr: 760,
	p25p1: 400,
	dstar: 880,
	ysf: 240,
	nxdn48: 200,
	nxdn96: 200,
	dpmr: 200,
}

/**
 * A voice LC header (or another DMR header burst, DMR_HEADER) at least this
 * long after the ongoing call's last voice sync is a re-key (a new over);
 * so is a P25 header (HDU).
 */
export const REKEY_GAP_MS = 200

/** DMR burst: one 60 ms TDMA frame per slot. */
export const DMR_BURST_MS = 60

/** DMR voice superframe: 6 bursts of 60 ms per slot. */
export const DMR_SUPERFRAME_MS = 6 * DMR_BURST_MS

/**
 * dsd-fme's lines reach the adapter in clumps about this far apart (stdio
 * buffering; measured on recorded runs, tests/mocks/fixtures/synthetic/
 * dv-latency-dmr-*.json: steps of 330 to 350 ms). A line's arrival is up to
 * one clump after its burst, so arrival times say nothing finer than this:
 * a direct over's syncs arrive 340 ms apart and, as 340 < 360, one step in
 * 18 is an empty clump (680 ms); a repeater's six VC1..VC6 bursts of a
 * superframe arrive within a few ms. No DMR rule measures a superframe grid
 * on arrival times: a re-key without a terminator is a header burst, a new
 * identity or the call timeout, never a sync's arrival off a grid.
 */
export const DSD_FME_LINE_CLUMP_MS = 340

/**
 * How early or late one voice sync's line may print against its frame
 * within a clump (the evidence span and the trailer hold allow for it).
 */
export const SYNC_PRINT_JITTER_MS = 45

/**
 * A DMR terminator of a call with no IDs yet holds the call_end this long
 * for the terminator's own link control: dsd-fme prints its SLOT line
 * right after the TLC sync line (in the same clump), and the burst's errors
 * before the next burst's sync, so one 60 ms burst plus the print jitter,
 * 60 + 45 = 105 ms, closes the burst. The call still ends at the terminator.
 */
export const DMR_TRAILER_HOLD_MS = DMR_BURST_MS + SYNC_PRINT_JITTER_MS

/**
 * A voice LC header whose sync printed an error keeps its checked IDs as
 * the over's candidate this long: one superframe of voice, 6 x 60 = 360 ms,
 * plus one line clump, 340 ms: 360 + 340 = 700 ms. A voice burst of the
 * lane inside it starts the call with them (startOnFrames); past it they
 * are dropped.
 */
export const DMR_VLC_CANDIDATE_MS = DMR_SUPERFRAME_MS + DSD_FME_LINE_CLUMP_MS

/**
 * The plausible DMR IDs (24-bit addresses, ETSI TS 102 361-2): a
 * talkgroup 1 to 2^24 - 1 = 16 777 215, a source 1 to 16 777 215 - 800 =
 * 16 776 415 (the top 800 addresses are reserved for gateways and
 * services). A sanity check only (dmrIdsPlausible in dsd-fme-dmr-clearance.ts).
 */
export { DMR_SOURCE_MAX, DMR_TALKGROUP_MAX }

/**
 * Lines that neither settle nor drop a pending clear link control
 * (the clearance machine has its own copy) or a held terminator's trailer: a CACH short LC
 * that failed or was empty (another channel's signalling, not the burst),
 * the repeater's activity print, and the payload prints of -Z. Each is
 * anchored: a line that merely contains one of them still drops it.
 */
const BURST_NEUTRAL_LINES: readonly RegExp[] = [
	// Not in the design's allowlist: a blank line prints no burst content
	// (dsd-fme pads its output with empty lines), so it neither settles nor
	// drops, like the listed prints. Everything else stays anchored below.
	/^\s*$/,
	/^\s*SLCO CRC ERR\s*$/,
	/^\s*SLCO NULL\b/,
	/^\s*Activity Update\b/,
	/^\s*DMR PDU Payload\b/,
	/^\s*SLCO Completed Block\b/,
	/^\s*SB: /,
	/^\s*AMBE /,
]

function burstNeutral(line: string): boolean {
	return BURST_NEUTRAL_LINES.some(pattern => pattern.test(line))
}

/** A DMR repeater (BS) sync line that brackets no slot: its slot is unknown. */
function dmrBracketlessBs(line: string): boolean {
	return !/\bMS\/DM\b/.test(line) && !DMR_CURRENT_SLOT.test(line)
}

/**
 * The voice superframe of each call-first protocol whose frames carry no
 * checked identity of their own: DMR 6 bursts of 60 ms = 360; P25 phase 1
 * an LDU1 and an LDU2 of 180 ms = 360; D-STAR 21 voice frames of 20 ms =
 * 420.
 */
export const DV_SUPERFRAME_MS: Readonly<
	Partial<Record<NonNullable<DsdFmeProtocol>, number>>
> = {
	dmr: DMR_SUPERFRAME_MS,
	p25p1: 2 * 180,
	dstar: 21 * 20,
}

/**
 * A call started on its voice frames with no identity is announced only
 * after a checked item (a link control naming it or saying its encryption,
 * a checked header) or once its chain holds this many clean syncs (DMR: of
 * one colour code) spanning unnamedEvidenceSpanMs: syncs of two whole
 * superframes. Two noise syncs in one SYNC_CHAIN_MS window (two DMR syncs
 * 700 ms apart, two D-STAR syncs 420 ms apart) are not an over.
 */
export const UNNAMED_EVIDENCE_SYNCS = 3

/**
 * The span those syncs must cover: two superframes less the print jitter
 * at both ends, 2 × superframe - 2 × 45: DMR and P25 720 - 90 = 630 ms,
 * D-STAR 840 - 90 = 750 ms. undefined: the protocol does not start calls
 * on frames alone. Clumped arrival keeps a real over above it: three DMR
 * superframes' syncs arrive in at least two clump steps (2 × 340 = 680).
 */
export function unnamedEvidenceSpanMs(
	protocol: NonNullable<DsdFmeProtocol>,
): number | undefined {
	const superframe = DV_SUPERFRAME_MS[protocol]
	return superframe === undefined
		? undefined
		: 2 * superframe - 2 * SYNC_PRINT_JITTER_MS
}

/**
 * A DMR sync line's burst type (dmr_dburst.c labels after the last "|"):
 * VLC, VC1 to VC6 (a repeater's per-burst labels; the first burst after
 * a sync hunt prints "VC1*"), direct mode's VC*, TLC.
 */
const DMR_BURST = /\|\s*(?<burst>VLC|VC[1-6*]|TLC)\*?(?=\s|$)/
/**
 * A DMR header burst that is not a clean voice LC header: a PI header
 * (privacy, sent after the voice LC header) or, in direct mode (MS/DM), a
 * data burst whose slot type failed ("CACH/Burst FEC ERR": no CACH in
 * direct mode, so it is the burst itself). In recorded runs every direct
 * over that keyed up with a header printed one of these (or a VLC) as its
 * first line; no voice superframe prints one. A repeater's failed CACH
 * names no slot reliably, so it is not one.
 */
const DMR_HEADER = /\|\s*(?:PI\b|CACH\/Burst FEC ERR)/
/** A P25 phase 1 voice over's frame (header or voice): HDU, LDU1, LDU2. */
const P25_VOICE_FRAME = /\b(?<duid>HDU|LDU1|LDU2)\b/
const DSTAR_VOICE_SYNC = /\bSync:\s*[+-]DSTAR (?:VOICE|HEADER)\b/
/** An error printed on the line (the frame did not decode clean). */
const LINE_ERR = /\b(?:CRC|FEC)(?:16|32)?\s+ERR\b/i

/** A line that printed an error of its burst (CRC, FEC, RAS, key): its link control is not checked. */
function burstError(line: string): boolean {
	return (
		LINE_ERR.test(line) ||
		/ -RAS /.test(line) ||
		/\bKey:.*(?:ERR|error)/i.test(line)
	)
}

/** A DMR sync line of a header burst: a voice LC header or DMR_HEADER (a failed data burst only in direct mode). */
function dmrHeaderLine(line: string, burst: string | undefined): boolean {
	if (burst === "VLC") return true
	if (burst !== undefined) return false
	const header = DMR_HEADER.exec(line)
	if (header === null) return false
	return header[0].includes("PI") || /\bMS\/DM\b/.test(line)
}

/** Algorithm ids that mean "no encryption" (P25 0x80, DMR/none 0x00). */
function isClearAlgorithm(alg: string): boolean {
	const value = parseInt(alg, 16)
	return value === 0x80 || value === 0
}

/** Upper-case hex, or undefined when the stored field is not hex. */
function upperHex(value: string | undefined): string | undefined {
	if (value === undefined) return undefined
	const hex = value.trim().toUpperCase()
	if (!/^[0-9A-F]+$/.test(hex)) return undefined
	return hex
}

/**
 * Copy known call-state metadata onto a voice-call event (WG2 req 10).
 * Absent fields are left off the object (exactOptionalPropertyTypes).
 * `algorithmId` is only set for an encrypted call or a non-clear algorithm.
 */
function applyVoiceMetadata(
	state: DsdFmeVoiceCallState,
	source: {
		dmr?: DmrMetadata | undefined
		p25?: P25Metadata | undefined
		nxdn?: NxdnMetadata | undefined
		quality?: CallQuality | undefined
		encrypted: boolean
	},
): void {
	if (source.dmr?.cc !== undefined) state.colourCode = source.dmr.cc
	const nac = upperHex(source.p25?.nac)
	if (nac !== undefined) state.nac = nac
	const alg = upperHex(source.p25?.alg)
	if (alg !== undefined && (source.encrypted || !isClearAlgorithm(alg))) {
		state.algorithmId = alg
	}
	const keyId = upperHex(source.p25?.keyId)
	if (keyId !== undefined) state.keyId = keyId
	if (source.nxdn?.ran !== undefined) state.ran = source.nxdn.ran
	if (source.quality !== undefined) {
		state.errors = {
			crc: source.quality.crcErrs,
			fec: source.quality.fecErrs,
		}
	}
}

/** Fields of the call_start / call_end data this decoder publishes. */
interface CallEventData {
	callId?: string
	startedAt?: string
	endedAt?: string
	encrypted?: boolean
	encryptionKnown?: boolean
	protocol?: DsdFmeProtocol
	talkgroup?: number | null
	source?: number | null
	slot?: number | undefined
	flags?: { encrypted?: boolean; wavFileUpdate?: boolean; restart?: true }
	dmr?: DmrMetadata
	p25?: P25Metadata
	nxdn?: NxdnMetadata
	quality?: CallQuality
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

/** Voice LC lines awaiting their closing DMR sync (see the push site). */
const MAX_PENDING_DMR_VOICE_LINKS = 8

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
	/** NAC of the last P25 phase 1 sync line whose NID decoded. */
	private lastP25Nac: string | undefined = undefined
	/**
	 * When the last NXDN frame line whose own SACCH passed was read, and the RAN
	 * a following clean frame attests (see nxdnSacchLine).
	 */
	private nxdnCleanAt: number | undefined = undefined
	private nxdnRan: number | undefined = undefined
	/** The RAN the previous clean NXDN frame line printed. */
	private nxdnPrintedRan: string | undefined = undefined
	/** The previous NXDN line ended with the VCALL message name. */
	private nxdnVcallNext = false
	/** VCALL unit IDs of the line being parsed (nxdnVcallIds). */
	private nxdnLineIds: Record<string, string> | undefined = undefined
	/** The last dPMR ID print and when it was read (handleDpmrLine). */
	private dpmrLastPrint: { print: string; at: number } | undefined = undefined
	private linkDmrCc = new Map<string, { cc: number; at: number }>()
	private linkDmrMs = false
	private pendingDmrLink: DsdFmeLinkLine | undefined
	private pendingDmrVoiceLinks: DsdFmeLinkLine[] = []
	/**
	 * Whether each DMR call is known clear: the only source of a DMR call's
	 * encryptionKnown (applyDmrTrust). Its line router and the line sequence
	 * number it orders by.
	 */
	private readonly dmrClearance = new DmrClearance(CALL_TIMEOUT_MS)
	private dmrRoute = newDmrRoute()
	private lineSeq = 0
	/** The clearance lane of the line being parsed. */
	private dmrLineLane: DmrLane = "x"
	/** The current lane's last DMR sync line (LaneSync). */
	private laneSync: LaneSync | undefined
	/** The current lane's voice LC header candidate (VlcCandidate). */
	private candidate: VlcCandidate | undefined
	/** The current lane's voice sync sequence number (CallLane.voiceSeq). */
	private voiceSeq = 0
	/**
	 * DMR link controls whose IDs were not taken (a terminator's train, an
	 * implausible ID, a -Z print of no voice call, another talker's single
	 * copy); a debug count, never an identity.
	 */
	private dmrIdRejected = 0
	/**
	 * Per lane, the IDs of its last named DMR call that ended and when the
	 * lane last printed them: a terminator train naming them within
	 * CALL_TIMEOUT_MS is that call's hang train, not a new call; other IDs
	 * inside it are the next talker only on a second agreeing copy (`rival`,
	 * which a rival copy on the call's own voice starts)
	 * (handleDmrTrainIds).
	 */
	private dmrTrainOf = new Map<
		number,
		{
			talkgroup: number
			source: number
			atMs: number
			rival: { talkgroup: number; source: number } | undefined
		}
	>()

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

	private recentlyTerminated: CallTrailer | null = null

	/** The current lane's voice frame sync chain and last DMR voice sync (ms). */
	private chain: SyncChain | null = null
	private lastVoiceSyncMs: number | undefined = undefined

	/**
	 * The lane whose call the fields above hold (useLane), and the other
	 * lanes' calls. Lines of a DMR repeater (BS mode) go to their slot's lane,
	 * every other line to lane 0.
	 */
	private laneKey = 0
	private lanes = new Map<number, CallLane>()
	/** The last DMR sync was BS mode, and the slot it bracketed. */
	private dmrBs = false
	private dmrBsSlot = 1

	/** The adapter's clocks (DsdFmeClock). */
	private readonly clock: DsdFmeClock
	/** mono() 0 on the epoch scale: the wall time at construction minus mono(). */
	private readonly monoEpochMs: number

	constructor(
		config: DecoderConfig,
		logger: Logger,
		clock: DsdFmeClock = SYSTEM_CLOCK,
	) {
		super(config, logger)
		this.clock = clock
		this.monoEpochMs = clock.wall() - clock.mono()
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
			// Key-only, deduped: never the value (WG7 HW.2). Defaults to auto.
			this.optionWarn("mode", "invalid")
		}

		// WG7 HW.2: every number is read by meaning (bounded, finite) before it
		// reaches argv, a timer, the retention policy or the csdr shell pipeline.
		const num = (
			key: string,
			rule: Omit<NumericOptionRule, "key">,
		): number | undefined =>
			readNumericOption(options[key], { key, ...rule }, this.optionWarn)
		// Positive keys: 0 and below (clamped to 0) fall back to the default, as
		// the former positive-only schema did.
		const positive = (key: string, max: number, fallback: number): number =>
			num(key, { integer: false, min: 0, max }) || fallback
		return {
			mode: DSD_FME_MODES.includes(mode) ? mode : "auto",
			output,
			wavDir: options["wavDir"] as string | undefined,
			udpHost: options["udpHost"] as string | undefined,
			udpPort: this.parseUdpPort(options["udpPort"]),
			extraArgs: this.parseExtraArgs(options["extraArgs"]),
			// An exact 0 stays "absent" (the default rate), as before.
			inputSampleRate:
				options["inputSampleRate"] === 0
					? undefined
					: num("inputSampleRate", {
							integer: false,
							min: DSD_FME_SAMPLE_RATE_MIN_HZ,
							max: DSD_FME_SAMPLE_RATE_MAX_HZ,
						}),
			fmGain: num("fmGain", {
				integer: false,
				min: 0,
				max: DSD_FME_FM_GAIN_MAX,
			}),
			enableIqAgc: options["enableIqAgc"] as boolean | undefined,
			enablePerCallRecording:
				(options["enablePerCallRecording"] as boolean) ?? false,
			perCallRecordingDir:
				(options["perCallRecordingDir"] as string) ?? "/app/decoded_calls",
			minCallDurationMs: num("minCallDurationMs", {
				integer: false,
				min: 0,
				max: DSD_FME_DURATION_MS_MAX,
				default: MIN_CALL_DURATION_MS,
			}),
			emitDebugEvents: (options["emitDebugEvents"] as boolean) ?? false,
			callStartDelayMs: num("callStartDelayMs", {
				integer: false,
				min: 0,
				max: DSD_FME_DURATION_MS_MAX,
				default: CALL_START_DELAY_MS,
			}),
			callTimeoutMs: positive(
				"callTimeoutMs",
				DSD_FME_DURATION_MS_MAX,
				CALL_TIMEOUT_MS,
			),
			voiceSlot: this.parseVoiceSlot(options["voiceSlot"]),
			receiveFilter: this.parseFlag("receiveFilter", options["receiveFilter"]),
			carrierCorrection: this.parseFlag(
				"carrierCorrection",
				options["carrierCorrection"],
			),
			perCallRecordingMaxTotalMb: positive(
				"perCallRecordingMaxTotalMb",
				DSD_FME_RECORDING_MAX_TOTAL_MB_MAX,
				PER_CALL_RECORDING_MAX_TOTAL_MB,
			),
			perCallRecordingMaxAgeHours: positive(
				"perCallRecordingMaxAgeHours",
				DSD_FME_RECORDING_MAX_AGE_HOURS_MAX,
				PER_CALL_RECORDING_MAX_AGE_HOURS,
			),
			perCallRecordingPrune:
				z.boolean().safeParse(options["perCallRecordingPrune"]).data ?? true,
		}
	}

	/**
	 * A UDP port is an integer 1..65535 or absent: clamping would aim the voice
	 * at an unrelated port, so an out-of-range value is dropped (WG7 HW.2).
	 */
	private parseUdpPort(value: unknown): number | undefined {
		let outOfRange = false
		const port = readNumericOption(
			value,
			{ key: "udpPort", integer: true, min: 1, max: 65535 },
			(key, issue) => {
				if (issue === "clamped") outOfRange = true
				this.optionWarn(key, "invalid")
			},
		)
		return outOfRange ? undefined : port
	}

	/** A default-on flag: non-boolean values keep it on (key-only warning, never the value). */
	private parseFlag(
		key: "receiveFilter" | "carrierCorrection",
		value: unknown,
	): boolean {
		if (value === undefined || value === null) return true
		if (typeof value === "boolean") return value
		this.optionWarn(key, "invalid")
		return true
	}

	private parseVoiceSlot(value: unknown): DsdFmeVoiceSlot | undefined {
		if (value === undefined) return undefined
		const parsed = VoiceSlotSchema.safeParse(value)
		if (parsed.success) return parsed.data
		// Key-only, deduped: never the value (WG7 HW.2); the dsd-fme default applies.
		this.optionWarn("voiceSlot", "invalid")
		return undefined
	}

	/**
	 * Drops extraArgs that set the mode or the audio output (-f*, -o and its
	 * value, -y): WaveKit owns both, and the voice stream depends on them.
	 */
	private parseExtraArgs(value: unknown): string[] | undefined {
		// Strings only, entry count and UTF-8 bytes bounded (WG7 HW fix).
		const capped = readExtraArgsOption(value, this.optionWarn)
		if (capped === undefined) return undefined
		const kept: string[] = []
		let dropped = 0
		for (let i = 0; i < capped.length; i++) {
			const arg = capped[i] as string
			if (RESERVED_EXTRA_ARG.test(arg)) {
				dropped++
				// "-o <device>": the device is the next argument.
				if (arg === "-o" && i + 1 < capped.length) {
					i++
					dropped++
				}
				continue
			}
			kept.push(arg)
		}
		if (dropped > 0) {
			// Count only: the dropped arguments are option text (WG7 HW.2).
			this.logger.warn(
				{ key: "extraArgs", dropped },
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
		// A start while the child runs is ignored (super.start): nothing ends.
		if (this.process) {
			await super.start()
			return
		}
		// A crash restart calls start() again without stop(): the old timer is
		// cleared (never orphaned) and every call still open ends now, through
		// call_end, flagged restart.
		if (this.callTimeoutTimer) {
			clearInterval(this.callTimeoutTimer)
			this.callTimeoutTimer = null
		}
		this.endOpenCallsForRestart(this.monoDate())

		await super.start()

		// Start periodic call timeout check timer
		this.callTimeoutTimer = setInterval(() => {
			this.checkCallTimeoutAsync()
		}, CALL_TIMEOUT_CHECK_INTERVAL_MS)

		this.logger.debug("Call timeout timer started")
		this.schedulePrune(0)
	}

	/**
	 * Ends every lane's open call (pending, running or holding its call_end
	 * for the trailer) with the restart flag, and clears what the old child's
	 * lines left per lane (proofs, candidates, chains, the last sync).
	 */
	private endOpenCallsForRestart(now: Date): void {
		this.dmrClearance.restart()
		this.forEachLane(() => {
			const call = this.callState ?? this.pendingCall?.state ?? null
			if (call !== null) {
				call.flags.restart = true
				// No closing clean sync: a held trailer proves nothing.
				if (call.heldEnd !== undefined) call.heldEnd.errored = true
				let ended: DecoderOutput | null
				if (call.heldEnd !== undefined) ended = this.closeHeldEnd(now)
				else {
					if (this.pendingCall) {
						this.callState = this.pendingCall.state
						this.pendingCall = null
					}
					ended = this.endCall(now, true)
				}
				if (ended) this.emitOutput(ended)
			}
			this.callState = null
			this.pendingCall = null
			this.recentlyTerminated = null
			this.chain = null
			this.lastVoiceSyncMs = undefined
			this.laneSync = undefined
			this.candidate = undefined
		})
		this.dmrTrainOf.clear()
		this.dmrRoute = newDmrRoute()
		this.flushPendingDmrLink(false)
		// The old child's DMR mode and slot state, as stop() clears it.
		this.linkDmrCc.clear()
		this.linkDmrMs = false
		this.dmrBs = false
		this.dmrBsSlot = 1
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

		// End every lane's active or pending call before stopping
		this.dmrClearance.restart()
		const now = this.monoDate()
		this.forEachLane(() => {
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
		})

		this.flushPendingDmrLink(false)
		this.dmrRoute = newDmrRoute()
		await super.stop()
		this.linkDmrCc.clear()
		this.linkDmrMs = false
	}

	/**
	 * Publishes an output and, for call_start / call_end, the matching
	 * "voice-call" state in the same tick (the digital voice stream's call
	 * metadata is derived from exactly these events).
	 */
	protected override emitOutput(raw: DecoderOutput): void {
		const output = this.outputAtWall(raw)
		if (output.type !== "call_start" && output.type !== "call_end") {
			this.publish(output)
			return
		}
		const data = output.data as CallEventData
		const endingId =
			output.type === "call_end" && data.protocol === "dmr"
				? data.callId
				: undefined
		try {
			this.publish(output)
			if (data.callId !== undefined && !data.flags?.wavFileUpdate)
				this.publishCallSnapshot(output, data, data.callId)
		} finally {
			if (endingId !== undefined) this.dmrClearance.ended(endingId)
		}
	}

	private publishCallSnapshot(
		output: DecoderOutput,
		data: CallEventData,
		callId: string,
	): void {
		const active = output.type === "call_start"
		const encrypted = active
			? data.encrypted === true
			: data.flags?.encrypted === true
		const live = this.liveCall(callId)
		const state: DsdFmeVoiceCallState = {
			callId,
			protocol: data.protocol ?? null,
			talkgroup: data.talkgroup ?? null,
			source: data.source ?? null,
			slot: data.slot ?? null,
			encrypted,
			...(data.encryptionKnown !== undefined
				? { encryptionKnown: data.encryptionKnown }
				: {}),
			active,
			startedAt: data.startedAt ?? output.timestamp.toISOString(),
			...(data.endedAt !== undefined ? { endedAt: data.endedAt } : {}),
			...(!active && data.flags?.restart === true
				? { endReason: "restart" as const }
				: {}),
		}
		applyVoiceMetadata(state, {
			dmr: data.dmr ?? live?.dmr,
			p25: data.p25 ?? live?.p25,
			nxdn: data.nxdn ?? live?.nxdn,
			quality: data.quality ?? live?.quality,
			encrypted,
		})
		this.publish(state)
		if (!active) this.schedulePrune(RECORDING_PRUNE_DELAY_MS)
	}

	/** The outward call-state boundary, including both halves of a start/end
	 * and recording updates. Read trust afresh even between synchronous listeners. */
	private publish(publication: DecoderOutput | DsdFmeVoiceCallState): void {
		const voice = "active" in publication
		const data = voice
			? publication
			: publication.type === "call_start" || publication.type === "call_end"
				? (publication.data as CallEventData)
				: undefined
		if (data?.protocol === "dmr") {
			const trust =
				data.callId === undefined
					? "unknown"
					: this.dmrClearance.trust(data.callId)
			data.encrypted = trust === "encrypted"
			data.encryptionKnown = data.encrypted || trust === "clear"
			if ("flags" in data && data.flags)
				data.flags = { ...data.flags, encrypted: data.encrypted }
		}
		if (voice) this.emit("voice-call", publication)
		else super.emitOutput(publication)
	}

	/**
	 * Flags a call encrypted. An already announced call publishes the change
	 * on "voice-call" so its audio is muted from now on. Encrypted is known:
	 * encryptionKnown true with encrypted true (a DMR call stays encrypted in
	 * the clearance machine; only clear() gives known with encrypted false).
	 */
	private markEncrypted(call: DsdFmeCallState): void {
		if (call.protocol === "dmr") {
			this.dmrClearance.encrypted(call.callId)
			if (call.flags.encrypted) return
			call.flags.encrypted = true
			call.encryptionKnown = true
		} else {
			if (call.flags.encrypted) return
			call.flags.encrypted = true
			if (call.encryptionKnown === false) call.encryptionKnown = true
		}
		this.logger.info(
			{
				callId: call.callId,
				protocol: call.protocol,
				talkgroup: call.talkgroup,
			},
			"Encrypted call: voice stays muted",
		)
		this.publishCallUpdate(call)
	}

	/**
	 * A P25 call that started before its encryption was known (call-first)
	 * learned it is clear: an announced one publishes the change (with the
	 * identities that came with it) on "voice-call", so its voice may play
	 * from now on. DMR calls learn it only from applyDmrTrust.
	 */
	private markKnown(call: DsdFmeCallState | null): void {
		if (call?.encryptionKnown !== false || call.protocol === "dmr") return
		call.encryptionKnown = true
		this.publishCallUpdate(call)
	}

	/**
	 * Applies the clearance machine's decisions to the live DMR calls they
	 * name (any lane): encrypted mutes for good; clear sets encryptionKnown
	 * (the only place a DMR call becomes known clear); unknown revokes a
	 * known clear call on the same callId. Each change is published.
	 */
	private applyDmrTrust(decisions: readonly DmrDecision[]): void {
		for (const decision of decisions) {
			const call = this.dmrCallById(decision.callId)
			if (call === null) continue
			if (decision.trust === "encrypted") this.markEncrypted(call)
			else if (decision.trust === "clear") {
				if (call.flags.encrypted || call.encryptionKnown === true) continue
				call.encryptionKnown = true
				this.publishCallUpdate(call)
			} else if (call.encryptionKnown === true && !call.flags.encrypted) {
				call.encryptionKnown = false
				this.logger.info(
					{ callId: call.callId, protocol: call.protocol },
					"DMR call no longer known clear: voice held until clear again",
				)
				this.publishCallUpdate(call)
			}
		}
	}

	/** The live (running or pending) DMR call `callId` of any lane. */
	private dmrCallById(callId: string): DsdFmeCallState | null {
		const candidates = [
			this.callState,
			this.pendingCall?.state ?? null,
			...[...this.lanes.values()].flatMap(lane => [
				lane.callState,
				lane.pendingCall?.state ?? null,
			]),
		]
		for (const call of candidates)
			if (call?.callId === callId && call.protocol === "dmr") return call
		return null
	}

	/**
	 * Bind a call at the point where the lifecycle opens it or supplies its
	 * first IDs. The one place a call's IDs are set after it opens (`ids`), so
	 * a DMR call named into a tainted key of its lane's context is encrypted
	 * before anything publishes it; a naming alone never makes a call clear.
	 * `lane`: the clearance lane holding the call (default: this line's).
	 */
	private bindDmrCall(
		call: DsdFmeCallState,
		nowMs: number,
		ids?: { talkgroup: number | null; source: number | null },
		lane: DmrLane = this.dmrLineLane,
	): void {
		if (ids !== undefined) {
			call.talkgroup = ids.talkgroup
			call.source = ids.source
		}
		if (call.protocol !== "dmr") return
		const key =
			call.talkgroup !== null && call.source !== null
				? `${call.talkgroup}/${call.source}`
				: null
		this.applyDmrTrust(
			this.dmrClearance.call(
				lane,
				{ callId: call.callId, key },
				this.lineSeq,
				nowMs,
			),
		)
	}

	/**
	 * Whether a call may be announced: one with an identity or that started on
	 * an identity, or a call-first call a checked link control spoke for
	 * (encryption learned) or whose frames ran long enough (evidenced).
	 */
	private hasEvidence(call: DsdFmeCallState): boolean {
		return (
			call.onFrames !== true ||
			!this.weakMetadata(call) ||
			call.flags.encrypted ||
			call.encryptionKnown === true ||
			call.evidenced === true
		)
	}

	/**
	 * Marks `call` evidenced once the lane's running chain of its protocol
	 * holds UNNAMED_EVIDENCE_SYNCS clean syncs spanning unnamedEvidenceSpanMs.
	 */
	private noteEvidence(call: DsdFmeCallState | null, nowMs: number): void {
		if (call === null || call.onFrames !== true || call.evidenced === true)
			return
		if (call.protocol === null) return
		const span = unnamedEvidenceSpanMs(call.protocol)
		const chain = this.liveChain(call.protocol, nowMs)
		if (span === undefined || chain === null) return
		// DMR: syncs of one colour code (SyncChain.run).
		const dmr = call.protocol === "dmr"
		const clean = dmr ? (chain.run ?? 0) : chain.clean
		const firstMs = dmr ? (chain.runStartMs ?? chain.startMs) : chain.startMs
		if (clean >= UNNAMED_EVIDENCE_SYNCS && chain.lastMs - firstMs >= span)
			call.evidenced = true
	}

	/**
	 * While the lane's call holds its call_end (HeldEnd): a sync line closes
	 * the terminator's burst (the call ends first, then the line is parsed);
	 * an error line marks its link control unchecked; the first IDs line of
	 * the call's slot is the trailer: its IDs attach (when clean) and the line
	 * is consumed (true), so it starts nothing.
	 */
	private resolveHeldEnd(line: string, now: Date): boolean {
		const call = this.callState ?? this.pendingCall?.state ?? null
		const held = call?.heldEnd
		if (call === null || held === undefined) return false
		if (SYNC_PATTERN.test(line)) {
			// A sync that printed an error or lost sync does not close the
			// trailer's burst clean.
			if (burstError(line) || /Frame Sync Err\b|SYNC LOST|no sync/i.test(line))
				held.errored = true
			// The terminator printed again (its lane's) before its trailer does
			// not close its own burst: the call_end stays held for the trailer
			// (handleTermination). After the trailer it is the next burst of
			// the repeater's train: the trailer's burst closed, and that
			// burst's own lines are not the trailer's.
			if (DMR_BURST.exec(line)?.groups?.["burst"] === "TLC" && !held.lc)
				return false
			const ended = this.closeHeldEnd(now)
			if (ended) this.emitOutput(ended)
			return false
		}
		// A CACH short LC or a -Z payload print is not the terminator's burst.
		if (burstNeutral(line)) return false
		const ids =
			DMR_VOICE_EVENT.exec(line)?.groups ?? DMR_TGT_SRC.exec(line)?.groups
		const errored = burstError(line)
		if (errored) held.errored = true
		// A non-clear algorithm print: the burst did not close clean (the
		// clearance machine marks the call encrypted).
		const heldAlg =
			ids === undefined ? ALG_ID.exec(line)?.groups?.["alg"] : undefined
		if (heldAlg !== undefined && !isClearAlgorithm(heldAlg)) held.errored = true
		// Any other line of the lane that is not the trailer (a CSBK print,
		// a second LC, another talker's) means the burst did not close clean.
		if (ids === undefined || held.lc) {
			held.errored = true
			return false
		}
		const slotText =
			DMR_SLOT_INLINE.exec(line)?.groups?.["slot"] ??
			DMR_SLOT_WORD.exec(line)?.groups?.["slot"]
		// MS/DM (direct) is one channel: its printed SLOT number names nothing.
		if (
			!this.linkDmrMs &&
			slotText !== undefined &&
			call.slot !== undefined &&
			Number(slotText) !== call.slot
		)
			return false
		if (errored) return true
		const tg = parseInt(ids["tgt"] ?? "0", 10)
		const src = parseInt(ids["src"] ?? "0", 10)
		const named = call.talkgroup !== null || call.source !== null
		// Only the call's own IDs (a call with IDs) or plausible ones (a call
		// without) are its trailer; anything else is not taken (handleDmrIds).
		if (
			!dmrIdsPlausible(line, tg, src) ||
			(named && (call.talkgroup !== tg || call.source !== src))
		) {
			held.errored = true
			return false
		}
		held.lc = true
		if (!named) held.ids = { talkgroup: tg, source: src }
		const svc = DMR_TLC_FIELDS.exec(line)?.groups?.["svc"]
		const alg = ALG_ID.exec(line)?.groups?.["alg"]
		if (
			DMR_ENCRYPTED.test(line) ||
			(svc !== undefined && (parseInt(svc, 16) & DMR_SVC_PRIVACY) !== 0) ||
			(alg !== undefined && !isClearAlgorithm(alg))
		)
			this.markEncrypted(call)
		return true
	}

	/**
	 * Ends the lane's call whose call_end was held (HeldEnd) at its
	 * terminator. A clean trailer names an unnamed call (metadata only); a
	 * named call's trailer is its terminator proof, settled by the clearance machine
	 * on the closing sync before this runs.
	 */
	private closeHeldEnd(now: Date): DecoderOutput | null {
		const call = this.callState ?? this.pendingCall?.state ?? null
		const held = call?.heldEnd
		if (call === null || held === undefined) return null
		call.heldEnd = undefined
		// Only a burst that closed clean names the call, through the binding
		// (its lane's taint check runs before the call_end publishes).
		if (held.lc && !held.errored && held.ids !== undefined)
			this.bindDmrCall(
				call,
				now.getTime(),
				held.ids,
				this.dmrClearance.laneOf(call.callId) ?? this.dmrLineLane,
			)
		const endAt = new Date(held.atMs)
		call.lastUpdate = endAt
		if (!this.callState && this.pendingCall) {
			this.callState = this.pendingCall.state
			this.pendingCall = null
		}
		const ended = this.endCall(now, false, endAt)
		// The terminator's link control (printed again) is not a new call.
		this.recentlyTerminated = {
			protocol: "dmr",
			talkgroup: call.talkgroup,
			source: call.source,
			untilMs: held.atMs + TERMINATOR_TRAILER_MS,
		}
		return ended
	}

	/** The running announced call's state on "voice-call" (encryption or identity learned). */
	private publishCallUpdate(call: DsdFmeCallState): void {
		if (call.announced !== true || this.liveCall(call.callId) !== call) return
		const encrypted = call.flags.encrypted
		const state: DsdFmeVoiceCallState = {
			callId: call.callId,
			protocol: call.protocol,
			talkgroup: call.talkgroup,
			source: call.source,
			slot: call.slot ?? null,
			encrypted,
			...this.encryptionKnownField(call),
			active: true,
			startedAt: this.startedAtIso(call),
		}
		applyVoiceMetadata(state, {
			dmr: call.dmr,
			p25: call.p25,
			nxdn: call.nxdn,
			quality: call.quality,
			encrypted,
		})
		this.publish(state)
	}

	/** The announced call `callId` of any lane. */
	private liveCall(callId: string): DsdFmeCallState | null {
		if (this.callState?.callId === callId) return this.callState
		for (const lane of this.lanes.values())
			if (lane.callState?.callId === callId) return lane.callState
		return null
	}

	/** Makes `key` the current lane: its call is in callState / pendingCall. */
	private useLane(key: number): void {
		if (key === this.laneKey) return
		this.lanes.set(this.laneKey, {
			callState: this.callState,
			pendingCall: this.pendingCall,
			recentlyTerminated: this.recentlyTerminated,
			chain: this.chain,
			lastVoiceSyncMs: this.lastVoiceSyncMs,
			voiceSeq: this.voiceSeq,
			laneSync: this.laneSync,
			candidate: this.candidate,
		})
		const next = this.lanes.get(key) ?? emptyLane()
		this.lanes.delete(key)
		this.callState = next.callState
		this.pendingCall = next.pendingCall
		this.recentlyTerminated = next.recentlyTerminated
		this.chain = next.chain
		this.lastVoiceSyncMs = next.lastVoiceSyncMs
		this.voiceSeq = next.voiceSeq
		this.laneSync = next.laneSync
		this.candidate = next.candidate
		this.laneKey = key
	}

	/** Runs `fn` on every lane in turn, then makes the current lane current again. */
	private forEachLane(fn: () => void): void {
		const back = this.laneKey
		for (const key of [this.laneKey, ...this.lanes.keys()]) {
			this.useLane(key)
			fn()
		}
		this.useLane(back)
	}

	/**
	 * The lane of a line: a DMR repeater (BS mode) line's slot, which is a
	 * sync line's bracketed slot or, for any other line, the latest
	 * bracketed sync's (a printed SLOT is never routed on); 0 for every other
	 * line (direct mode is one channel: its prints say SLOT 1).
	 */
	private lineLane(line: string): number {
		const sync = SYNC_PATTERN.exec(line)
		if (sync) {
			if (sync.groups?.["proto"]?.toUpperCase() !== "DMR") return 0
			const bracket = DMR_CURRENT_SLOT.exec(line)?.groups?.["slot"]
			this.dmrBs = bracket !== undefined
			if (bracket === undefined) return 0
			this.dmrBsSlot = Number(bracket)
			return this.dmrBsSlot
		}
		// A repeater line belongs to the lane of the latest bracketed sync
		// (the clearance machine uses the same rule): one printing another
		// slot is rejected there (handleDmrIds), never routed to that slot.
		if (this.currentProtocol !== "dmr" || !this.dmrBs) return 0
		return this.dmrBsSlot
	}

	/** Runs per-call recording retention after `delayMs` (debounced). */
	private schedulePrune(delayMs: number): void {
		if (!this.options.perCallRecordingPrune) return
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
			// WG9 R2: `dir` is the configured root (a symlinked one is resolved once and pinned).
			const result = await pruneCallRecordings(
				[dir, path.join(dir, "WAV")],
				{
					maxTotalMb: this.options.perCallRecordingMaxTotalMb,
					maxAgeHours: this.options.perCallRecordingMaxAgeHours,
				},
				this.clock.wall(),
				dir,
			)
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
			// Error code only: messages and dir carry the configured path (WG7 HW.2).
			this.logger.warn(
				{ code: (err as NodeJS.ErrnoException).code },
				"Per-call recording retention failed",
			)
		} finally {
			this.pruning = false
		}
	}

	/**
	 * Checks for call timeout asynchronously (called by timer).
	 * Emits call_end event if a stale call is detected.
	 */
	private checkCallTimeoutAsync(): void {
		const now = this.monoDate()
		const nowMs = now.getTime()
		this.expireDmrEvidence(nowMs)
		const pending = this.pendingDmrLink ?? this.pendingDmrVoiceLinks[0]
		if (pending && nowMs - pending.at > CALL_TIMEOUT_MS)
			this.flushPendingDmrLink(false)

		this.forEachLane(() => {
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
		})
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
		// A call started on its voice frames alone is announced only once they
		// span the false-positive minimum (endCall drops it otherwise).
		// A call-first call with no identity also waits for a checked item or
		// a run of syncs (hasEvidence); a held call_end waits for its trailer.
		const pending = this.pendingCall.state
		if (pending.heldEnd !== undefined || !this.hasEvidence(pending)) return null
		if (
			pending.onFrames === true &&
			this.weakMetadata(pending) &&
			pending.lastUpdate.getTime() - pending.startTime.getTime() <
				(this.options.minCallDurationMs ?? MIN_CALL_DURATION_MS)
		)
			return null

		// Promote pending call to active call
		this.callState = this.pendingCall.state
		this.pendingCall = null

		return this.callStartEvent(this.callState, now)
	}

	/**
	 * The call_start of `call`, stamped `timestamp` (the timer's now, or the
	 * call's own start when it is announced late, at its end); marks it
	 * announced.
	 */
	private callStartEvent(
		call: DsdFmeCallState,
		timestamp: Date,
	): DecoderOutput {
		call.announced = true
		this.logger.info(
			{
				protocol: call.protocol,
				talkgroup: call.talkgroup,
				source: call.source,
				slot: call.slot,
				dmrCc: call.dmr?.cc,
			},
			"Call started (after metadata accumulation)",
		)
		return {
			timestamp,
			decoder: this.id,
			type: "call_start",
			data: {
				callId: call.callId,
				startedAt: this.startedAtIso(call),
				encrypted: call.flags.encrypted,
				...this.encryptionKnownField(call),
				protocol: call.protocol,
				talkgroup: call.talkgroup,
				source: call.source,
				slot: call.slot,
				dmr: call.dmr,
				p25: call.p25,
				nxdn: call.nxdn,
				dstar: call.dstar,
				ysf: call.ysf,
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
	 * Migrated to the opt-in core channelizer (addendum §7 step 4): channel
	 * IQ arrives at exactly 48 kHz and starts at fmdemod; only the sox WAV
	 * wrapper remains. No DC removal or AGC in the channel path (delta §8 risk 5).
	 */
	protected override channelizerSupported(): boolean {
		return true
	}

	/** The audio family's channel, with the carrier frequency correction unless it is off. */
	override getChannelRequest(input: {
		sampleRateHz: number
		centerHz?: number
	}): DecoderChannelRequestResult | undefined {
		const request = super.getChannelRequest(input)
		if (
			request === undefined ||
			"invalid" in request ||
			!this.options.carrierCorrection
		)
			return request
		return {
			...request,
			afcMaxHz: Math.min(
				DSD_FME_CARRIER_CORRECTION_MAX_HZ,
				request.bandwidthHz / 2,
			),
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
		return {
			format: "wav-s16le",
			rateHz: this.boundedDemodConfig().sampleRate,
		}
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
		const config = this.boundedDemodConfig()

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
			`csdr gain ${csdrNumber(config.fmGain ?? 5.0)}`, // Bounded number only; limiter follows
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

		// DEBUG: Record raw audio at demod rate before sox processing (so also
		// before the receive filter, which runs in sox)
		if (debugFile && this.debugRecording) {
			pipelineStr += ` | ${shellCommand("tee", [debugFile])}`
			this.logger.warn(
				{ rate: actualDemodRate },
				"DEBUG: Recording raw audio BEFORE sox",
			)
		}

		// Build sox command for WAV wrapper
		// CRITICAL: Use actualDemodRate (not configured rate) to match csdr output
		// The receive filter runs in this sox, before its rate conversion, so its
		// taps are designed at the sox input rate (dsd-fme-filter.ts).
		const receiveFilter = this.options.receiveFilter
			? receiveFilterEffect(this.options.mode, actualDemodRate)
			: undefined
		const soxCommand = [
			"sox",
			"-t raw",
			`-r ${csdrNumber(actualDemodRate)}`, // Input rate from csdr
			"-e signed -b 16 -c 1",
			"-",
			"-t wav",
			`-r ${csdrNumber(outputRate)}`, // Output rate for dsd-fme
			"-",
			...(receiveFilter === undefined ? [] : [receiveFilter]),
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
				// Stage count, not the string: it carries option text (WG7 HW.2).
				pipelineStages: pipeline.split(" | ").length,
			},
			"Built dsd-fme pipeline with WAV wrapper",
		)

		return pipeline
	}

	/**
	 * Generates a timestamped filename for debug recordings.
	 */
	private getDebugFilename(stage: string, ext: string): string {
		const now = new Date(this.clock.wall())
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

		// Per-call WAV files: -7 <dir> must precede -P (-w is one static file). A mode that can
		// only decode DMR asks for none while DMR recordings are off (they would never be listed,
		// served or linked). Retention still runs on the directory (files written before).
		const recordingDir = this.recordingDir()
		if (
			recordingDir !== null &&
			(this.options.mode !== "dmr" || DMR_RECORDING_LINK_ENABLED)
		) {
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
			case "nxdn48":
				// NXDN48 (6.25 kHz)
				args.push("-fi")
				break
			case "dpmr":
				args.push("-fm")
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
					{
						hasUdpHost: Boolean(this.options.udpHost),
						hasUdpPort: this.options.udpPort !== undefined,
					},
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
	 * 1. One sync is a CANDIDATE context, not an event: it tracks the protocol
	 *    and joins the lane's chain of voice frame syncs (trackChain).
	 * 2. Call-first: a call starts on an identity (TGT+SRC for DMR/P25/NXDN,
	 *    callsigns for D-Star/YSF) or on the over's second clean voice frame
	 *    (startOnFrames), back-dated to the chain's first sync; its IDs attach
	 *    later. One with no identity is announced only after a checked item
	 *    or UNNAMED_EVIDENCE_SYNCS syncs over two superframes (hasEvidence).
	 * 3. Calls end via explicit terminator (a DMR one of an unnamed call
	 *    waits DMR_TRAILER_HOLD_MS for its own link control), a re-key
	 *    (dmrRekey, a P25 header), a protocol switch, or the CALL_TIMEOUT_MS
	 *    (4 s) timeout, at their last line.
	 * 4. Short calls (< 250 ms) with weak metadata, and unnamed calls without
	 *    evidence, are suppressed as likely false positives.
	 * 5. Error events (FEC/CRC) are tracked for quality but not emitted unless debug mode is on
	 */
	protected override parseOutput(line: string): DecoderOutput | null {
		const now = this.monoDate()
		const nowMs = now.getTime()

		// STEP 1: Strip ANSI escape codes from colored output
		const cleanLine = line.replace(ANSI_ESCAPE, "")

		this.expireDmrEvidence(nowMs)
		const seq = ++this.lineSeq
		// The line's call is its lane's (a DMR repeater slot, else lane 0);
		// the clearance machine attributes the line to the same burst.
		const laneKey = this.lineLane(cleanLine)
		const event = classifyDmrLine(
			cleanLine,
			this.dmrRoute,
			laneKey === 1 ? "1" : laneKey === 2 ? "2" : undefined,
		)
		this.dmrLineLane = event.type === "foreign" ? "x" : event.lane
		this.applyDmrTrust(this.dmrClearance.line(event, seq, nowMs))
		// STEP 2: Check for stale calls (timeout-based call end) on every lane.
		// Publish the end now and keep parsing: this line may start the next call.
		this.forEachLane(() => {
			const timeoutEvent = this.checkCallTimeout(now)
			if (timeoutEvent) {
				this.emitOutput(timeoutEvent)
			}
		})
		this.useLane(laneKey)
		let result: DecoderOutput | null
		let announced: DecoderOutput | null
		try {
			result = this.parseLaneLine(cleanLine, now, nowMs)
			// A pending call this line gave its evidence (or whose delay is past)
			// is announced on this line, not on the next timer tick: the stream
			// holds an unnamed call only from its call_start.
			announced = this.checkPendingCallEmission(now, nowMs)
		} finally {
			this.useLane(0)
		}
		if (announced === null) return result
		if (result !== null) this.emitOutput(result)
		return announced
	}

	/** parseOutput's steps 3 to 7, on the line's lane. */
	private parseLaneLine(
		cleanLine: string,
		now: Date,
		nowMs: number,
	): DecoderOutput | null {
		// STEP 3: Track errors for quality metrics (rolling window)
		this.updateErrorWindow(cleanLine, nowMs)
		// STEP 3a: The lane's voice LC header candidate and last sync.
		this.dropErroredCandidate(cleanLine)
		this.noteLaneSync(cleanLine, nowMs)

		// STEP 3b: Publish link-control lines for the scanner (spec § 6.4)
		const link = this.parseLinkLine(cleanLine, nowMs)

		// STEP 3c: Frame counters from what this line already shows (heard vs
		// rejected); decoded frames count when their link is published verified.
		this.countLine(cleanLine)
		if (
			link?.protocol === "dmr" &&
			link.verified &&
			(SYNC_PATTERN.test(cleanLine) || link.voiceLc)
		) {
			if (link.voiceLc) {
				this.pendingDmrVoiceLinks.push(link)
				// dsd-fme prints at most one voice LC per slot between two DMR syncs, so 2 is
				// the real ceiling; 8 leaves headroom while bounding sync-less noise.
				if (this.pendingDmrVoiceLinks.length > MAX_PENDING_DMR_VOICE_LINKS)
					this.pendingDmrVoiceLinks.shift()
			} else this.pendingDmrLink = link
		} else if (link) this.emitLink(link)

		// STEP 3d: A held call_end takes its terminator's trailer (or ends).
		if (this.resolveHeldEnd(cleanLine, now)) return null

		// STEP 4: Check for sync (protocol detection)
		const syncResult = this.handleSync(cleanLine, now)
		// STEP 4b: Call-first: a voice frame sync joins its lane's chain.
		this.trackChain(cleanLine, nowMs)
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
	 * Keeps the lane's last DMR sync line with a burst column (LaneSync): the
	 * preceding sync of the lane's next link control. A bare "Sync: +DMR"
	 * names no burst and changes nothing.
	 */
	private noteLaneSync(line: string, nowMs: number): void {
		const sync = SYNC_PATTERN.exec(line)
		if (sync?.groups?.["proto"]?.toUpperCase() !== "DMR") return
		// Any sync of the lane closes the candidate's burst (dropErroredCandidate).
		if (this.candidate !== undefined) this.candidate.sealed = true
		if (!line.includes("|")) return
		const burst = DMR_BURST.exec(line)?.groups?.["burst"]
		const kind: LaneSync["kind"] =
			burst === undefined
				? "other"
				: burst === "VLC"
					? "vlc"
					: burst === "TLC"
						? "tlc"
						: "voice"
		const clean = !LINE_ERR.test(line)
		if (kind === "voice") this.voiceSeq++
		// One LaneSync per lane, updated in place: no allocation per burst.
		const lane = this.laneSync
		if (lane === undefined) {
			this.laneSync = { kind, clean, atMs: nowMs }
			return
		}
		lane.kind = kind
		lane.clean = clean
		lane.atMs = nowMs
	}

	/**
	 * A voice LC header candidate (VlcCandidate) whose burst printed a late
	 * error line (an error line before the lane's next sync) was not checked:
	 * it is dropped (its IDs are metadata only, never a proof).
	 */
	private dropErroredCandidate(line: string): void {
		const candidate = this.candidate
		if (candidate === undefined || candidate.sealed) return
		if (SYNC_PATTERN.test(line) || !burstError(line)) return
		this.candidate = undefined
	}

	/**
	 * Frame counters: a `Sync:` line is a frame sync heard (`detections`) and
	 * each `CRC ERR` / `FEC ERR` a frame heard but rejected. Sent every 10 s
	 * (COUNTER_FLUSH_MS), never per line.
	 */
	private countLine(line: string): void {
		const sync = SYNC_PATTERN.test(line)
		const crc = CRC_ERR.test(line)
		const fec = line.match(FEC_ERR_ALL)?.length ?? 0
		if (!sync && !crc && fec === 0) return
		this.primeCounters()
		if (sync) this.counters.count("detections")
		if (crc) this.counters.count("crcBad")
		if (fec > 0) this.counters.count("fecBad", fec)
	}

	/**
	 * Every counter dsd-fme supports is reported, at 0 until it grows, so a
	 * dwell of syncs and CRC failures alone still shows `framesOk: 0` (the
	 * reception hint needs a decoded counter). Adding 0 is idempotent, and the
	 * reporter clears its counts when a new child starts.
	 */
	private primeCounters(): void {
		for (const name of DSD_FME_COUNTERS) this.counters.count(name, 0)
	}

	/**
	 * Publishes a link line; one published verified is a frame decoded
	 * (`framesOk`). A DMR link waits for the next sync to attest it
	 * (flushPendingDmrLink), so it only counts once that check accepts it.
	 */
	private emitLink(link: DsdFmeLinkLine): void {
		if (link.verified) {
			this.primeCounters()
			this.counters.count("framesOk")
		}
		this.emit("link", { ...link, at: this.toWallMs(link.at) })
	}

	/** Now on the monotonic clock, on the epoch scale (DsdFmeClock). */
	private monoMs(): number {
		return this.monoEpochMs + this.clock.mono()
	}

	private monoDate(): Date {
		return new Date(this.monoMs())
	}

	/** A monotonic instant as wall time now (what is reported). */
	private toWallMs(monoMs: number): number {
		return monoMs + this.clock.wall() - this.monoMs()
	}

	/**
	 * An output's timestamp in wall time. Its startedAt / endedAt are wall
	 * time already (startWallMs).
	 */
	private outputAtWall(output: DecoderOutput): DecoderOutput {
		const offset = this.clock.wall() - this.monoMs()
		if (offset === 0) return output
		return {
			...output,
			timestamp: new Date(output.timestamp.getTime() + offset),
		}
	}

	/** A call's reported start (startWallMs). */
	private startedAtIso(call: DsdFmeCallState): string {
		return new Date(call.startWallMs).toISOString()
	}

	/** A monotonic instant of a call as wall time: its start plus the mono span. */
	private wallIso(call: DsdFmeCallState, at: Date): string {
		return new Date(
			call.startWallMs + (at.getTime() - call.startTime.getTime()),
		).toISOString()
	}

	/**
	 * Checks if the current call has timed out (no metadata for CALL_TIMEOUT_MS).
	 * Also handles pending calls that have been abandoned.
	 * Returns a call_end event if timeout occurred, otherwise null.
	 */
	private checkCallTimeout(now: Date): DecoderOutput | null {
		const call = this.callState ?? this.pendingCall?.state
		if (!call || now.getTime() <= this.callDeadline(call)) return null
		if (call.heldEnd) return this.closeHeldEnd(now)
		return this.endOngoingCall(now, true)
	}

	private callDeadline(call: DsdFmeCallState): number {
		return (
			call.heldEnd?.untilMs ?? call.lastUpdate.getTime() + this.callTimeoutMs()
		)
	}

	/** Expire old burst context before a new line or timer can settle or publish. */
	private expireDmrEvidence(nowMs: number): void {
		const expire = (lane: number, call: DsdFmeCallState | null | undefined) => {
			if (call?.protocol === "dmr" && nowMs > this.callDeadline(call))
				this.dmrClearance.timeout(
					lane === 1 ? ["1"] : lane === 2 ? ["2"] : ["ms", "x"],
				)
		}
		expire(this.laneKey, this.callState ?? this.pendingCall?.state)
		for (const [lane, state] of this.lanes)
			expire(lane, state.callState ?? state.pendingCall?.state)
	}

	/** Other protocols may omit this field. The publication gate supplies it for DMR. */
	private encryptionKnownField(call: DsdFmeCallState): {
		encryptionKnown?: boolean
	} {
		if (call.protocol === "dmr") return {}
		return call.encryptionKnown !== undefined
			? { encryptionKnown: call.encryptionKnown }
			: {}
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
		if (CRC_ERR.test(line)) {
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
		this.trackSyncState(line, newProtocol)

		// A protocol switch ends the old protocol's call, announced or still
		// pending (endCall announces a pending one first), at its last line
		// (a stray sync of another protocol may come seconds after the
		// over), then this line is parsed as the new protocol's: a "+DSTAR
		// HEADER" line's checked callsign must not be lost (one arrives only
		// every few seconds).
		if (newProtocol !== this.currentProtocol) {
			this.forEachLane(() => {
				const last = (this.callState ?? this.pendingCall?.state)?.lastUpdate
				const ended = this.endOngoingCall(now, false, last)
				if (ended) this.emitOutput(ended)
			})
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
	 * Per-protocol state a sync line updates, before any early return: the
	 * NAC of the last P25 phase 1 NID that decoded ("duid:EE" clears it); the
	 * P25 and NXDN state is dropped on another protocol's sync.
	 */
	private trackSyncState(line: string, protocol: DsdFmeProtocol): void {
		if (protocol === "p25p1") {
			const printed = P25_NAC_PRINT.exec(line)?.[1]
			if (printed !== undefined)
				this.lastP25Nac = /\bduid:EE\b/.test(line)
					? undefined
					: printed.toUpperCase()
		} else this.lastP25Nac = undefined
		if (protocol !== "nxdn48" && protocol !== "nxdn96") {
			this.nxdnCleanAt = undefined
			this.nxdnRan = undefined
			this.nxdnPrintedRan = undefined
			this.nxdnVcallNext = false
		}
	}

	/**
	 * Parses protocol string from sync output to typed protocol.
	 */
	private parseProtocol(proto: string): DsdFmeProtocol {
		const upper = proto.toUpperCase()
		if (upper === "DMR") return "dmr"
		if (upper === "DPMR") return "dpmr"
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
		// A CRC-error line keeps the ongoing call alive but never sets identity,
		// starts or switches a call, or marks one encrypted (run8 key-up garbage).
		// Except a YSF frame whose FICH decoded (the frame type is checked):
		// ysf.c checks each DCH on its own and prints a header's CSD1 "DST: …
		// SRC: …" only when that DCH passed, "DCH (CRC ERR)" for a failed one.
		// A passed block's callsign is the call's; the line's link stays
		// unverified (crcErr). A failed DCH starts or ends nothing by itself.
		if (CRC_ERR.test(line)) {
			// A D-STAR radio header is the next over even when its slow-data copy
			// failed: end the ongoing one (no identity is taken from this line).
			if (this.currentProtocol === "dstar" && DSTAR_HEADER_SYNC.test(line))
				return this.endOngoing("dstar", now)
			if (this.currentProtocol === "ysf" && YSF_FICH_OK.test(line))
				return this.handleYsfLine(line, now)
			this.touchOngoing(now, line)
			return null
		}
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
			case "dpmr":
				return this.handleDpmrLine(line, now)
			default:
				// No protocol detected yet, try to extract metadata anyway
				return this.handleUnknownProtocol(line, now)
		}
	}

	/**
	 * Keeps the ongoing call of the current protocol from timing out. A DMR
	 * call only on its own bursts (a voice burst sync or a slot print): a
	 * repeater's idle and data bursts in hang time are not the call.
	 */
	private touchOngoing(now: Date, line: string): void {
		const ongoing = this.ongoingCall(this.currentProtocol)
		if (ongoing === null) return
		if (
			ongoing.protocol === "dmr" &&
			!DMR_BURST.test(line) &&
			!DMR_SLOT_WORD.test(line)
		)
			return
		ongoing.lastUpdate = now
	}

	/** The lane's call (announced or pending) when it is of `protocol`. */
	private ongoingCall(protocol: DsdFmeProtocol): DsdFmeCallState | null {
		const ongoing = this.callState ?? this.pendingCall?.state ?? null
		return ongoing !== null && ongoing.protocol === protocol ? ongoing : null
	}

	/**
	 * Call-first: adds a voice frame sync of the current protocol to the
	 * lane's chain (SyncChain): DMR voice bursts (VLC, VC*, VC1 to VC6; a TLC
	 * only extends a chain), P25 phase 1 HDU / LDU1 / LDU2 whose NID decoded,
	 * D-STAR header and voice syncs, NXDN voice frames, every YSF and dPMR
	 * sync. A sync more than SYNC_CHAIN_MS after the chain's last one, or a
	 * P25 one printing another NAC, starts a new chain. A DMR sync printing
	 * another colour code keeps the chain (its start) and restarts its run;
	 * a DMR header burst (dmrHeaderLine) with no call on the lane begins a
	 * new chain there: the over starts at its header.
	 */
	private trackChain(line: string, nowMs: number): void {
		const protocol = this.currentProtocol
		if (protocol === null || !SYNC_PATTERN.test(line)) return
		const window = SYNC_CHAIN_MS[protocol]
		if (window === undefined) return
		let tag: string | undefined
		let extendOnly = false
		if (protocol === "dmr") {
			const burst = DMR_BURST.exec(line)?.groups?.["burst"]
			if (dmrHeaderLine(line, burst) && this.ongoingCall("dmr") === null) {
				const live = this.liveChain("dmr", nowMs)
				if (live?.header !== true) {
					this.chain = this.dmrChainAt(line, nowMs)
					return
				}
			}
			if (burst === undefined) return
			extendOnly = burst === "TLC"
			const cc = DMR_COLOR_CODE.exec(line)?.groups?.["cc"]
			tag = cc === undefined ? undefined : String(Number(cc))
		} else if (protocol === "p25p1") {
			if (!P25_VOICE_FRAME.test(line) || /\bduid:EE\b/.test(line)) return
			tag = this.lastP25Nac
		} else if (protocol === "dstar") {
			if (!DSTAR_VOICE_SYNC.test(line)) return
		} else if (protocol === "nxdn48" || protocol === "nxdn96") {
			if (!/\bVOICE\b/i.test(line)) return
		}
		// A YSF frame is clean when its FICH decoded (a failed DCH is still the over's frame).
		const clean =
			protocol === "ysf"
				? YSF_FICH_OK.test(line) || YSF_CRC_OK.test(line)
				: !LINE_ERR.test(line)
		const chain = this.chain
		const fresh =
			chain !== null &&
			chain.protocol === protocol &&
			nowMs >= chain.lastMs &&
			nowMs - chain.lastMs <= window &&
			(protocol === "dmr" ||
				tag === undefined ||
				chain.tag === undefined ||
				chain.tag === tag)
		if (!fresh) {
			this.chain = extendOnly
				? null
				: protocol === "dmr"
					? this.dmrChainAt(line, nowMs)
					: {
							protocol,
							startMs: nowMs,
							lastMs: nowMs,
							clean: clean ? 1 : 0,
							tag,
						}
			return
		}
		if (
			chain.markMs !== undefined &&
			chain.afterMarkMs === undefined &&
			nowMs >= chain.markMs
		) {
			chain.afterMarkMs = nowMs
			chain.beforeMarkMs = chain.lastMs
		}
		chain.lastMs = nowMs
		if (protocol === "dmr") {
			// Another colour code restarts the run ("XX" prints none).
			if (tag !== undefined && chain.tag !== undefined && tag !== chain.tag)
				chain.run = 0
			chain.tag = tag ?? chain.tag
			if (clean) {
				if ((chain.run ?? 0) === 0) chain.runStartMs = nowMs
				chain.run = (chain.run ?? 0) + 1
			}
		} else chain.tag ??= tag
		if (clean) chain.clean++
		// A DMR sync counts in handleDmrSync, once it is known not to begin
		// the next over (dmrRekey).
		if (protocol !== "dmr")
			this.noteEvidence(
				this.callState ?? this.pendingCall?.state ?? null,
				nowMs,
			)
	}

	/**
	 * A DMR chain beginning with `line`'s sync: a voice burst (one clean
	 * sync, its colour code) or a header burst (dmrHeaderLine), which counts
	 * no sync of its own but holds the over's start.
	 */
	private dmrChainAt(line: string, nowMs: number): SyncChain {
		const burst = DMR_BURST.exec(line)?.groups?.["burst"]
		const header = dmrHeaderLine(line, burst)
		const clean = burst !== undefined && !LINE_ERR.test(line)
		const cc = DMR_COLOR_CODE.exec(line)?.groups?.["cc"]
		return {
			protocol: "dmr",
			startMs: nowMs,
			lastMs: nowMs,
			clean: clean ? 1 : 0,
			tag:
				burst === undefined || cc === undefined
					? undefined
					: String(Number(cc)),
			run: clean ? 1 : 0,
			...(clean ? { runStartMs: nowMs } : {}),
			...(header ? { header: true } : {}),
		}
	}

	/** The lane's chain of `protocol` when it is still running at `nowMs`, else null. */
	private liveChain(
		protocol: NonNullable<DsdFmeProtocol>,
		nowMs: number,
	): SyncChain | null {
		const chain = this.chain
		const window = SYNC_CHAIN_MS[protocol]
		if (
			chain === null ||
			window === undefined ||
			chain.protocol !== protocol ||
			nowMs < chain.lastMs ||
			nowMs - chain.lastMs > window
		)
			return null
		return chain
	}

	/** The ongoing call's own identity was seen at `nowMs` (see SyncChain.markMs). */
	private markChain(
		protocol: NonNullable<DsdFmeProtocol>,
		nowMs: number,
	): void {
		const chain = this.liveChain(protocol, nowMs)
		if (chain === null) return
		chain.markMs = nowMs
		chain.afterMarkMs = undefined
		chain.beforeMarkMs = undefined
	}

	/** When the lane's chain of `protocol` (still running at `nowMs`) began, else undefined. */
	private chainStart(
		protocol: NonNullable<DsdFmeProtocol>,
		nowMs: number,
	): Date | undefined {
		const chain = this.liveChain(protocol, nowMs)
		const window = SYNC_CHAIN_MS[protocol]
		if (chain === null || window === undefined) return undefined
		return new Date(
			Math.max(chain.startMs, nowMs - window * BACKDATE_MAX_CHAIN_WINDOWS),
		)
	}

	/**
	 * Call-first start: on the over's second clean voice frame (this line,
	 * clean) the lane's call starts without identities, back-dated to the
	 * chain's first sync. A single sync (noise) starts nothing. A DMR or P25
	 * call does not know yet whether it is encrypted (`encryptionKnown:
	 * false`) until its link control says.
	 */
	private startOnFrames(
		protocol: "dmr" | "p25p1" | "dstar",
		now: Date,
		clean: boolean,
	): void {
		const chain = this.chain
		const nowMs = now.getTime()
		if (
			!clean ||
			chain === null ||
			chain.protocol !== protocol ||
			chain.lastMs !== nowMs ||
			// DMR: two of one colour code (SyncChain.run).
			(protocol === "dmr" ? (chain.run ?? 0) : chain.clean) < 2 ||
			this.callState !== null ||
			this.pendingCall !== null
		)
			return
		// D-STAR calls are keyed 0 / 0 (callsigns attach); DMR and P25 by IDs,
		// unknown yet, or a DMR voice LC header's candidate IDs (VlcCandidate).
		const candidate = protocol === "dmr" ? this.candidate : undefined
		this.candidate = undefined
		const alive =
			candidate !== undefined &&
			nowMs >= candidate.atMs &&
			nowMs - candidate.atMs <= DMR_VLC_CANDIDATE_MS
				? candidate
				: undefined
		const id = protocol === "dstar" ? 0 : null
		const p25: P25Metadata | undefined =
			protocol === "p25p1" && this.lastP25Nac !== undefined
				? { nac: this.lastP25Nac }
				: undefined
		const call = this.startPendingCall(
			now,
			nowMs,
			protocol,
			alive?.talkgroup ?? id,
			alive?.source ?? id,
			protocol === "dmr" && this.laneKey > 0 ? this.laneKey : alive?.slot,
			undefined,
			p25,
		)
		call.onFrames = true
		// A DMR call starts not known clear (startPendingCall).
		if (protocol === "p25p1") call.encryptionKnown = false
		if (protocol === "dmr" && this.laneSync?.kind === "voice")
			call.voiceAtMs = nowMs
		if (alive?.encrypted === true) this.markEncrypted(call)
		this.noteEvidence(call, nowMs)
	}

	/**
	 * A DMR sync line without IDs. Idle, CSBK and data bursts are not call
	 * activity. A voice burst or terminator joins the ongoing call of the
	 * lane, or starts one on the over's second clean frame (startOnFrames). A
	 * header burst (a voice LC header, a PI header, a direct-mode data burst
	 * whose slot type failed: dmrHeaderLine) at least REKEY_GAP_MS after the
	 * call's last voice sync is a re-key: the call ends at its last line (no
	 * terminator) and the header begins the next over's chain. Arrival times
	 * are clumped (DSD_FME_LINE_CLUMP_MS), so no rule here measures a
	 * superframe grid on them: a continuous over is never split by when its
	 * lines arrive, and a re-key with no header, no terminator and the same
	 * IDs stays one call (a missed split, never a split over).
	 */
	private handleDmrSync(line: string, now: Date): DecoderOutput | null {
		const burst = DMR_BURST.exec(line)?.groups?.["burst"]
		const header = dmrHeaderLine(line, burst)
		if (burst === undefined && !header) return null
		const nowMs = now.getTime()
		const voice = burst !== undefined && burst !== "TLC"
		const clean = !LINE_ERR.test(line)
		const ongoing = this.ongoingCall("dmr")
		if (ongoing === null) {
			if (voice || header) {
				// A voice or header burst after a terminator is the next over: the trailer is over.
				this.recentlyTerminated = null
				this.dmrTrainOf.delete(this.laneKey)
				if (voice) this.lastVoiceSyncMs = nowMs
			}
			if (burst !== undefined) this.startOnFrames("dmr", now, clean)
			return null
		}
		if (
			(header && this.dmrRekey(ongoing, nowMs, burst)) ||
			// Voice after a train call's terminators is the next over.
			(ongoing.train === true && (voice || header))
		) {
			// The call ends at its last line before the next over's header.
			const ended = this.endOngoingCall(now, true)
			this.chain = this.dmrChainAt(line, nowMs)
			this.lastVoiceSyncMs = voice ? nowMs : undefined
			return ended
		}
		if (burst === undefined) return null
		ongoing.lastUpdate = now
		if (voice) this.lastVoiceSyncMs = nowMs
		// A voice LC header is not a voice burst (dmrRekey).
		if (voice && burst !== "VLC") ongoing.voiceAtMs ??= nowMs
		this.noteEvidence(ongoing, nowMs)
		const cc = DMR_COLOR_CODE.exec(line)?.groups?.["cc"]
		if (cc !== undefined && ongoing.dmr?.cc === undefined)
			ongoing.dmr = { ...ongoing.dmr, cc: parseInt(cc, 10) }
		return null
	}

	/** No identity: no talkgroup or source, no D-STAR or YSF callsign. */
	private weakMetadata(call: DsdFmeCallState): boolean {
		return (
			(call.talkgroup === 0 || call.talkgroup === null) &&
			(call.source === 0 || call.source === null) &&
			call.dstar?.my === undefined &&
			call.ysf?.callsign === undefined
		)
	}

	/**
	 * Whether a DMR header burst at `nowMs` re-keys (see handleDmrSync): at
	 * least REKEY_GAP_MS after the call's last voice sync (an LC or slot print
	 * is not voice), so the voice LC headers of one key-up (60 ms apart) do
	 * not re-key one another. The bound is one clump at most: two lines of one
	 * clump arrive a few ms apart, of two clumps about 340 ms apart. A voice
	 * LC header repeated before any voice burst of the call is the same
	 * key-up (a direct radio sends several; one may print a garbled colour
	 * code): its link control splits the call only if it names other IDs.
	 */
	private dmrRekey(
		ongoing: DsdFmeCallState,
		nowMs: number,
		burst: string | undefined,
	): boolean {
		if (burst === "VLC" && ongoing.voiceAtMs === undefined) return false
		const last = this.lastVoiceSyncMs ?? ongoing.lastUpdate.getTime()
		return nowMs >= last && nowMs - last >= REKEY_GAP_MS
	}

	/**
	 * A P25 phase 1 HDU / LDU sync whose NID decoded joins the ongoing call or
	 * starts one on the second (startOnFrames). A header after REKEY_GAP_MS
	 * without voice from the call is the next over.
	 */
	private handleP25Frame(line: string, now: Date): DecoderOutput | null {
		const duid = P25_VOICE_FRAME.exec(line)?.groups?.["duid"]
		if (duid === undefined || /\bduid:EE\b/.test(line)) return null
		const ongoing = this.ongoingCall("p25p1")
		if (ongoing === null) {
			this.startOnFrames("p25p1", now, !LINE_ERR.test(line))
			return null
		}
		const nowMs = now.getTime()
		if (
			duid === "HDU" &&
			nowMs - ongoing.lastUpdate.getTime() >= REKEY_GAP_MS
		) {
			const chain = this.chain
			const ended = this.endOngoingCall(now, true)
			this.chain = chain
			if (chain !== null && chain.lastMs === nowMs) {
				chain.startMs = nowMs
				chain.clean = 1
			}
			return ended
		}
		ongoing.lastUpdate = now
		return null
	}

	/** Only a following DMR sync can attest the previous burst tail. */
	private flushPendingDmrLink(
		verified: boolean,
		headerVerified = verified,
	): void {
		const pending = this.pendingDmrLink
		this.pendingDmrLink = undefined
		if (pending) this.emitLink({ ...pending, verified: headerVerified })
		const voices = this.pendingDmrVoiceLinks
		this.pendingDmrVoiceLinks = []
		for (const voice of voices) {
			if (verified) this.emitLink(voice)
			else {
				const { tg: _tg, src: _src, voiceLc: _voiceLc, ...unverified } = voice
				this.emitLink({ ...unverified, verified: false })
			}
		}
	}

	/**
	 * Parses one link-control line of the line's own sync protocol (or the
	 * current one). Returns null for lines without identity fields.
	 */
	private parseLinkLine(line: string, at: number): DsdFmeLinkLine | null {
		this.nxdnLineIds = undefined
		const sync = SYNC_PATTERN.exec(line)
		const dmrSync = sync?.groups?.["proto"]?.toUpperCase() === "DMR"
		const pending = this.pendingDmrLink ?? this.pendingDmrVoiceLinks[0]
		if (pending) {
			const expired = at - pending.at > CALL_TIMEOUT_MS
			const lost = /Frame Sync Err\b|SYNC LOST|no sync/i.test(line)
			if (expired || lost || sync)
				// ed1d1d6 dmr_ms.c:676-686 prints CC before dmr_data_sync decodes
				// the slot type. Only a matching closing CC can attest MS CC.
				this.flushPendingDmrLink(
					!expired && !lost && dmrSync,
					!expired &&
						!lost &&
						dmrSync &&
						(!this.linkDmrMs ||
							Number(DMR_COLOR_CODE.exec(line)?.groups?.["cc"]) ===
								this.pendingDmrLink?.cc),
				)
			else if (
				CRC_ERR.test(line) ||
				/\bFEC\s+ERR\b| -RAS |\bKey:.*(?:ERR|error)/i.test(line)
			) {
				this.flushPendingDmrLink(false)
				this.linkDmrCc.clear()
			}
		}
		// dmr_ms.c/dmr_bs.c: loss of frame sync ends the burst sequence.
		if (/Frame Sync Err\b|SYNC LOST|no sync/i.test(line) || (sync && !dmrSync))
			this.linkDmrCc.clear()
		const protocol = sync?.groups
			? this.parseProtocol(sync.groups["proto"] ?? "")
			: this.currentProtocol
		const crcErr = CRC_ERR.test(line)
		const fecErrs = line.match(FEC_ERR_ALL)?.length ?? 0
		if (/CACH\/Burst FEC ERR/i.test(line)) {
			this.linkDmrCc.clear()
			return null
		}
		const clean = !crcErr && fecErrs === 0 && !/ -RAS /.test(line)
		const base = {
			verified: false,
			crcErr,
			at,
			...(fecErrs > 0 ? { fecErrs } : {}),
		}
		const ids = (
			groups: Record<string, string> | undefined,
			tg: string,
			src: string,
		) =>
			groups
				? {
						tg: String(parseInt(groups[tg] ?? "0", 10)),
						src: String(parseInt(groups[src] ?? "0", 10)),
					}
				: {}
		switch (protocol) {
			case "dmr": {
				const printedCc = DMR_COLOR_CODE.exec(line)?.groups?.["cc"]
				const cc =
					printedCc !== undefined && Number(printedCc) <= 15
						? Number(printedCc)
						: undefined
				const slotText =
					DMR_CURRENT_SLOT.exec(line)?.groups?.["slot"] ??
					DMR_SLOT_INLINE.exec(line)?.groups?.["slot"] ??
					DMR_SLOT_WORD.exec(line)?.groups?.["slot"]
				if (sync) this.linkDmrMs = /\bMS\/DM\b/i.test(line)
				// dmr_bs.c marks the current TDMA slot with brackets; dmr_ms.c
				// has one channel, regardless of the SLOT number on its voice LC.
				const ccKey = this.linkDmrMs ? "ms" : slotText
				if (sync && ccKey !== undefined) {
					if (clean && cc !== undefined) this.linkDmrCc.set(ccKey, { cc, at })
					else this.linkDmrCc.delete(ccKey)
				}
				const idGroups =
					DMR_VOICE_EVENT.exec(line)?.groups ?? DMR_TGT_SRC.exec(line)?.groups
				// dmr_dburst.c:88-185 selects PI/VLC/TLC/CSBK/MBCH/DATA/USBD.
				// ed1d1d6:115-119 MBCC (0x05) has no own CRC; :627
				// skips CRC ERR for it. Only dmr_block.c checks the final block.
				// Its shared FEC/CRC errors print at 610-630, AFTER payload handlers:
				// VLC/TLC dmr_flco.c:809-815 and USBD dmr_dburst.c:589-594
				// can start a new line first; MBCH/MBCC use dmr_block.c:1464
				// (multiline CRC16 ERR), DATA uses its :1331 (CRC32 ERR).
				// SLCO errors also continue (dmr_flco.c:981). Hold headers until
				// the next sync, rejecting any error in the entire burst tail.
				// VC/IDLE
				// only print a weak or stale CC. ed1d1d6 dmr_flco.c:403 prints
				// SLOT TGT/SRC after LC FEC passes, but :778 can start a Key:
				// line before dmr_dburst.c:627 prints the burst CRC error.
				// Hold voice LC too; call handling still consumes it immediately.
				const voiceLc =
					idGroups !== undefined &&
					/\bSLOT\s+[12]\s+TGT=\d+\s+SRC=\d+\b/i.test(line)
				const verified =
					clean &&
					(voiceLc ||
						(sync !== null &&
							/\|\s*(?:PI|VLC|TLC|CSBK|MBCH|DATA|USBD)\b/.test(line)))
				const previousCc =
					ccKey !== undefined ? this.linkDmrCc.get(ccKey) : undefined
				const identityCc =
					cc ??
					(clean &&
					voiceLc &&
					// ed1d1d6 dmr_ms.c:676-686 prints the opening CC before
					// slot-type decode. LC must not bypass the pending check.
					!(this.linkDmrMs && this.pendingDmrLink) &&
					previousCc &&
					at - previousCc.at <= CALL_TIMEOUT_MS
						? previousCc.cc
						: undefined)
				if (cc === undefined && idGroups === undefined && !sync) return null
				const svc = DMR_TLC_FIELDS.exec(line)?.groups?.["svc"]
				const alg = ALG_ID.exec(line)?.groups?.["alg"]
				const encrypted =
					(idGroups !== undefined && DMR_ENCRYPTED.test(line)) ||
					(svc !== undefined && (parseInt(svc, 16) & DMR_SVC_PRIVACY) !== 0) ||
					(alg !== undefined && !isClearAlgorithm(alg))
				return {
					protocol: "dmr",
					...(identityCc !== undefined ? { cc: identityCc } : {}),
					...ids(idGroups, "tgt", "src"),
					...(slotText === "1"
						? { slot: 1 as const }
						: slotText === "2"
							? { slot: 2 as const }
							: {}),
					...base,
					verified,
					...(verified && voiceLc ? { voiceLc: true } : {}),
					...(encrypted ? { encrypted: true } : {}),
				}
			}
			case "p25p1":
			case "p25p2": {
				// dsd_frame.c:34-36 prints cached p2_cc as NAC/CC, even beside
				// a current checked DUID. It updates only on NAC correction at
				// 390-396; even plain NAC is stored state. No supported print
				// explicitly binds NAC to this frame's checked NID: hints only.
				// A failed NID ("duid:EE") prints a NAC it did not decode.
				const nac = /\bduid:EE\b/.test(line)
					? undefined
					: (/\bNAC(?:\/CC)?:\s*([0-9A-F]{3});/i.exec(line)?.[1] ??
						P25_NAC.exec(line)?.groups?.["nac"])
				const lcw =
					protocol === "p25p1" ? P25_LCW_GROUP.exec(line)?.groups : undefined
				const unit =
					protocol === "p25p1" ? P25_LCW_UNIT.exec(line)?.groups : undefined
				const idGroups =
					lcw ?? P25_SRC_TG.exec(line)?.groups ?? P25P2_VCH.exec(line)?.groups
				const alg = ALG_ID.exec(line)?.groups?.["alg"]
				if (
					nac === undefined &&
					idGroups === undefined &&
					unit === undefined &&
					alg === undefined
				)
					return null
				// Only the RS-checked LCW print attests talkgroup and source; a unit
				// to unit LCW attests the source only (its target is no talkgroup).
				const lcwChecked = (lcw !== undefined || unit !== undefined) && clean
				return {
					protocol: "p25",
					...(nac !== undefined ? { nac: nac.toUpperCase() } : {}),
					...(unit !== undefined
						? { src: String(parseInt(unit["src"] ?? "0", 10)) }
						: ids(idGroups, "tg", "src")),
					...base,
					verified: lcwChecked,
					...(lcwChecked && lcw !== undefined ? { voiceLc: true } : {}),
					...((alg !== undefined && !isClearAlgorithm(alg)) ||
					((lcw !== undefined || unit !== undefined) &&
						DMR_ENCRYPTED.test(line))
						? { encrypted: true }
						: {}),
				}
			}
			case "nxdn48":
			case "nxdn96": {
				// ed1d1d6 nxdn_deperm.c:466,564,762 prints cached SACCH/CAC RAN.
				// :1390-1437 prints current RAN only inside crc == check,
				// then " FACCH2"/" UDCH" (two spaces after the RAN).
				const checkedRan = /\bRAN\s+(\d{2})\s+(?:FACCH2|UDCH)\b/.exec(line)?.[1]
				const sacch = this.nxdnSacchLine(line, at)
				const ran = checkedRan ?? sacch.ran
				// The VCALL print is gated on its own CRC (nxdnVcallIds).
				const vcall = this.nxdnVcallIds(line)
				const idGroups = vcall
				if (ran === undefined && idGroups === undefined) return null
				return {
					protocol: "nxdn",
					...(ran !== undefined ? { ran: parseInt(ran, 10) } : {}),
					...ids(idGroups, "tgt", "src"),
					...base,
					verified:
						clean &&
						(checkedRan !== undefined ||
							sacch.attested ||
							(vcall !== undefined && ran === undefined)),
				}
			}
			case "ysf": {
				// ysf.c prints CODE as its SQL code; this parser does not map it to DG-ID.
				// A source callsign from a CRC-checked DCH is checked.
				const callsign = ysfSourceCallsign(line)
				if (callsign !== undefined)
					return { protocol: "ysf", callsign, ...base, verified: clean }
				return sync || /\bFICH\b/i.test(line)
					? { protocol: "ysf", ...base }
					: null
			}
			case "dstar": {
				// The CRC-checked slow-data header is proof; the radio header
				// (dstar_header.c, no FCS check) and the MY format are not.
				const header = checkedDstarHeader(line)
				if (header !== undefined)
					return {
						protocol: "dstar",
						callsign: header.my,
						...base,
						verified: clean,
					}
				return null
			}
			case "dpmr":
				// dpmr_voice.c: Channel Code is stashed state, "no guarantee",
				// even when CallingIDOk passes. Do not turn it into an identity.
				return sync || /Channel Code/.test(line)
					? { protocol: "dpmr", ...base }
					: null
			default:
				return null
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

		// MS/DM (direct) is one channel: its printed SLOT number names nothing.
		const matchSlot = this.linkDmrMs ? undefined : slot
		// If we have TGT+SRC, process call state
		if (tgt !== null && src !== null)
			return this.handleDmrIds(line, now, tgt, src, slot, dmrMeta, encrypted)
		// A clear algorithm print names no key: it never proves a call clear
		// (only a link control equal to the call's IDs does), so it only
		// drops a pending proof, as any unlisted line does (dsd-fme-dmr-clearance.ts).
		if (encrypted) this.markDmrEncrypted(matchSlot)

		// Only the over's own voice bursts keep its call alive or start one
		// (handleDmrSync): idle and data bursts do not.
		if (SYNC_PATTERN.test(line)) return this.handleDmrSync(line, now)
		return null
	}

	/**
	 * A DMR link control naming TGT/SRC, against the lane's preceding sync
	 * (LaneSync):
	 *
	 * - after a terminator (the repeater's train of TLC + LC pairs) or any
	 *   other non-voice burst, it never starts a call, names one, or says it
	 *   is clear; nor does an implausible ID (dmrIdsPlausible), nor a
	 *   repeater print of another slot than the sync line before it;
	 * - after a voice LC header whose sync printed an error, its IDs are only
	 *   the over's candidate (VlcCandidate);
	 * - after a voice burst, IDs other than the running call's are another
	 *   talker's only on a second agreeing copy (the call splits, the next
	 *   one unknown); the first copy revokes known clear on the same callId;
	 * - otherwise it starts, names or refreshes the call (processCallMetadata).
	 *
	 * Known clear is decided apart, by the clearance machine.
	 */
	private handleDmrIds(
		line: string,
		now: Date,
		tgt: number,
		src: number,
		slot: number | undefined,
		dmrMeta: DmrMetadata | undefined,
		encrypted: boolean,
	): DecoderOutput | null {
		const sync = this.laneSync
		const matchSlot = this.linkDmrMs ? undefined : slot
		if (sync?.kind === "other") {
			this.rejectDmrIds("not after voice")
			return null
		}
		if (sync?.kind === "tlc")
			return this.handleDmrTrainIds(
				line,
				now,
				tgt,
				src,
				slot,
				dmrMeta,
				encrypted,
			)
		// dsd-fme prints a repeater burst's link control right after its sync
		// line, with that sync's slot (every recorded LC does): one printing
		// the other slot is not this burst's.
		if (
			!this.linkDmrMs &&
			this.dmrBs &&
			slot !== undefined &&
			slot !== this.dmrBsSlot
		) {
			this.rejectDmrIds("other slot")
			return null
		}
		// An unchecked link control (its line printed an error: CRC, FEC, RAS,
		// a key error) is never a candidate, a start or a rival. It may still
		// say encrypted: muting is the safe side.
		if (burstError(line)) {
			if (encrypted) this.markDmrEncrypted(matchSlot)
			this.rejectDmrIds("burst error")
			return null
		}
		if (!dmrIdsPlausible(line, tgt, src)) {
			this.rejectDmrIds("implausible")
			return null
		}
		const ongoing = this.ongoingCall("dmr")
		const named =
			ongoing !== null && ongoing.talkgroup !== null && ongoing.source !== null
		const other = named && (ongoing.talkgroup !== tgt || ongoing.source !== src)
		if (named && !other) ongoing.rival = undefined
		if (other && sync?.kind === "voice") {
			const rival = ongoing.rival
			// The second copy must follow a newer voice burst of the lane than
			// the first (voiceSeq): a burst that prints its IDs twice is one copy.
			if (
				rival?.talkgroup === tgt &&
				rival.source === src &&
				this.voiceSeq <= rival.voiceSeq
			) {
				this.rejectDmrIds("same burst")
				return null
			}
			if (rival?.talkgroup !== tgt || rival.source !== src) {
				ongoing.rival = {
					talkgroup: tgt,
					source: src,
					voiceSeq: this.voiceSeq,
				}
				// The clearance machine revokes known clear on this copy.
				ongoing.lastUpdate = now
				this.rejectDmrIds("single copy")
				return null
			}
			// Two agreeing copies: the next talker. The running call ends (case
			// 3), and the next one is not known clear until its own link control.
			ongoing.rival = undefined
			const event = this.processCallMetadata(
				now,
				"dmr",
				tgt,
				src,
				slot,
				dmrMeta,
			)
			const next = this.ongoingCall("dmr")
			if (next !== null && next !== ongoing) next.voiceAtMs = sync.atMs
			if (encrypted) this.markDmrEncrypted(matchSlot)
			return event
		}
		if (ongoing === null && sync?.kind === "vlc" && !sync.clean) {
			this.candidate = {
				talkgroup: tgt,
				source: src,
				slot: this.laneKey > 0 ? this.laneKey : slot,
				encrypted,
				atMs: now.getTime(),
				sealed: false,
			}
			return null
		}
		const event = this.processCallMetadata(now, "dmr", tgt, src, slot, dmrMeta)
		const call = this.ongoingCall("dmr")
		if (call !== null && call !== ongoing)
			call.voiceAtMs = sync?.kind === "voice" ? sync.atMs : undefined
		// Whether the call is known clear is the clearance machine's alone
		// (dsd-fme-dmr-clearance.ts): every DMR call starts not known clear.
		if (encrypted) this.markDmrEncrypted(matchSlot)
		return event
	}

	/**
	 * A DMR link control after a terminator (TLC + LC, a repeater's hang
	 * train or a direct radio's end of transmission). Its IDs never name or
	 * clear a running call. A checked, plausible one of this burst's slot:
	 *
	 * - names the call that just ended on the lane (same IDs within
	 *   CALL_TIMEOUT_MS, dmrTrainOf): its hang train, no new call; other IDs
	 *   inside that train start the next talker's call only on a second
	 *   agreeing copy (a false link control of a train is one copy);
	 * - refreshes a running train call of the same IDs;
	 * - against a running train call of other IDs, is the next talker on a
	 *   second agreeing copy (the first is a rival only);
	 * - with no call on the lane, starts one (a train call): an over whose
	 *   voice was not decoded is still a call (its metadata always
	 *   publishes; the clearance machine never clears it, voiceless).
	 */
	private handleDmrTrainIds(
		line: string,
		now: Date,
		tgt: number,
		src: number,
		slot: number | undefined,
		dmrMeta: DmrMetadata | undefined,
		encrypted: boolean,
	): DecoderOutput | null {
		const nowMs = now.getTime()
		if (
			(!this.linkDmrMs &&
				this.dmrBs &&
				slot !== undefined &&
				slot !== this.dmrBsSlot) ||
			burstError(line) ||
			!dmrIdsPlausible(line, tgt, src) ||
			// A repeater terminator that bracketed no slot: its slot is unknown.
			(!this.linkDmrMs && !this.dmrBs)
		) {
			this.rejectDmrIds("not after voice")
			return null
		}
		const matchSlot = this.linkDmrMs ? undefined : slot
		let ongoing = this.ongoingCall("dmr")
		// A named call whose end waits for its terminator's trailer, and this
		// trailer names another talker (resolveHeldEnd marked the burst not
		// clean): the call ends at its terminator, and this is the next over.
		if (
			ongoing?.heldEnd !== undefined &&
			ongoing.talkgroup !== null &&
			(ongoing.talkgroup !== tgt || ongoing.source !== src)
		) {
			const ended = this.closeHeldEnd(now)
			if (ended) this.emitOutput(ended)
			ongoing = this.ongoingCall("dmr")
		}
		if (ongoing !== null) {
			if (ongoing.train !== true || ongoing.talkgroup === null) {
				this.rejectDmrIds("not after voice")
				return null
			}
			if (ongoing.talkgroup === tgt && ongoing.source === src) {
				ongoing.rival = undefined
				ongoing.lastUpdate = now
				if (encrypted) this.markDmrEncrypted(matchSlot)
				return null
			}
			// Another talker splits a train call on a second agreeing copy,
			// announced or not (its announcement time depends on its trust).
			const rival = ongoing.rival
			if (rival?.talkgroup !== tgt || rival.source !== src) {
				ongoing.rival = { talkgroup: tgt, source: src, voiceSeq: this.voiceSeq }
				this.rejectDmrIds("single copy")
				return null
			}
			ongoing.rival = undefined
		} else {
			// The terminator's own link control right after it (the trailer
			// window, processCallMetadata's rule): its call's train, no new call.
			const trailer = this.recentlyTerminated
			if (
				trailer?.protocol === "dmr" &&
				nowMs <= trailer.untilMs &&
				((trailer.talkgroup === null && trailer.source === null) ||
					(trailer.talkgroup === tgt && trailer.source === src))
			) {
				this.recentlyTerminated = null
				this.dmrTrainOf.set(this.laneKey, {
					talkgroup: tgt,
					source: src,
					atMs: nowMs,
					rival: undefined,
				})
				this.rejectDmrIds("trailer")
				return null
			}
			const last = this.dmrTrainOf.get(this.laneKey)
			if (
				last !== undefined &&
				nowMs >= last.atMs &&
				nowMs - last.atMs <= CALL_TIMEOUT_MS
			) {
				if (last.talkgroup === tgt && last.source === src) {
					last.atMs = nowMs
					last.rival = undefined
					this.rejectDmrIds("train")
					return null
				}
				if (last.rival?.talkgroup !== tgt || last.rival.source !== src) {
					last.rival = { talkgroup: tgt, source: src }
					this.rejectDmrIds("single copy")
					return null
				}
			}
			this.dmrTrainOf.delete(this.laneKey)
		}
		this.recentlyTerminated = null
		const event = this.processCallMetadata(now, "dmr", tgt, src, slot, dmrMeta)
		const call = this.ongoingCall("dmr")
		if (call !== null && call !== ongoing) {
			call.train = true
			call.voiceAtMs = undefined
			this.dmrClearance.voiceless(call.callId)
		}
		if (encrypted) this.markDmrEncrypted(matchSlot)
		return event
	}

	/** A DMR link control whose IDs were not taken (dmrIdRejected). */
	private rejectDmrIds(reason: string): void {
		this.dmrIdRejected++
		this.logger.debug({ reason }, "DMR link control IDs not taken")
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
		else if (alg !== undefined && !burstError(line)) this.markKnown(call)
	}

	/**
	 * Handles P25 Phase 1 line parsing.
	 * Requires tg+src to start a call.
	 */
	private handleP25P1Line(line: string, now: Date): DecoderOutput | null {
		if (SYNC_PATTERN.test(line)) {
			const framed = this.handleP25Frame(line, now)
			if (framed) return framed
		}
		// The LCW print that carries talkgroup and source has no NAC of its
		// own: the call takes the last sync line's (trackSyncState).
		const lcw = P25_LCW_GROUP.exec(line)?.groups
		const unit = P25_LCW_UNIT.exec(line)?.groups
		if (lcw ?? unit) {
			const tg = lcw ? parseInt(lcw["tg"] ?? "0", 10) : 0
			const src = parseInt((lcw ?? unit)?.["src"] ?? "0", 10)
			const target = unit ? parseInt(unit["target"] ?? "0", 10) : undefined
			if (tg > 0 || src > 0) {
				// Unit to unit calls are keyed (0, source): another target is
				// another call, so start and end always name the same target.
				const ongoing = this.callState ?? this.pendingCall?.state ?? null
				const split =
					ongoing?.protocol === "p25p1" &&
					ongoing.talkgroup === tg &&
					ongoing.source === src &&
					ongoing.p25?.unitTarget !== target
						? this.endOngoingCall(now)
						: null
				const p25: P25Metadata = {
					...(this.lastP25Nac !== undefined ? { nac: this.lastP25Nac } : {}),
					...(target !== undefined ? { unitTarget: target } : {}),
				}
				const event = this.processCallMetadata(
					now,
					"p25p1",
					tg,
					src,
					undefined,
					undefined,
					p25.nac !== undefined || target !== undefined ? p25 : undefined,
				)
				// LCW service option bit 0x40 prints " Encrypted"; without it the
				// call is known clear.
				const call = this.ongoingCall("p25p1")
				if (DMR_ENCRYPTED.test(line) && call !== null) this.markEncrypted(call)
				else this.markKnown(call)
				if (split && event) this.emitOutput(split)
				return event ?? split
			}
		}

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
				const event = this.processCallMetadata(
					now,
					"p25p1",
					tg,
					src,
					undefined,
					undefined,
					p25Meta,
				)
				// This print carries no service options: only an ALG it shows (an
				// error-free line for "clear") says whether the call is encrypted.
				this.applyP25Crypto(line, "p25p1")
				return event
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
		const protocol = this.currentProtocol as "nxdn48" | "nxdn96"
		// RAN: the SACCH print attested by consecutive clean frames
		// (nxdnSacchLine, already run by the link parser for this line).
		const ran = NXDN_SACCH_RAN.test(line) ? this.nxdnRan : undefined
		const nxdnMeta: NxdnMetadata | undefined =
			ran !== undefined
				? { ran }
				: this.nxdnRan !== undefined
					? { ran: this.nxdnRan }
					: undefined

		// Source and destination: the CRC-gated VCALL print (nxdnVcallIds, run
		// by the link parser for this line).
		const ids = this.nxdnLineIds
		const ongoing = this.callState ?? this.pendingCall?.state ?? null
		if (ids) {
			const tgt = parseInt(ids["tgt"] ?? "0", 10)
			const src = parseInt(ids["src"] ?? "0", 10)
			if (tgt === 0 && src === 0) return null
			// A call heard by RAN alone (tuned in mid-call) takes its IDs when the
			// VCALL arrives instead of splitting into a second call, but only
			// within NXDN_ADOPT_IDS_MS of its start: later IDs are another over.
			if (
				ongoing?.protocol === protocol &&
				ongoing.talkgroup === 0 &&
				ongoing.source === 0 &&
				now.getTime() - ongoing.startTime.getTime() <= NXDN_ADOPT_IDS_MS
			)
				this.bindDmrCall(ongoing, now.getTime(), {
					talkgroup: tgt,
					source: src,
				})
			return this.processCallMetadata(
				now,
				protocol,
				tgt,
				src,
				undefined,
				undefined,
				undefined,
				nxdnMeta,
			)
		}

		// Voice frames carry the RAN only: keep the ongoing call, or start one.
		if (!NXDN_VOICE_DATA.test(line) || !/\bVOICE\b/i.test(line)) return null
		if (ran === undefined) return null
		if (ongoing && ongoing.protocol === protocol) {
			ongoing.lastUpdate = now
			ongoing.nxdn = { ...ongoing.nxdn, ran }
			return null
		}
		return this.processCallMetadata(
			now,
			protocol,
			0,
			0,
			undefined,
			undefined,
			undefined,
			{ ran },
		)
	}

	/**
	 * NXDN SACCH print of one frame line (NXDN_SACCH_RAN). The RAN printed is
	 * the one the last CRC-passed SACCH stored. When this frame's SACCH also
	 * passed and the previous frame line, at most NXDN_CONSECUTIVE_MS
	 * earlier, passed too, that stored RAN is the previous frame's checked
	 * one: the RAN is attested. Runs once per line (from parseLinkLine).
	 */
	private nxdnSacchLine(
		line: string,
		at: number,
	): { ran?: string; attested: boolean } {
		if (!SYNC_PATTERN.test(line)) return { attested: false }
		const ok =
			NXDN_SACCH_OK.test(line) &&
			!CRC_ERR.test(line) &&
			!/\bFEC\s+ERR\b/i.test(line)
		const previous = this.nxdnCleanAt
		const previousRan = this.nxdnPrintedRan
		this.nxdnCleanAt = ok ? at : undefined
		const ran = NXDN_SACCH_RAN.exec(line)?.groups?.["ran"]
		this.nxdnPrintedRan = ok ? ran : undefined
		// The same RAN printed by two consecutive clean frames: CRC-6 passes in
		// a row stored it, so one chance pass cannot attest a RAN.
		const attested =
			ok &&
			ran !== undefined &&
			ran === previousRan &&
			previous !== undefined &&
			at >= previous &&
			at - previous <= NXDN_CONSECUTIVE_MS
		if (attested) this.nxdnRan = parseInt(ran, 10)
		else if (!ok) this.nxdnRan = undefined
		return ran !== undefined ? { ran, attested } : { attested }
	}

	/**
	 * VCALL unit IDs of an NXDN line: "Src=1234 - Dst/TG=5678" right after a
	 * frame line ending in VCALL (NXDN_VCALL_LINE), printed only after that
	 * FACCH1 or SACCH superframe passed its CRC. Grant, release and
	 * disconnect IDs are not this channel's call. Runs once per line (from
	 * parseLinkLine) and keeps the result for handleNxdnLine.
	 */
	private nxdnVcallIds(line: string): Record<string, string> | undefined {
		const after = this.nxdnVcallNext
		this.nxdnVcallNext =
			NXDN_VCALL_LINE.test(line) &&
			NXDN_TRAFFIC_LINE.test(line) &&
			!CRC_ERR.test(line)
		const ids = after ? NXDN_SRC_DST.exec(line)?.groups : undefined
		this.nxdnLineIds = ids
		return ids
	}

	/**
	 * Handles YSF line parsing.
	 * Requires at least one CRC-OK FICH block to start a call.
	 */
	private handleYsfLine(line: string, now: Date): DecoderOutput | null {
		// YSF requires a CRC-OK FICH block to be considered valid
		if (!YSF_FICH_OK.test(line) && !YSF_CRC_OK.test(line)) {
			return null
		}

		// YSF doesn't have traditional TGT/SRC, but we track calls anyway
		// Use 0 as placeholder for talkgroup/source
		const callsign = ysfSourceCallsign(line)
		// A terminator ends the ongoing over (handleTermination) and starts
		// nothing: tuning in at the end of an over is not a call.
		if (YSF_TERMINATOR.test(line)) {
			const ongoing = this.callState ?? this.pendingCall?.state ?? null
			if (ongoing?.protocol === "ysf") {
				ongoing.lastUpdate = now
				if (callsign !== undefined && ongoing.ysf?.callsign === undefined)
					ongoing.ysf = { ...ongoing.ysf, callsign }
			}
			return null
		}
		// A header frame whose FICH decoded is a new over, even from the same
		// station or with a failed CSD1. Its frame begins the next over's chain.
		const chain = this.chain
		const nowMs = now.getTime()
		const split = YSF_HEADER_FRAME.test(line)
			? this.endOngoing("ysf", now)
			: callsign !== undefined
				? this.endOnNewStation("ysf", callsign, now)
				: null
		if (split !== null || this.chain === null) {
			if (chain !== null && chain.protocol === "ysf" && chain.lastMs === nowMs)
				this.chain = {
					protocol: "ysf",
					startMs: nowMs,
					lastMs: nowMs,
					clean: 1,
				}
		}
		// Call-first: the over's second clean frame starts the call (back-dated
		// to its chain's first sync); a callsign printed before then attaches.
		let lead = callsign
		if (this.ongoingCall("ysf") === null) {
			const live = this.liveChain("ysf", nowMs)
			if (live === null || live.lastMs !== nowMs || live.clean < 2) {
				if (live !== null && callsign !== undefined) live.lead ??= callsign
				return split
			}
			lead ??= live.lead
		}
		const event = this.processCallMetadata(
			now,
			"ysf",
			0,
			0,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			lead !== undefined ? { callsign: lead } : undefined,
		)
		return split ?? event
	}

	/**
	 * Ends the ongoing call, announced or pending (a pending one starts
	 * first); `noTerminator`: at its last line (endCall's timeout end).
	 */
	private endOngoingCall(
		now: Date,
		noTerminator = false,
		endAt?: Date,
	): DecoderOutput | null {
		if (!this.callState && this.pendingCall) {
			this.callState = this.pendingCall.state
			this.pendingCall = null
		}
		return this.endCall(now, noTerminator, endAt)
	}

	/** Ends (or drops, if not yet announced) the ongoing call of `protocol`. */
	private endOngoing(
		protocol: "dstar" | "ysf",
		now: Date,
	): DecoderOutput | null {
		const ongoing = this.callState ?? this.pendingCall?.state ?? null
		if (ongoing?.protocol !== protocol) return null
		if (this.callState === ongoing) return this.endCall(now, false)
		this.pendingCall = null
		this.chain = null
		return null
	}

	/**
	 * D-STAR and YSF calls are keyed 0 / 0, so a checked callsign that differs
	 * from the ongoing call's is the next station: end (or drop, if not yet
	 * announced) that call so the new one starts on its own.
	 */
	private endOnNewStation(
		protocol: "dstar" | "ysf",
		callsign: string,
		now: Date,
	): DecoderOutput | null {
		const ongoing = this.callState ?? this.pendingCall?.state ?? null
		if (ongoing?.protocol !== protocol) return null
		const current =
			protocol === "dstar" ? ongoing.dstar?.my : ongoing.ysf?.callsign
		if (current === undefined || current === callsign) return null
		if (this.callState === ongoing) return this.endCall(now, false)
		this.pendingCall = null
		this.chain = null
		return null
	}

	/**
	 * Handles D-Star line parsing.
	 * Requires MY/UR/RPT1/RPT2 header fields to start a call.
	 */
	private handleDStarLine(line: string, now: Date): DecoderOutput | null {
		// The CRC-checked header as dsd-fme prints it (see DSTAR_HEADER_BLOCK).
		const checked = checkedDstarHeader(line)
		if (checked !== undefined) {
			// A "+DSTAR HEADER" line is a new over, even from the same station.
			const split = DSTAR_HEADER_SYNC.test(line)
				? this.endOngoing("dstar", now)
				: this.endOnNewStation("dstar", checked.my, now)
			const event = this.processCallMetadata(
				now,
				"dstar",
				0,
				0,
				undefined,
				undefined,
				undefined,
				undefined,
				checked,
			)
			return split ?? event
		}
		// A superframe without the header in its slow data (text, GPS) still
		// belongs to the ongoing over; a radio header starts the next one,
		// and its chain (call-first: the next voice sync starts the call).
		if (DSTAR_HEADER_SYNC.test(line)) {
			const chain = this.chain
			const ended = this.endOngoing("dstar", now)
			const nowMs = now.getTime()
			if (chain !== null && chain.lastMs === nowMs) {
				chain.startMs = nowMs
				chain.clean = LINE_ERR.test(line) ? 0 : 1
				this.chain = chain
			}
			return ended
		}
		if (DSTAR_VOICE_SYNC.test(line)) {
			const ongoing = this.ongoingCall("dstar")
			if (ongoing !== null) ongoing.lastUpdate = now
			else this.startOnFrames("dstar", now, !LINE_ERR.test(line))
		}
		return null
	}

	/**
	 * dPMR voice: dpmr_voice.c prints " TG=0001234 Src=0005678 Channel
	 * Code=05" after each FS2 pair, but marks an ID "OK" when its CRC failed
	 * and two Hamming words merely looked correctable (a synthetic
	 * acquisition printed a wrong Src that way). So the IDs stay out of the
	 * call: a printed TG or Src only shows the protocol is being decoded.
	 */
	private handleDpmrLine(line: string, now: Date): DecoderOutput | null {
		if (!DPMR_ID_PRINT.test(line)) return null
		// Two identical prints of consecutive FS2 pairs: one Hamming-correctable
		// word passes on noise too often for a single print to start a call.
		// Both IDs must be printed (a "TG=(CRC ERR)" line never reaches here:
		// handleProtocolLine stops CRC-error lines), and only their values are
		// compared. Even then the IDs stay out of the call (protocol only).
		const ids = DPMR_IDS.exec(line)?.groups
		const print =
			ids !== undefined ? `${ids["tg"] ?? ""}/${ids["src"] ?? ""}` : undefined
		const previous = this.dpmrLastPrint
		this.dpmrLastPrint =
			print !== undefined ? { print, at: now.getTime() } : undefined
		const ongoing = this.callState ?? this.pendingCall?.state ?? null
		if (ongoing?.protocol === "dpmr") {
			ongoing.lastUpdate = now
			return null
		}
		const at = now.getTime()
		if (
			print === undefined ||
			previous === undefined ||
			previous.print !== print ||
			at < previous.at ||
			at - previous.at > DPMR_CONSECUTIVE_MS
		)
			return null
		return this.processCallMetadata(now, "dpmr", 0, 0)
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
		/** The terminator carries link control of its own (TDULC, DMR TLC). */
		let carriesLc = true

		switch (targetCall.protocol) {
			case "dmr": {
				// In BS (repeater) mode only the bracketed slot's terminator
				// counts; a BS terminator that brackets no slot ends no call (its
				// slot is unknown). A direct (MS/DM) terminator ends the call.
				const burstSlot = DMR_CURRENT_SLOT.exec(line)?.groups?.["slot"]
				isTerminator =
					DMR_END_HINT.test(line) &&
					// A train call's own terminators are its train (handleDmrTrainIds).
					!(
						targetCall.train === true &&
						DMR_BURST.exec(line)?.groups?.["burst"] === "TLC"
					) &&
					!(
						line.includes("|") &&
						SYNC_PATTERN.exec(line)?.groups?.["proto"]?.toUpperCase() ===
							"DMR" &&
						dmrBracketlessBs(line)
					) &&
					(burstSlot === undefined ||
						targetCall.slot === undefined ||
						Number(burstSlot) === targetCall.slot)
				break
			}
			case "p25p1":
			case "p25p2":
				// A plain TDU (DUID 3) carries no link control; TDULC does.
				carriesLc = P25_CALL_TERM.test(line)
				isTerminator =
					P25_CALL_TERM.test(line) ||
					(targetCall.protocol === "p25p1" &&
						SYNC_PATTERN.test(line) &&
						P25_TDU.test(line) &&
						!CRC_ERR.test(line) &&
						// Another system's TDU on the channel does not end this call.
						(targetCall.p25?.nac === undefined ||
							this.lastP25Nac === undefined ||
							targetCall.p25.nac === this.lastP25Nac))
				break
			case "ysf":
				// The FICH (TC FN:) is the frame-type check; a failed DCH is payload.
				isTerminator = YSF_TERMINATOR.test(line)
				break
			case "nxdn48":
			case "nxdn96":
				isTerminator =
					SYNC_PATTERN.test(line) &&
					NXDN_RELEASE_LINE.test(line) &&
					!CRC_ERR.test(line)
				break
			default:
				// Other protocols mostly rely on timeout
				break
		}

		// The terminator printed again while its call_end waits for the
		// trailer: the held end stays (closeHeldEnd ends the call).
		if (isTerminator && targetCall.heldEnd !== undefined) return null
		if (
			isTerminator &&
			targetCall.protocol === "dmr" &&
			targetCall.heldEnd === undefined &&
			((targetCall.talkgroup === null && targetCall.source === null) ||
				(targetCall.encryptionKnown === false &&
					!targetCall.flags.encrypted &&
					DMR_BURST.exec(line)?.groups?.["burst"] === "TLC" &&
					SYNC_PATTERN.test(line) &&
					!LINE_ERR.test(line)))
		) {
			// A call-first call the terminator ends before any IDs: its own link
			// control prints right after it and names the call (resolveHeldEnd).
			// A call with IDs that does not know its encryption yet: a clean
			// trailer naming its IDs says it is clear (closeHeldEnd).
			const atMs = now.getTime()
			targetCall.lastUpdate = now
			targetCall.heldEnd = {
				atMs,
				untilMs: atMs + DMR_TRAILER_HOLD_MS,
				lc: false,
				errored: false,
			}
			return null
		}
		if (isTerminator) {
			// If we have a pending call, promote it first so we can end it properly
			if (this.pendingCall && !this.callState) {
				this.callState = this.pendingCall.state
				this.pendingCall = null
			}
			// The trailer ignores the terminator's own link control. A plain P25
			// TDU, YSF and NXDN releases print none (NXDN's IDs line is never
			// read as a VCALL), so the next over may follow at once.
			this.recentlyTerminated =
				!carriesLc ||
				targetCall.protocol === "ysf" ||
				targetCall.protocol === "dstar" ||
				targetCall.protocol === "nxdn48" ||
				targetCall.protocol === "nxdn96"
					? null
					: {
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

		// Call-first: a call that started on its voice frames takes the IDs of
		// the first link control that names them (they attach, no new call).
		const unnamed = this.ongoingCall(protocol)
		if (
			unnamed !== null &&
			unnamed.talkgroup === null &&
			unnamed.source === null &&
			(tgt !== 0 || src !== 0)
		)
			this.bindDmrCall(unnamed, nowMs, { talkgroup: tgt, source: src })

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
			this.markChain(protocol, nowMs)
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
			this.markChain(protocol, nowMs)
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
			// A call ended before its IDs arrived: its terminator's LC names them.
			((trailer.talkgroup === null && trailer.source === null) ||
				(trailer.talkgroup === tgt && trailer.source === src))
		) {
			this.recentlyTerminated = null
			return null
		}

		// Case 3: Different call detected - end previous (at its last line: its
		// terminator was missed), start new pending
		if (this.callState) {
			// On one running chain of syncs the next over began after the
			// old call's last own identity line: the old call ends at that line
			// or the sync before the boundary, the new one is back-dated to the
			// chain's first sync after it (endCall drops the chain).
			const chain = this.liveChain(protocol, nowMs)
			const boundary =
				chain?.markMs !== undefined && chain.afterMarkMs !== undefined
					? chain
					: null
			const lastLine = this.callState.lastUpdate
			const endAt =
				boundary !== null
					? new Date(
							Math.min(
								lastLine.getTime(),
								Math.max(boundary.markMs ?? 0, boundary.beforeMarkMs ?? 0),
							),
						)
					: lastLine
			const endEvent = this.endCall(now, false, endAt)
			if (boundary !== null && boundary.afterMarkMs !== undefined)
				this.chain = {
					protocol: boundary.protocol,
					startMs: boundary.afterMarkMs,
					lastMs: boundary.lastMs,
					clean: boundary.clean,
					tag: boundary.tag,
				}
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
			const discarded = this.pendingCall.state
			this.pendingCall = null
			if (discarded.protocol === "dmr")
				this.dmrClearance.ended(discarded.callId)
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
		tgt: number | null,
		src: number | null,
		slot?: number,
		dmr?: DmrMetadata,
		p25?: P25Metadata,
		nxdn?: NxdnMetadata,
		dstar?: DStarMetadata,
		ysf?: YsfMetadata,
	): DsdFmeCallState {
		const delayMs = this.options.callStartDelayMs ?? CALL_START_DELAY_MS

		this.pendingCall = {
			state: {
				callId: `${this.id}-${nowMs.toString(36)}-${++this.callSeq}`,
				protocol,
				talkgroup: tgt,
				source: src,
				slot,
				// Call-first: the over began at the first sync of its chain.
				startTime: this.chainStart(protocol, nowMs) ?? now,
				startWallMs: this.toWallMs(
					(this.chainStart(protocol, nowMs) ?? now).getTime(),
				),
				lastUpdate: now,
				dmr,
				p25,
				nxdn,
				dstar,
				ysf,
				// A DMR call is not known clear until the clearance machine says.
				...(protocol === "dmr" ? { encryptionKnown: false } : {}),
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

		this.bindDmrCall(this.pendingCall.state, nowMs)

		this.logger.debug(
			{ protocol, tgt, src, slot, delayMs },
			"Pending call created, will emit after delay",
		)
		return this.pendingCall.state
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
			// The late link is admitted on the same rule as the end's own.
			if (!this.recordingLinkable(call)) {
				if (call.protocol === "dmr") this.dmrClearance.ended(call.callId)
				return
			}
			for (const dir of dirsToSearch) {
				const wavFile = this.searchForWavFile(call, callEndTime, dir)
				if (wavFile) {
					// Found it! Emit an event so the UI can update
					this.emitOutput({
						timestamp: this.monoDate(),
						decoder: this.id,
						type: "call_end",
						data: {
							callId: call.callId,
							startedAt: this.startedAtIso(call),
							endedAt: this.wallIso(call, callEndTime),
							// The update carries the call's trust like its first end.
							...this.encryptionKnownField(call),
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
					this.logger.debug({ attempt }, "Found WAV file after async search")
					return
				}
			}

			// Not found in any directory, retry if attempts remain
			if (attempt < maxRetries) {
				setTimeout(tryFind, retryDelayMs)
			} else {
				if (call.protocol === "dmr") this.dmrClearance.ended(call.callId)
				this.logger.debug(
					{
						proto: call.protocol,
						tg: call.talkgroup,
						src: call.source,
						attempts: attempt,
						dirsSearched: dirsToSearch.length,
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
			this.logger.debug("Recording directory does not exist")
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

		// Time window for matching (call start - 5s to call end + 5s), in wall
		// time: the filenames carry wall time.
		const startWallMs = call.startWallMs
		const windowStartMs = startWallMs - 5000
		const windowEndMs =
			startWallMs + (callEndTime.getTime() - call.startTime.getTime()) + 5000

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
					const diff = Math.abs(fileMs - startWallMs)
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
				{ code: (err as NodeJS.ErrnoException).code },
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
	 * Recording admission: whether a call's recording may be linked to it
	 * (and so become playable). Only a call known clear: a DMR call whose
	 * clearance is clear, any other protocol's call that is not encrypted
	 * and whose encryption is not unknown. A future admission check (squelch,
	 * SNR, voice activity) belongs here too, after this privacy rule.
	 * DMR recordings stay unlinked while DMR_RECORDING_LINK_ENABLED is off
	 * (until the DMR clearance gate passes its final review).
	 */
	private recordingLinkable(call: DsdFmeCallState): boolean {
		if (call.protocol === "dmr")
			return (
				DMR_RECORDING_LINK_ENABLED &&
				this.dmrClearance.trust(call.callId) === "clear"
			)
		return !call.flags.encrypted && call.encryptionKnown !== false
	}

	/**
	 * Ends the current call and returns a call_end event.
	 * Generates expected WAV filename if per-call recording is enabled.
	 */
	private endCall(
		now: Date,
		timeout: boolean,
		endAt?: Date,
	): DecoderOutput | null {
		if (!this.callState) return null
		// The lane's next call starts on its own frames.
		this.chain = null
		this.lastVoiceSyncMs = undefined

		// A timeout is detected late: the call really ended at its last line.
		const endTime = endAt ?? (timeout ? this.callState.lastUpdate : now)
		const duration = endTime.getTime() - this.callState.startTime.getTime()
		const callInfo = this.callState

		// Calculate error rate
		const totalErrors = callInfo.quality.crcErrs + callInfo.quality.fecErrs
		const errorRate = this.frameCount > 0 ? totalErrors / this.frameCount : 0
		callInfo.flags.badSignal = errorRate > BAD_SIGNAL_ERROR_RATE

		// Check for false positive suppression
		const minDuration = this.options.minCallDurationMs ?? MIN_CALL_DURATION_MS
		const hasWeakMetadata = this.weakMetadata(callInfo)
		// A call whose call_start went out always gets its call_end.
		const announced = callInfo.announced === true

		if (
			!announced &&
			((duration < minDuration && hasWeakMetadata) ||
				!this.hasEvidence(callInfo))
		) {
			callInfo.flags.falsePositiveSuppressed = true
			this.logger.debug(
				{ protocol: callInfo.protocol, duration },
				"Short call with weak metadata suppressed as likely false positive",
			)
			this.callState = null
			this.frameCount = 0
			if (callInfo.protocol === "dmr") this.dmrClearance.ended(callInfo.callId)
			return null // Don't emit for likely false positives
		}

		// A call that ends before the timer announced it (a terminator, a
		// protocol switch or a timeout of a pending call) still starts first:
		// a call_end never comes without its call_start.
		if (!announced)
			this.emitOutput(this.callStartEvent(callInfo, callInfo.startTime))

		// Only a call known clear is linked to a recording: one that ended
		// before its encryption was known, or known encrypted, never is (its
		// audio is restricted and must never become playable).
		const linkable = this.recordingLinkable(callInfo)
		// Try to find the WAV file immediately
		const wavFile = linkable ? this.findWavFile(callInfo, endTime) : undefined

		// Also trigger async search with retries - dsd-fme may still be writing
		// This will emit an update event if the file is found later
		const awaitingWav = !wavFile && linkable && this.recordingDir() !== null
		if (callInfo.protocol === "dmr")
			this.dmrClearance.ending(callInfo.callId, awaitingWav)
		if (awaitingWav) {
			this.findWavFileAsync(callInfo, endTime)
		}

		// Clear state
		this.callState = null
		this.frameCount = 0
		callInfo.flags.timeout = timeout
		if (
			callInfo.protocol === "dmr" &&
			callInfo.talkgroup !== null &&
			callInfo.source !== null
		)
			this.dmrTrainOf.set(this.laneKey, {
				talkgroup: callInfo.talkgroup,
				source: callInfo.source,
				// Its last line (a timeout is detected late).
				atMs: endTime.getTime(),
				rival:
					callInfo.rival === undefined
						? undefined
						: {
								talkgroup: callInfo.rival.talkgroup,
								source: callInfo.rival.source,
							},
			})

		this.logger.info(
			{
				protocol: callInfo.protocol,
				talkgroup: callInfo.talkgroup,
				source: callInfo.source,
				duration,
				timeout,
				quality: callInfo.quality,
				badSignal: callInfo.flags.badSignal,
				// Presence only: the path is the configured recording dir.
				hasWavFile: wavFile !== undefined,
			},
			"Call ended",
		)

		return {
			timestamp: now,
			decoder: this.id,
			type: "call_end",
			data: {
				callId: callInfo.callId,
				startedAt: this.startedAtIso(callInfo),
				endedAt: this.wallIso(callInfo, endTime),
				...this.encryptionKnownField(callInfo),
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
