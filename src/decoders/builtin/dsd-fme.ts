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
	type DsdFmeRuntimeOptions,
} from "../options/dsd-fme.js"
import type { TxDvPort, TxEndReason } from "../../core/transmissions/types.js"
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
/**
 * P25 privacy prints (phase 1 and 2): a service option privacy bit
 * (p25_lcw.c, p25p2_vpdu.c " Encrypted"), an encrypted header or LDU2
 * (p25p1_hdu.c, p25p1_ldu2.c " ENC"), an encrypted link control (p25_lcw.c
 * " LCW Protected"), the P-bit print ("ENC;"). An ALG ID that is neither
 * 0x80 nor 0x00 counts too (nonDmrPrivacyPrint).
 */
const P25_PRIVACY = /\bEncrypted\b|\bENC\b|\bLCW Protected\b/
/**
 * The one P25 positive clear print: p25p1_ldu2.c prints the ALG and KEY of
 * every LDU2 that decoded (irrecoverable_errors == 0), clear or not; 0x80 is
 * "unencrypted" (TIA-102.AAAD) and a clear call keys 0. Phase 2 prints an
 * ALG only when it is neither 0x80 nor 0x00 (p25p2_xcch.c, p25p2_frame.c):
 * nothing there proves a call clear.
 */
const P25P1_LDU2_CLEAR = /^\s*LDU2 ALG ID: 0x80 KEY ID: 0x0000\b/
/**
 * The same clear print on the LDU2 sync line itself (no newline between the
 * sync and the LDU2's ALG print): checked once the sync handler has handed
 * the superframe's named call to that LDU2 (handleSync, p25Ldu2Credit).
 */
const P25P1_LDU2_SYNC_CLEAR = /\bLDU2\s+ALG ID: 0x80 KEY ID: 0x0000\b/
/**
 * NXDN privacy prints: the cipher type and key printed on the line after a
 * VCALL's IDs whenever the 2-bit cipher type is not 0 (nxdn_element.c
 * NXDN_decode_VCALL / _ARIB: "  Scrambler - Key ID 3 - "), the SCCH form
 * ("- DES - Key ID: 5; "), data call headers ("ENC; Cipher: 2;") and
 * "Encrypted Data".
 */
const NXDN_PRIVACY =
	/\b(?:Scrambler|DES|AES)\s+-\s+Key\s+ID\b|\bENC;|\bEncrypted\b/
/**
 * dPMR privacy: " Scrambler" after the IDs for encryption mode 3
 * (dpmr_voice.c). Modes 1 and 2 print nothing, so no dPMR print proves a
 * call clear.
 */
const DPMR_PRIVACY = /\bScrambler\b|\bEncrypted\b/

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
/** Input level indicator, "inlvl: 40%" (no word boundary after the "%"). */
const INLVL = /\binlvl:\s*(?<inlvl>\d+)%/i

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
 * Voice call state published on the decoder's "voice-call" event when its
 * call_start / call_end is produced, in that line's tick (and when a running
 * call's encryption or identity is learned). A call_end held for its WAV
 * lookup (DSD_FME_WAV_END_WAIT_MS) reaches "output" up to that much later; its
 * state never waits. Times are ISO 8601.
 */
export interface DsdFmeVoiceCallState {
	callId: string
	/** The call's transmission id (`tx_<ULID>`), from its call_start on; absent without one. */
	txId?: string
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
	/**
	 * The call's transmission (claimed with its call_start, on its lane and run): every later
	 * output and voice-call state of the call carries `txId`. Absent without a registry, before
	 * the call_start, or when the claim was refused.
	 */
	txId?: string | undefined
	txClaimant?: number | undefined
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
	 * (dsd-fme-dmr-clearance.ts). P25, NXDN, dPMR and ProVoice calls
	 * (positiveClearProtocol) start false and become known clear only on
	 * their own positive clear print (clearEvidence). Absent (D-STAR, YSF:
	 * no privacy field): known from the start.
	 */
	encryptionKnown?: boolean | undefined
	/**
	 * P25, NXDN, dPMR, ProVoice: a print proved this call itself clear (an
	 * error-free P25 phase 1 LDU2 "ALG ID: 0x80 KEY ID: 0x0000" while it ran,
	 * or a checked NXDN VCALL naming its own IDs with no cipher print after
	 * it). Its recording may be linked only then (recordingLinkable).
	 */
	clearEvidence?: boolean | undefined
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
	 * agreeing copy is the next talker (handleDmrIds). `atMs`: when it
	 * printed (a train's second copy agrees only within DMR_TRAIN_STEP_MS).
	 */
	rival?:
		| { talkgroup: number; source: number; voiceSeq: number; atMs: number }
		| undefined
	/**
	 * DMR: the call started on a terminator's link control (TLC + LC) with
	 * no call of those IDs just ended on the lane: an over whose voice
	 * dsd-fme did not decode, known only from its terminator train
	 * (handleDmrTrainIds). Only link controls of its own IDs keep it
	 * running (its own terminators, other lines and other IDs do not); it
	 * ends at its last own link control: CALL_TIMEOUT_MS after it, on the
	 * next talker, when a direct train breaks (DMR_TRAIN_STEP_MS), or when a
	 * voice or header burst of the lane follows (the next over,
	 * handleDmrSync).
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

/** One terminator link control's IDs, and when it printed (handleDmrTrainIds). */
interface DmrTrainCopy {
	talkgroup: number
	source: number
	atMs: number
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
 * A call's WAV lookup (findWavFileAsync): a first attempt at once, then this many more, one every
 * DSD_FME_WAV_RETRY_MS: 5 × 200 ms = 1 s for dsd-fme to close and rename the file, as before.
 */
export const DSD_FME_WAV_RETRIES = 5
export const DSD_FME_WAV_RETRY_MS = 200
/**
 * Names one directory listing examines at most. dsd-fme writes one file per call (refused ones
 * too, until D7 retires them): at a busy channel's ~1 call per 10 s that is 8 640 files a day, so
 * 20 000 holds about 2.3 days of an unpruned folder. A larger folder is examined that far (its
 * order is the file system's) and logged, never listed whole.
 */
export const DSD_FME_WAV_LIST_MAX_ENTRIES = 20_000
/**
 * How long a call_end waits for its WAV lookup's first attempt (so it carries `wavFile` itself,
 * as when the lookup was synchronous). It is a deadline from the end's production, not a wait per
 * attempt: every output the adapter produces after a held end waits behind it in order (the
 * `outbox`), and an end produced later has a later deadline, so no output is published more than
 * 500 ms after it was produced. A first attempt that misses the deadline still reports a file it
 * finds, in a `wavFileUpdate`.
 */
export const DSD_FME_WAV_END_WAIT_MS = 500
/**
 * A lookup attempt (one listing of each of the three directories) is abandoned after this long,
 * so a stuck directory read cannot stall the one-at-a-time chain of every later call. Node cannot
 * cancel the read itself; its late result is discarded. Single flight: while an abandoned read is
 * still pending, a later attempt starts no listing of its own (it waits for that read, again at
 * most this long, and counts as timed out if it is still stuck), so at most one directory read
 * per adapter occupies the libuv pool however long the file system hangs. When a retry is due
 * (DSD_FME_WAV_RETRY_MS after an attempt that timed out) and that same read is still pending, the
 * lookup waits for it once, at most this long again, outside the one-at-a-time chain: settled
 * (a slow listing, e.g. one that took 2.3 s), the retry is queued and reads; still stuck, the
 * lookup ends (its remaining retries are skipped). On a hung mount each call end then costs the
 * chain one attempt, at most 2 000 ms, and its lookup lasts at most 2 000 + 200 + 2 000 =
 * 4 200 ms after its turn came, holding only a timer meanwhile (no directory read, no chain
 * slot), never a chain of 1 + DSD_FME_WAV_RETRIES attempts (6 × (2 000 + 200) ms = 13.2 s).
 * Worst case for one lookup (every read slow, each settling just inside the wait before it): an
 * attempt can first wait up to 2 000 ms for another attempt's stuck listing, see it settle, then
 * run its own listing for up to 2 000 ms, so each of the 6 attempts holds the chain up to 4 000 ms
 * (24 s); and before each of the 5 retries come the 200 ms retry delay and the wait for the
 * listing still pending, up to 2 000 ms, off the chain (a retry that then queues may meet a
 * different stuck listing, which its attempt waits for again inside its 4 000 ms):
 * 6 × (2 000 + 2 000) + 5 × (200 + 2 000) = 24 + 11 = 35 s.
 */
export const DSD_FME_WAV_ATTEMPT_TIMEOUT_MS = 2_000

/** A WAV listing an attempt abandoned, still pending: the attempts waiting for it to settle. */
interface StuckWavListing {
	/** Each resolves its attempt's wait: true when the listing settled, false when dropped. */
	readonly waiters: Set<(free: boolean) => void>
}

/**
 * Waits at most `ms` for `stuck` to settle: true when it did, false at the timeout or when it was
 * dropped. The waiter leaves the set either way, so a listing that never settles holds none of
 * the attempts that gave up on it.
 */
function waitStuckListing(
	stuck: StuckWavListing,
	ms: number,
): Promise<boolean> {
	return new Promise<boolean>(resolve => {
		const done = (free: boolean): void => {
			clearTimeout(timer)
			stuck.waiters.delete(done)
			resolve(free)
		}
		stuck.waiters.add(done)
		const timer = setTimeout(() => done(false), ms)
	})
}

/** Resolves and removes every waiter of `stuck`. */
function wakeStuckWaiters(stuck: StuckWavListing, free: boolean): void {
	for (const waiter of [...stuck.waiters]) waiter(free)
	stuck.waiters.clear()
}
/**
 * Outputs held behind waiting call_ends at most. They are what the adapter produces within
 * DSD_FME_WAV_END_WAIT_MS: dsd-fme prints a few tens of lines a second per lane and most produce
 * no output, so 500 ms holds well under 100; at 1 024 the oldest waiting end is released early
 * (without its file, which its lookup then reports in an update) rather than grow the queue.
 */
export const DSD_FME_HELD_OUTPUTS_MAX = 1_024
/**
 * Directories whose truncated listing was logged, per adapter (once each). An adapter searches
 * three per recording directory, so 16 names covers five configured directories; past that the
 * set restarts (each directory then logs once more).
 */
const WAV_TRUNCATION_WARNED_MAX = 16

/** A call_end held for its WAV lookup's first attempt (endCall, findWavFileAsync). */
type WavHeldEnd = {
	/** The end's payload, shared by the event endCall returned and its published copy. */
	data: { wavFile?: string | undefined }
	/** Its first attempt finished, its deadline passed, or the queue overflowed. */
	settled: boolean
	/** The end has been published: a file found now goes out in an update. */
	released: boolean
	deadline: ReturnType<typeof setTimeout> | undefined
	/** The end's "Call ended" log, written once it is known whether it carries a file. */
	log: (hasWavFile: boolean) => void
}

/**
 * One output held in order behind a waiting call_end. Only DecoderOutputs wait: voice-call
 * states go out at production (emitOutput).
 */
type HeldOutput = { output: DecoderOutput; end?: WavHeldEnd }

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
 * The longest step between two terminator link controls (TLC + LC) of one
 * continuous train: a terminator burst repeats every 60 ms burst of its
 * slot (a direct radio's terminators back to back, a repeater's train), so
 * the next decoded copy is on air within one superframe of the previous
 * (up to five copies lost in a row, 6 x 60 = 360 ms), and its line arrives
 * up to one line clump later: 360 + 340 = 700 ms. A direct (MS/DM) radio
 * has no repeater hang: past this step its train is over, and the same IDs
 * again are its next over. Two copies of another talker agree only within
 * it (one train), and a held call_end waits this long for a repeated
 * terminator's checked link control (resolveHeldEnd).
 */
export const DMR_TRAIN_STEP_MS = DMR_SUPERFRAME_MS + DSD_FME_LINE_CLUMP_MS

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
/** A DMR idle burst (a repeater slot with no call on it). */
const DMR_IDLE = /\|\s*IDLE(?=\s|$)/
/**
 * Checked idle bursts of a repeater slot in a row (no voice, header or
 * terminator burst of the slot between them) that end its terminator
 * train: two, 2 x 60 ms of the slot carrying no call. One is not enough: a
 * recorded continuous train printed a single idle burst between two of its
 * copies 120 ms apart (a misread slot type).
 */
const DMR_IDLE_TRAIN_END = 2
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
/**
 * Protocols whose calls may have a recording only on a positive clear print
 * of the call itself (clearEvidence): P25 phase 1 and 2, NXDN, dPMR and
 * ProVoice can all carry privacy. Phase 2, dPMR and ProVoice print nothing
 * that proves a call clear, so their calls never have one. D-STAR and YSF
 * carry no privacy field (no cipher bit in the D-STAR header flags or the
 * YSF FICH; their scramblers are data whitening), so they are not here.
 */
export function positiveClearProtocol(protocol: DsdFmeProtocol): boolean {
	return (
		protocol === "p25p1" ||
		protocol === "p25p2" ||
		protocol === "nxdn48" ||
		protocol === "nxdn96" ||
		protocol === "dpmr" ||
		protocol === "provoice"
	)
}

/** A privacy print of a non-DMR protocol (P25_PRIVACY, NXDN_PRIVACY, DPMR_PRIVACY). */
function nonDmrPrivacyPrint(protocol: DsdFmeProtocol, line: string): boolean {
	if (protocol === "p25p1" || protocol === "p25p2") {
		const alg = ALG_ID.exec(line)?.groups?.["alg"]
		if (alg !== undefined && !isClearAlgorithm(alg)) return true
		return P25_PRIVACY.test(line)
	}
	if (protocol === "nxdn48" || protocol === "nxdn96")
		return NXDN_PRIVACY.test(line)
	if (protocol === "dpmr") return DPMR_PRIVACY.test(line)
	return false
}

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
	/** The call's transmission id (DsdFmeCallState.txId). */
	txId?: string
	startedAt?: string
	endedAt?: string
	encrypted?: boolean
	encryptionKnown?: boolean
	/** The call printed its own positive clear (clearEvidenceField). */
	clearEvidence?: true
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

/** DsdFmeDecoder instances made in this process: each one's transmission-run namespace. */
let dsdFmeTxInstances = 0

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
	/**
	 * The last privacy print of a non-DMR protocol (nonDmrPrivacyPrint): a
	 * call of that protocol that starts within the call timeout of it, before
	 * a terminator, a protocol switch or a restart, starts encrypted.
	 */
	private privacyTaint: { protocol: DsdFmeProtocol; atMs: number } | undefined
	/** NXDN: the call a checked VCALL just named; the next line settles it (nonDmrPrivacy). */
	private nxdnVcallClear:
		| { callId: string; talkgroup: number; source: number }
		| undefined
	/**
	 * P25 phase 1 clear credit, per superframe: an LDU1 sync whose NID
	 * decoded waits for its LCW (p25LcwDue); a clean LCW naming a call makes
	 * it the superframe's named call (p25Ldu1Named); the next LDU2 sync hands
	 * that name to its ALG print (p25Ldu2Credit), the only call an LDU2 "ALG
	 * ID: 0x80 KEY ID: 0x0000" may prove clear. Any other P25 phase 1 sync (an
	 * HDU opens the next over, a failed LDU1, a terminator), another
	 * protocol's sync and a restart drop all three, so an over's clear print
	 * never credits a call its own LDU1 did not name.
	 */
	private p25LcwDue = false
	private p25Ldu1Named: string | undefined = undefined
	private p25Ldu2Credit: string | undefined = undefined
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
	/** The tail of the WAV lookups: one attempt in flight at a time (findWavFileAsync). */
	private wavSearch: Promise<void> = Promise.resolve()
	/**
	 * The listing an attempt abandoned at DSD_FME_WAV_ATTEMPT_TIMEOUT_MS while it is still
	 * pending: no attempt starts another until it settles (single flight). One reaction is
	 * attached to it (stuckListing); attempts wait through its waiter set, so a read that never
	 * settles holds at most the one waiting attempt, however many time out behind it. A new run
	 * (start) keeps it: the read still holds a libuv thread, so the new run's attempts wait for
	 * it too and at most one listing per adapter is ever in flight; start only wakes the old
	 * run's waiters, which read nothing.
	 */
	private stuckWavListing: StuckWavListing | null = null
	/**
	 * The run a WAV lookup belongs to, raised by every start that ends the previous run: an old
	 * run's attempt (one woken from the stuck listing, or a retry it scheduled) schedules and runs
	 * no retry in the new run. Only a crash restart (start() without stop()) raises it: after
	 * stop() (`stopping`), as in restart() (stop() then start()), every lookup pending at the stop,
	 * the calls stop() itself ended among them, keeps its retries, since dsd-fme finalises those
	 * files only when its child exits; each chain is bounded (35 s, see DSD_FME_WAV_ATTEMPT_TIMEOUT_MS).
	 */
	private wavRun = 0
	/**
	 * The call_ends endCall returned that wait for their lookup's first attempt (emitOutput), by
	 * payload: a caller's copy of the event shares it.
	 */
	private readonly pendingEnds = new WeakMap<object, WavHeldEnd>()
	/**
	 * Publications in production order behind a waiting call_end (DSD_FME_WAV_END_WAIT_MS): a later
	 * call's events never overtake an earlier call's end. At most DSD_FME_HELD_OUTPUTS_MAX.
	 */
	private readonly outbox: HeldOutput[] = []
	/** Outputs ever queued in, and released from, the outbox (outboxDrained). */
	private outboxQueued = 0
	private outboxReleased = 0
	/** stop() waiting for the outputs queued before it (`upTo` released), oldest first. */
	private readonly outboxWaiters: Array<{ upTo: number; resolve: () => void }> =
		[]
	/**
	 * stop() runs: no call opens after stop() ended every open call, so the child's late lines
	 * are only scanned for a privacy print of a call stop() ended (stopEnded; start() clears it).
	 */
	private stopping = false
	/**
	 * The non-DMR calls stop() ended, with their call_end payloads, until the next start(): a
	 * privacy print the child still prints before it exits marks them encrypted (lateStopPrivacy).
	 * At most one per lane. A DMR call needs none: stop()'s clearance restart already left it
	 * unknown, never clear.
	 */
	private stopEnded: Array<{
		call: DsdFmeCallState
		data: { clearEvidence?: true; wavFile?: string | undefined }
	}> = []
	/** Directories whose truncated listing was logged (WAV_TRUNCATION_WARNED_MAX). */
	private readonly wavTruncationWarned = new Set<string>()
	/** Whether a timed-out lookup attempt was logged (once per adapter). */
	private wavTimeoutWarned = false
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
	 * Per lane, the IDs of its last named DMR call that published and ended,
	 * and when the lane last printed them: a terminator train naming them is
	 * that call's train, not a new call, while it lasts (dmrTrainWindowMs: a
	 * repeater's hang, CALL_TIMEOUT_MS from its last copy; a direct radio's
	 * continuous train, DMR_TRAIN_STEP_MS from its last copy). Other IDs
	 * inside it are the next talker on a clean direct copy, else only on a
	 * second agreeing copy within DMR_TRAIN_STEP_MS (`rival`, which a rival
	 * copy on the call's own voice starts) (handleDmrTrainIds).
	 */
	private dmrTrainOf = new Map<
		number,
		{
			talkgroup: number
			source: number
			atMs: number
			rival: DmrTrainCopy | undefined
		}
	>()
	/**
	 * Per lane, a terminator link control whose sync printed an error, with
	 * no call or train around it: a candidate only. A second agreeing copy
	 * within DMR_TRAIN_STEP_MS starts its train call, back-dated to it
	 * (handleDmrTrainIds).
	 */
	private dmrTrainSeed = new Map<number, DmrTrainCopy>()
	/** Per repeater lane, its checked idle bursts since its last call burst (DMR_IDLE_TRAIN_END). */
	private dmrIdleRun = new Map<number, number>()

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

	/** Transmission identity (DsdFmeRuntimeOptions.transmissions); absent: no txId. */
	private readonly txPort: TxDvPort | undefined
	/**
	 * This decoder's run: start() retires the previous run (its calls closed `decoder-restart`
	 * and any later claim of it refused) and opens the next.
	 */
	private txRunSeq = 0
	/**
	 * This instance's run namespace, unique in the process: a DecoderManager rebuild makes a new
	 * instance with the same id, whose runs must never collide with a run an older one retired.
	 */
	private readonly txInstance = ++dsdFmeTxInstances

	/** The adapter's clocks (DsdFmeClock). */
	private readonly clock: DsdFmeClock
	/** mono() 0 on the epoch scale: the wall time at construction minus mono(). */
	private readonly monoEpochMs: number

	constructor(
		config: DecoderConfig,
		logger: Logger,
		clock: DsdFmeClock = SYSTEM_CLOCK,
		runtime: DsdFmeRuntimeOptions = {},
	) {
		super(config, logger)
		this.txPort = runtime.transmissions
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
		// A crash restart (no stop() before it): before its own ends, so their lookups belong to the
		// new run. After stop() the lookups it left pending keep their retries (wavRun).
		if (!this.stopping) this.wavRun++
		this.endOpenCallsForRestart(this.monoDate())
		this.nextTxRun()
		// An old run's waiting attempt reads nothing; the stuck listing itself stays recorded until
		// it settles, so this run starts no second read beside it (single flight across runs).
		this.wakeOldRunWavWaiters()
		this.stopping = false
		this.stopEnded = []

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
		this.dmrTrainSeed.clear()
		this.dmrIdleRun.clear()
		this.privacyTaint = undefined
		this.nxdnVcallClear = undefined
		this.dropP25Credit()
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
		// From here no line opens a call: the ends below are the last this run produces.
		this.stopping = true
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
		this.stopEnded = []
		this.forEachLane(() => {
			if (this.pendingCall) {
				// Promote pending call to active and end it
				this.callState = this.pendingCall.state
				this.pendingCall = null
			}
			const call = this.callState
			if (call) {
				const endEvent = this.endCall(now, true)
				if (endEvent) {
					if (call.protocol !== "dmr")
						this.stopEnded.push({
							call,
							data: endEvent.data as { clearEvidence?: true; wavFile?: string },
						})
					this.emitOutput(endEvent)
				}
			}
		})
		this.retireTxRun()

		this.flushPendingDmrLink(false)
		this.dmrRoute = newDmrRoute()
		// The ends just produced go out first, each with its file when its lookup found it
		// (at most DSD_FME_WAV_END_WAIT_MS: every queued end was produced by now, and none is
		// produced later since no line is parsed).
		await this.outboxDrained()
		// No end stays held past stop(): one queued after the drain began goes now, without waiting.
		this.releaseHeldEnds()
		// The WAV lookups are deliberately NOT cancelled, here or by the start() of a restart
		// (wavRun): dsd-fme finalises the file of a call this stop() ended when its child exits, inside super.stop(), so only a retry after it
		// finds that file and links it in a `wavFileUpdate` (the recording links follow it). That
		// post-stop update is bounded: each chain is 1 + DSD_FME_WAV_RETRIES attempts, at most
		// 6 × (2 000 + 2 000) + 5 × (200 + 2 000) ms = 24 + 11 = 35 s after its end (the worst case
		// at DSD_FME_WAV_ATTEMPT_TIMEOUT_MS), and
		// a call_end update is all it publishes (a probe pool has stopped listening by then).
		await super.stop()
		this.linkDmrCc.clear()
		this.linkDmrMs = false
	}

	/**
	 * Publishes an output and, for call_start / call_end, the matching
	 * "voice-call" state. The voice-call state always goes out at production,
	 * in the tick the line was parsed: the digital voice stream mutes or holds
	 * the call's voice from it, and that voice is never delayed. Only the
	 * DecoderOutput may wait in the outbox, in order behind a call_end held for
	 * its WAV lookup (Activity and the probe pool see outputs in production
	 * order); an output that is not held goes out first, then its state, as
	 * before the outbox.
	 */
	protected override emitOutput(produced: DecoderOutput): void {
		// Stamped at production: a held output keeps the wall time it was produced at.
		const output = this.outputAtWall(produced)
		const payload = typeof produced.data === "object" ? produced.data : null
		const end = payload === null ? undefined : this.pendingEnds.get(payload)
		if (end !== undefined && payload !== null) this.pendingEnds.delete(payload)
		if (end === undefined && this.outbox.length === 0) {
			this.deliver(output, true)
			return
		}
		this.publishVoiceState(output)
		this.hold({ output, ...(end ? { end } : {}) })
	}

	/** The voice-call state of a call_start / call_end (not of a file update), now. */
	private publishVoiceState(output: DecoderOutput): void {
		if (output.type !== "call_start" && output.type !== "call_end") return
		const data = output.data as CallEventData
		if (data.callId !== undefined && !data.flags?.wavFileUpdate)
			this.publishCallSnapshot(output, data, data.callId)
	}

	/** Queues a publication behind a waiting call_end, then releases what may go. */
	private hold(item: HeldOutput): void {
		this.outbox.push(item)
		this.outboxQueued++
		// Over the bound the oldest waiting end goes now, without a file (DSD_FME_HELD_OUTPUTS_MAX).
		while (this.outbox.length > DSD_FME_HELD_OUTPUTS_MAX) {
			const waiting = this.outbox.find(
				h => h.end !== undefined && !h.end.settled,
			)
			if (waiting?.end === undefined) break
			this.markSettled(waiting.end)
			this.drainOutbox()
		}
		this.drainOutbox()
	}

	/** Publishes the outbox's head while it is not an end still waiting for its lookup. */
	private drainOutbox(): void {
		for (;;) {
			const head = this.outbox[0]
			if (head === undefined) break
			if (head.end !== undefined && !head.end.settled) break
			this.outbox.shift()
			this.outboxReleased++
			if (head.end !== undefined) {
				head.end.released = true
				// Logged as published: a file set after its deadline but before release rides on it.
				head.end.log(head.end.data.wavFile !== undefined)
			}
			// Its voice-call state went out at production (emitOutput).
			this.deliver(head.output, false)
		}
		// Waiters are in `upTo` order (outboxDrained): resolve from the front, no allocation.
		const waiters = this.outboxWaiters
		while (waiters.length > 0 && waiters[0]!.upTo <= this.outboxReleased)
			waiters.shift()!.resolve()
	}

	/**
	 * Settles once every output queued so far was published (at most DSD_FME_WAV_END_WAIT_MS after
	 * the last of them): an output queued later is not waited for.
	 */
	private outboxDrained(): Promise<void> {
		if (this.outbox.length === 0) return Promise.resolve()
		const upTo = this.outboxQueued
		return new Promise(resolve => this.outboxWaiters.push({ upTo, resolve }))
	}

	/** Marks a held end settled (its file known or given up); its log line is written at release. */
	private markSettled(end: WavHeldEnd): void {
		if (end.settled) return
		end.settled = true
		if (end.deadline !== undefined) clearTimeout(end.deadline)
		end.deadline = undefined
	}

	/** Publishes every held output now: a waiting end goes without its file (stop). */
	private releaseHeldEnds(): void {
		for (const held of this.outbox)
			if (held.end !== undefined) this.markSettled(held.end)
		this.drainOutbox()
	}

	/**
	 * The lookup's answer for a held end: a file found before the end went out rides on the end
	 * itself (true); after it, the caller reports it in an update (false).
	 */
	private settleEnd(end: WavHeldEnd, wavFile: string | undefined): boolean {
		if (end.released) return false
		if (wavFile !== undefined) end.data.wavFile = wavFile
		this.markSettled(end)
		this.drainOutbox()
		return wavFile !== undefined
	}

	/**
	 * Publishes one output now (emitOutput, drainOutbox), then its voice-call state when
	 * `withVoiceState` (an output that was never held; a held one's went out at production). A
	 * DMR call_end releases its clearance record only here, after its output: the record is the
	 * trust both halves read.
	 */
	private deliver(output: DecoderOutput, withVoiceState: boolean): void {
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
			if (withVoiceState) this.publishVoiceState(output)
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
			...(data.txId === undefined ? {} : { txId: data.txId }),
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
	 * A P25, NXDN, dPMR or ProVoice call's own positive clear print
	 * (clearEvidence): it becomes known clear, and an announced one publishes
	 * the change on "voice-call", so its voice may play from now on. An
	 * encrypted call stays encrypted. DMR calls learn it only from
	 * applyDmrTrust.
	 */
	private markClear(call: DsdFmeCallState): void {
		if (!positiveClearProtocol(call.protocol) || call.flags.encrypted) return
		if (call.clearEvidence === true) return
		call.clearEvidence = true
		if (call.encryptionKnown !== false) return
		call.encryptionKnown = true
		this.publishCallUpdate(call)
	}

	/**
	 * A line the child printed after stop() began (stopping): a privacy print (any protocol's
	 * "Encrypted", a non-clear ALG ID, or the call's own protocol print) marks every call stop()
	 * ended that is not encrypted yet. Wider than nonDmrPrivacy on purpose: no call is open, so
	 * a print can only belong to one of these, and a false match only keeps a recording unlinked.
	 * An end still held (its WAV lookup's first attempt) goes out encrypted, without its clear
	 * proof or file; the lookup re-checks recordingLinkable before any later link, so none follows.
	 */
	private lateStopPrivacy(line: string): void {
		if (this.stopEnded.length === 0) return
		const alg = ALG_ID.exec(line)?.groups?.["alg"]
		const any =
			DMR_ENCRYPTED.test(line) || (alg !== undefined && !isClearAlgorithm(alg))
		for (const { call, data } of this.stopEnded) {
			if (call.flags.encrypted) continue
			if (!any && !nonDmrPrivacyPrint(call.protocol, line)) continue
			this.markEncrypted(call)
			call.clearEvidence = false
			const held = this.outbox.find(h => h.output.data === data)
			if (held !== undefined) {
				delete data.clearEvidence
				data.wavFile = undefined
			}
		}
	}

	/**
	 * Non-DMR privacy, before the line is parsed: a privacy print of the
	 * current protocol marks its ongoing call encrypted for good and taints
	 * the protocol's context (privacyTaint); an error-free P25 phase 1 LDU2
	 * "ALG ID: 0x80 KEY ID: 0x0000" proves the ongoing P25 phase 1 call
	 * clear; a non-blank line after a checked NXDN VCALL's IDs proves the
	 * call that VCALL named clear unless it is the cipher print. A privacy
	 * print counts even on an errored line (it can only keep a call from
	 * being linked); a clear print never does.
	 */
	private nonDmrPrivacy(line: string, now: Date): void {
		const protocol = this.currentProtocol
		const nowMs = now.getTime()
		const taint = this.privacyTaint
		if (
			taint !== undefined &&
			(taint.protocol !== protocol ||
				nowMs < taint.atMs ||
				nowMs - taint.atMs > this.callTimeoutMs())
		)
			this.privacyTaint = undefined
		if (protocol === null || protocol === "dmr") {
			this.nxdnVcallClear = undefined
			return
		}
		const privacy = nonDmrPrivacyPrint(protocol, line)
		const vcall = this.nxdnVcallClear
		if (vcall !== undefined && line.trim() !== "") {
			this.nxdnVcallClear = undefined
			const call = this.ongoingCall(protocol)
			if (
				!privacy &&
				!LINE_ERR.test(line) &&
				call !== null &&
				call.callId === vcall.callId &&
				call.talkgroup === vcall.talkgroup &&
				call.source === vcall.source
			)
				this.markClear(call)
		}
		if (privacy) {
			const call = this.ongoingCall(protocol)
			if (call !== null) {
				// The update that mutes the call carries the line's ALG / KEY ID.
				if (protocol === "p25p1" || protocol === "p25p2")
					this.noteP25Crypto(call, line)
				this.markEncrypted(call)
			}
			this.privacyTaint = { protocol, atMs: nowMs }
			return
		}
		if (protocol === "p25p1" && P25P1_LDU2_CLEAR.test(line))
			this.creditP25Ldu2Clear(line)
	}

	/**
	 * An LDU2 "ALG ID: 0x80 KEY ID: 0x0000" print, on its own line or on the
	 * LDU2 sync line: proves the ongoing P25 phase 1 call clear only when the
	 * line printed no error and no privacy, and only for the call this
	 * superframe's own LDU1 named (p25Ldu2Credit, used up either way).
	 */
	private creditP25Ldu2Clear(line: string): void {
		if (burstError(line) || nonDmrPrivacyPrint("p25p1", line)) return
		const credit = this.p25Ldu2Credit
		this.p25Ldu2Credit = undefined
		const call = this.ongoingCall("p25p1")
		if (call !== null && credit !== undefined && call.callId === credit)
			this.markClear(call)
	}

	/** Drops the P25 phase 1 superframe naming (see p25Ldu1Named). */
	private dropP25Credit(): void {
		this.p25LcwDue = false
		this.p25Ldu1Named = undefined
		this.p25Ldu2Credit = undefined
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
	 * an identity, or a call-first call the clearance machine proved clear (a
	 * checked link control spoke for it) or whose frames ran long enough
	 * (evidenced). A privacy print (encrypted, PI, ALG / KEY ID) is never
	 * evidence: it decides trust, never whether a call publishes.
	 */
	private hasEvidence(call: DsdFmeCallState): boolean {
		return (
			call.onFrames !== true ||
			!this.weakMetadata(call) ||
			(call.encryptionKnown === true && !call.flags.encrypted) ||
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
			const syncErrored =
				burstError(line) || /Frame Sync Err\b|SYNC LOST|no sync/i.test(line)
			// The terminator printed again (its lane's) before a checked
			// trailer does not close the call: the call_end stays held
			// (handleTermination), and this copy is a burst of its own whose
			// link control may still name it (an errored trailer before it
			// spoke for its own burst only). After the trailer it is the next
			// burst of the train: the trailer's burst closed, and that burst's
			// own lines are not the trailer's.
			if (DMR_BURST.exec(line)?.groups?.["burst"] === "TLC" && !held.lc) {
				held.errored = syncErrored
				held.untilMs = Math.max(
					held.untilMs,
					now.getTime() + DMR_TRAILER_HOLD_MS,
				)
				return false
			}
			if (syncErrored) held.errored = true
			const ended = this.closeHeldEnd(now)
			if (ended) this.emitOutput(ended)
			return false
		}
		// A CACH short LC or a -Z payload print is not the terminator's burst.
		if (burstNeutral(line)) return false
		const ids =
			DMR_VOICE_EVENT.exec(line)?.groups ?? DMR_TGT_SRC.exec(line)?.groups
		const errored = burstError(line)
		if (errored) {
			held.errored = true
			// An unchecked trailer: the terminator's next copy (one train)
			// may still carry it checked.
			if (!held.lc)
				held.untilMs = Math.max(held.untilMs, now.getTime() + DMR_TRAIN_STEP_MS)
		}
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
		// The terminator's link control (printed again) is not a new call:
		// the train of a call that published. One suppressed (unnamed, no
		// evidence) left nothing for its train to belong to: its next checked
		// copy starts the over's call (handleDmrTrainIds).
		this.recentlyTerminated =
			ended === null
				? null
				: {
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
			...(call.txId === undefined ? {} : { txId: call.txId }),
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
		// Now, never behind a held call_end: the voice stream mutes or plays from it (emitOutput).
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
		this.claimCallTx(call)
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
				...(call.txId === undefined ? {} : { txId: call.txId }),
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
		// stop() ended every call: a line printed while the child exits opens none (stopping),
		// but its privacy print still marks the call stop() ended (fail closed).
		if (this.stopping) {
			this.lateStopPrivacy(line.replace(ANSI_ESCAPE, ""))
			return null
		}
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
		// STEP 3-: Non-DMR privacy and positive clear prints of the ongoing call.
		this.nonDmrPrivacy(cleanLine, now)
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
		// Deliberately not through the outbox (emitOutput): a link line is decode evidence, not a
		// call lifecycle publication, and carries its own `at`. Its consumers (probe confirmation,
		// identify) pair lines live, and none orders them against call_start/call_end, so holding
		// them behind a call_end waiting for its file (up to DSD_FME_WAV_END_WAIT_MS) would only
		// delay identification.
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

	/**
	 * The stored proof of a P25, NXDN, dPMR or ProVoice call's own positive
	 * clear print, for its call_end and late file update: `clearEvidence:
	 * true` only while that print held (markClear) and no privacy print
	 * followed. Its Activity row is admitted on it (callTrustAdmits), so a
	 * row an older rule wrote with `encryptionKnown: true` alone is not.
	 */
	private clearEvidenceField(call: DsdFmeCallState): { clearEvidence?: true } {
		return positiveClearProtocol(call.protocol) &&
			call.clearEvidence === true &&
			!call.flags.encrypted
			? { clearEvidence: true }
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

		// An LDU2 whose ALG print shares its sync line: nonDmrPrivacy ran
		// before trackSyncState handed this LDU2 its superframe's named call.
		if (
			newProtocol === "p25p1" &&
			this.p25Ldu2Credit !== undefined &&
			P25P1_LDU2_SYNC_CLEAR.test(line)
		)
			this.creditP25Ldu2Clear(line)

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
			const duid = /\bduid:EE\b/.test(line)
				? undefined
				: P25_VOICE_FRAME.exec(line)?.groups?.["duid"]
			const named = this.p25Ldu1Named
			this.dropP25Credit()
			if (duid === "LDU2") this.p25Ldu2Credit = named
			else if (duid === "LDU1" && !burstError(line)) this.p25LcwDue = true
		} else {
			this.lastP25Nac = undefined
			this.dropP25Credit()
		}
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
			// A train call runs on its own link controls only (handleDmrTrainIds).
			(ongoing.train === true ||
				(!DMR_BURST.test(line) && !DMR_SLOT_WORD.test(line)))
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
		// A DMR or P25 call starts not known clear (startPendingCall).
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
		// A repeater slot's checked idle bursts (DMR_IDLE_TRAIN_END in a row):
		// the slot carries no call, so the terminator train of its last call
		// is over (handleDmrTrainIds).
		if (
			!this.linkDmrMs &&
			this.dmrBs &&
			DMR_IDLE.test(line) &&
			!LINE_ERR.test(line)
		) {
			const run = (this.dmrIdleRun.get(this.laneKey) ?? 0) + 1
			this.dmrIdleRun.set(this.laneKey, run)
			return run === DMR_IDLE_TRAIN_END ? this.endDmrTrain(now) : null
		}
		const burst = DMR_BURST.exec(line)?.groups?.["burst"]
		const header = dmrHeaderLine(line, burst)
		if (burst === undefined && !header) return null
		this.dmrIdleRun.delete(this.laneKey)
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
		// A train call runs on its own link controls only (handleDmrTrainIds).
		if (ongoing.train === true) return null
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
					atMs: now.getTime(),
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
	 * clear a running voice call. A checked, plausible one of this burst's
	 * slot:
	 *
	 * - names the call that just ended on the lane while its train lasts
	 *   (dmrTrainOf, dmrTrainWindowMs): no new call;
	 * - refreshes a running train call of the same IDs (a direct one only
	 *   while its train is continuous, DMR_TRAIN_STEP_MS; past it the call
	 *   ends at its last copy and this copy is the next over);
	 * - against such a train or train call of other IDs, is the next talker:
	 *   at once on a direct radio's clean sync (no repeater train is on the
	 *   channel to garble it), else on a second agreeing copy within
	 *   DMR_TRAIN_STEP_MS (a false link control of a train is one copy), the
	 *   call back-dated to its first copy;
	 * - with no call or train on the lane, starts one (a train call) when
	 *   its terminator sync is clean, else on a second agreeing copy
	 *   (dmrTrainSeed): an over whose voice was not decoded is still a call
	 *   (its metadata always publishes; the clearance machine never clears
	 *   it, voiceless).
	 *
	 * A train call ends at its own last link control (processCallMetadata,
	 * endCall): the next talker's copies never extend it.
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
		const direct = this.linkDmrMs
		const cleanSync = this.laneSync?.clean === true
		const same = (copy: { talkgroup: number | null; source: number | null }) =>
			copy.talkgroup === tgt && copy.source === src
		// Another talker's copy: whether it starts that talker's call now,
		// else whether it agrees with the rival copy before it (one train).
		const agrees = (rival: DmrTrainCopy | undefined) =>
			rival !== undefined &&
			same(rival) &&
			nowMs >= rival.atMs &&
			nowMs - rival.atMs <= DMR_TRAIN_STEP_MS
		let ongoing = this.ongoingCall("dmr")
		// A named call whose end waits for its terminator's trailer, and this
		// trailer names another talker (resolveHeldEnd marked the burst not
		// clean): the call ends at its terminator, and this is the next over.
		if (
			ongoing?.heldEnd !== undefined &&
			ongoing.talkgroup !== null &&
			!same(ongoing)
		) {
			const ended = this.closeHeldEnd(now)
			if (ended) this.emitOutput(ended)
			ongoing = this.ongoingCall("dmr")
		}
		/** When the call this copy starts began: its first agreeing copy. */
		let fromMs = nowMs
		/** Another talker's copy against a train call: it starts that talker's call. */
		let next = false
		if (ongoing !== null) {
			if (ongoing.train !== true || ongoing.talkgroup === null) {
				this.rejectDmrIds("not after voice")
				return null
			}
			const last = ongoing.lastUpdate.getTime()
			if (same(ongoing) && !(direct && nowMs - last > DMR_TRAIN_STEP_MS)) {
				ongoing.rival = undefined
				ongoing.lastUpdate = now
				if (encrypted) this.markDmrEncrypted(matchSlot)
				return null
			}
			if (!same(ongoing) && !(direct && cleanSync)) {
				const rival = ongoing.rival
				if (!agrees(rival)) {
					ongoing.rival = {
						talkgroup: tgt,
						source: src,
						voiceSeq: this.voiceSeq,
						atMs: nowMs,
					}
					this.rejectDmrIds("single copy")
					return null
				}
				fromMs = rival?.atMs ?? nowMs
			}
			next = !same(ongoing)
			// The train call ends at its own last link control; this copy is
			// the next talker, or (a direct train that broke) a copy with no
			// call on the lane.
			const ended = this.endOngoingCall(now, false, ongoing.lastUpdate)
			if (ended) this.emitOutput(ended)
		}
		if (!next) {
			// The terminator's own link control right after it (the trailer
			// window, processCallMetadata's rule) of a call that published:
			// its call's train, no new call.
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
			const seed = this.dmrTrainSeed.get(this.laneKey)
			if (
				last !== undefined &&
				nowMs >= last.atMs &&
				nowMs - last.atMs <= this.dmrTrainWindowMs()
			) {
				if (same(last)) {
					last.atMs = nowMs
					last.rival = undefined
					this.rejectDmrIds("train")
					return null
				}
				if (!(direct && cleanSync)) {
					if (!agrees(last.rival)) {
						last.rival = { talkgroup: tgt, source: src, atMs: nowMs }
						this.rejectDmrIds("single copy")
						return null
					}
					fromMs = last.rival?.atMs ?? nowMs
				}
			} else if (agrees(seed)) fromMs = seed?.atMs ?? nowMs
			else if (!cleanSync) {
				// No call or train here: a copy on an errored sync is a
				// candidate only, a second agreeing copy confirms it.
				this.dmrTrainSeed.set(this.laneKey, {
					talkgroup: tgt,
					source: src,
					atMs: nowMs,
				})
				this.rejectDmrIds("unclean sync")
				return null
			}
		}
		this.dmrTrainOf.delete(this.laneKey)
		this.dmrTrainSeed.delete(this.laneKey)
		this.recentlyTerminated = null
		const before = this.ongoingCall("dmr")
		const event = this.processCallMetadata(now, "dmr", tgt, src, slot, dmrMeta)
		const call = this.ongoingCall("dmr")
		if (call !== null && call !== before) {
			call.train = true
			call.voiceAtMs = undefined
			// Back-dated to its first agreeing copy.
			if (fromMs < call.startTime.getTime()) {
				call.startTime = new Date(fromMs)
				call.startWallMs = this.toWallMs(fromMs)
			}
			this.dmrClearance.voiceless(call.callId)
		}
		if (encrypted) this.markDmrEncrypted(matchSlot)
		return event
	}

	/**
	 * The lane's terminator train is over (a repeater slot went idle): the
	 * same IDs again are the next over. A running train call ends at its
	 * last own link control; a voice call is left to its own end.
	 */
	private endDmrTrain(now: Date): DecoderOutput | null {
		const ongoing = this.ongoingCall("dmr")
		const ended =
			ongoing?.train === true && ongoing.heldEnd === undefined
				? this.endOngoingCall(now, false, ongoing.lastUpdate)
				: null
		// After the call's end (endCall notes its train).
		this.dmrTrainOf.delete(this.laneKey)
		this.dmrTrainSeed.delete(this.laneKey)
		return ended
	}

	/**
	 * How long after a just-ended call's last copy its terminator train may
	 * still name it (dmrTrainOf): a repeater's hang train, CALL_TIMEOUT_MS
	 * (its call timeout); a direct radio has no hang, its train is
	 * continuous: DMR_TRAIN_STEP_MS.
	 */
	private dmrTrainWindowMs(): number {
		return this.linkDmrMs ? DMR_TRAIN_STEP_MS : this.callTimeoutMs()
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
		const call = this.callState ?? this.pendingCall?.state ?? null
		if (!call || call.protocol !== protocol) return
		const alg = this.noteP25Crypto(call, line)
		// A clear ALG is no proof here (nonDmrPrivacy: an LDU2 0x80 KEY 0 is).
		if (alg !== undefined && !isClearAlgorithm(alg)) this.markEncrypted(call)
	}

	/** Keeps a P25 crypto line's ALG and KEY ID on `call`; returns the ALG. */
	private noteP25Crypto(
		call: DsdFmeCallState,
		line: string,
	): string | undefined {
		const cryptoMatch = P25_CRYPTO.exec(line)
		if (!cryptoMatch) return undefined
		const alg = ALG_ID.exec(line)?.groups?.["alg"]
		const keyId = cryptoMatch.groups?.["key"]
		if (alg !== undefined) call.p25 = { ...call.p25, alg }
		if (keyId !== undefined) call.p25 = { ...call.p25, keyId }
		return alg
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
				// LCW service option bit 0x40 prints " Encrypted" (nonDmrPrivacy
				// marked the old call; this marks the call the line named). Its
				// absence proves nothing: only an LDU2 ALG 0x80 does (markClear).
				const call = this.ongoingCall("p25p1")
				if (DMR_ENCRYPTED.test(line) && call !== null) this.markEncrypted(call)
				// A clean LCW of an LDU1 names the superframe's call: its LDU2's
				// clear print may credit that call, and no other (p25Ldu1Named).
				if (this.p25LcwDue) {
					this.p25LcwDue = false
					if (call !== null && !burstError(line))
						this.p25Ldu1Named = call.callId
				}
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
			const event = this.processCallMetadata(
				now,
				protocol,
				tgt,
				src,
				undefined,
				undefined,
				undefined,
				nxdnMeta,
			)
			// The call this checked VCALL names: proven clear by the next line
			// unless that is its cipher print (nonDmrPrivacy).
			const named = this.ongoingCall(protocol)
			this.nxdnVcallClear =
				named !== null && named.talkgroup === tgt && named.source === src
					? { callId: named.callId, talkgroup: tgt, source: src }
					: undefined
			return event
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
			// The over is over: its privacy prints taint no later call.
			if (targetCall.protocol !== "dmr") this.privacyTaint = undefined
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
				// A DMR call is not known clear until the clearance machine says;
				// a P25, NXDN, dPMR or ProVoice call until its own clear print.
				...(protocol === "dmr" || positiveClearProtocol(protocol)
					? { encryptionKnown: false }
					: {}),
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
		// A privacy print of this protocol shortly before, in the same context
		// (privacyTaint), may be this call's own: it starts encrypted.
		const taint = this.privacyTaint
		if (
			positiveClearProtocol(protocol) &&
			taint !== undefined &&
			taint.protocol === protocol &&
			nowMs >= taint.atMs &&
			nowMs - taint.atMs <= this.callTimeoutMs()
		)
			this.markEncrypted(this.pendingCall.state)

		this.logger.debug(
			{ protocol, tgt, src, slot, delayMs },
			"Pending call created, will emit after delay",
		)
		return this.pendingCall.state
	}

	/**
	 * The single-flight record of an abandoned search: its one reaction wakes the waiting
	 * attempts (free) and clears the record once the search settles.
	 */
	private stuckListing(searched: Promise<unknown>): StuckWavListing {
		const stuck: StuckWavListing = { waiters: new Set() }
		void searched.finally(() => {
			if (this.stuckWavListing === stuck) this.stuckWavListing = null
			wakeStuckWaiters(stuck, true)
		})
		return stuck
	}

	/**
	 * A new run's start: the attempts waiting on the stuck listing give up and read nothing. The
	 * record stays (its read still occupies a libuv thread) and clears itself when it settles.
	 */
	private wakeOldRunWavWaiters(): void {
		const stuck = this.stuckWavListing
		if (stuck !== null) wakeStuckWaiters(stuck, false)
	}

	/**
	 * Finds the WAV file dsd-fme created for a completed call, off the event loop. A file found
	 * while the call's end is still held (`end`, DSD_FME_WAV_END_WAIT_MS) rides on that
	 * `call_end` itself, as when the lookup was synchronous; one found after it went out is
	 * emitted in a `call_end` update (`flags.wavFileUpdate`).
	 *
	 * dsd-fme filename format: YYYYMMDD_HHMMSS_XXXXX_PROTO_CC_N_CALLTYPE_TGT_N_SRC_N.wav
	 * Where XXXXX is an internal frame ID we cannot predict.
	 *
	 * Strategy:
	 * 1. Build a regex pattern from known call metadata (proto, CC, TGT, SRC)
	 * 2. Search in the recording directory AND common subdirectories (dsd-fme creates WAV/)
	 * 3. Filter files matching the pattern with timestamps within call window (±5 s tolerance)
	 * 4. Take the best match (the timestamp closest to the call's start)
	 *
	 * The first attempt runs at once, then up to DSD_FME_WAV_RETRIES more every
	 * DSD_FME_WAV_RETRY_MS (dsd-fme renames the file at the call's close, so it may still be
	 * writing). Every attempt is one async, bounded listing per directory
	 * (searchForWavFile), abandoned after DSD_FME_WAV_ATTEMPT_TIMEOUT_MS, and attempts of every
	 * call run one at a time (`wavSearch`): a burst of call ends never stacks directory reads.
	 */
	private findWavFileAsync(
		call: DsdFmeCallState,
		callEndTime: Date,
		end?: WavHeldEnd,
	): void {
		const baseDir = this.recordingDir()
		if (baseDir === null) {
			if (end !== undefined) this.settleEnd(end, undefined)
			return
		}

		// dsd-fme creates a WAV subdirectory inside the output directory
		const dirsToSearch = [
			baseDir,
			path.join(baseDir, "WAV"),
			path.join(baseDir, "wav"),
		]
		const searchAll = async (): Promise<string | undefined> => {
			for (const dir of dirsToSearch) {
				const found = await this.searchForWavFile(call, callEndTime, dir)
				if (found) return found
			}
			return undefined
		}

		let attempt = 0
		const run = this.wavRun
		// The stuck listing the previous attempt timed out on, or null when it read to the end.
		let blocked: StuckWavListing | null = null
		const tryFind = async (): Promise<void> => {
			// A retry ends the lookup unread when the listing its previous attempt timed out on is
			// still the one stuck (`retry` already waited for it once; queued again behind the
			// chain, it would only wait on it again), or when a new run started since the lookup
			// began. A listing that settled before the retry ran (merely slow) is no reason: the
			// retry reads. The run check also ends, after its first attempt, a lookup whose first
			// attempt was only queued when start() began the new run: an old run's call retries
			// nothing in the new one.
			if (attempt > 0) {
				const stillStuck = blocked !== null && this.stuckWavListing === blocked
				if (stillStuck || run !== this.wavRun) {
					endEarly(stillStuck)
					return
				}
			}
			attempt++

			// Single flight: a listing an earlier attempt abandoned is waited for (at most
			// DSD_FME_WAV_ATTEMPT_TIMEOUT_MS) before this one reads; still stuck, this attempt reads
			// nothing. Freed, the search gets its own full DSD_FME_WAV_ATTEMPT_TIMEOUT_MS.
			const stuck = this.stuckWavListing
			const freed =
				stuck === null ||
				(await waitStuckListing(stuck, DSD_FME_WAV_ATTEMPT_TIMEOUT_MS))
			let result: string | undefined | "timeout" = "timeout"
			if (freed) {
				// An abandoned search never rejects unhandled (searchForWavFile catches its own reads).
				const searched = searchAll().catch(() => undefined)
				let timer: ReturnType<typeof setTimeout> | undefined
				const timedOut = new Promise<"timeout">(resolve => {
					timer = setTimeout(
						() => resolve("timeout"),
						DSD_FME_WAV_ATTEMPT_TIMEOUT_MS,
					)
				})
				result = await Promise.race([searched, timedOut])
				clearTimeout(timer)
				if (result === "timeout")
					this.stuckWavListing = this.stuckListing(searched)
			}
			// The stuck listing this attempt timed out on (its own abandoned read, or the one it
			// waited for), or null when it read to the end.
			blocked =
				result !== "timeout" ? null : freed ? this.stuckWavListing : stuck
			if (result === "timeout" && !this.wavTimeoutWarned) {
				this.wavTimeoutWarned = true
				this.logger.warn(
					{ timeoutMs: DSD_FME_WAV_ATTEMPT_TIMEOUT_MS },
					"WAV file search attempt timed out",
				)
			}
			const wavFile = result === "timeout" ? undefined : result
			// The late link is admitted on the same rule as the end's own, decided after the
			// reads (the call's trust may have changed while they ran).
			if (!this.recordingLinkable(call)) {
				if (end !== undefined) this.settleEnd(end, undefined)
				if (call.protocol === "dmr") this.dmrClearance.ended(call.callId)
				return
			}
			if (wavFile) {
				if (end !== undefined && this.settleEnd(end, wavFile)) {
					// The held end carries it: the lookup is done.
					if (call.protocol === "dmr") this.dmrClearance.ended(call.callId)
					this.logger.debug({ attempt }, "Found WAV file for the call's end")
					return
				}
				// Its end has gone out: an update links it.
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
						...this.clearEvidenceField(call),
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
			// Not found by the first attempt: the end goes out without it.
			if (end !== undefined) this.settleEnd(end, undefined)

			// Not found in any directory, retry if attempts remain (the retry itself ends the lookup
			// if this attempt's stuck listing is still stuck then), unless a new run started
			// meanwhile (an old run's attempt schedules no retry in it).
			if (run !== this.wavRun) {
				endEarly(false)
			} else if (attempt <= DSD_FME_WAV_RETRIES) {
				setTimeout(retry, DSD_FME_WAV_RETRY_MS)
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
		/** The lookup ends here, its remaining retries skipped (`stuck`: on a stuck listing). */
		const endEarly = (stuck: boolean): void => {
			if (call.protocol === "dmr") this.dmrClearance.ended(call.callId)
			this.logger.debug(
				{ attempts: attempt, stuck },
				"WAV file lookup ended early, retries skipped",
			)
		}
		// A retry that is due: when the listing the last attempt timed out on is still stuck, wait
		// for it once (at most DSD_FME_WAV_ATTEMPT_TIMEOUT_MS, outside the chain) and queue the
		// retry only if it settled; otherwise queue it now.
		const retry = (): void => {
			const waitFor = blocked
			if (waitFor === null || this.stuckWavListing !== waitFor) {
				queue()
				return
			}
			void waitStuckListing(waitFor, DSD_FME_WAV_ATTEMPT_TIMEOUT_MS).then(
				settled => {
					if (settled) queue()
					else endEarly(true)
				},
			)
		}
		// One attempt in flight per adapter; a failed one never stops the next.
		const queue = (): void => {
			const run = this.wavSearch.then(tryFind)
			this.wavSearch = run.catch((err: unknown) => {
				if (end !== undefined) this.settleEnd(end, undefined)
				if (call.protocol === "dmr") this.dmrClearance.ended(call.callId)
				this.logger.warn(
					{ code: (err as NodeJS.ErrnoException | null)?.code },
					"WAV file search failed",
				)
			})
		}
		queue()
	}

	/**
	 * Core WAV file search: one async listing of `dir` (opendir, never the whole directory in
	 * memory and never a sync read), at most DSD_FME_WAV_LIST_MAX_ENTRIES names examined.
	 */
	private async searchForWavFile(
		call: DsdFmeCallState,
		callEndTime: Date,
		dir: string,
	): Promise<string | undefined> {
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

		let directory: fs.Dir
		try {
			directory = await fs.promises.opendir(dir)
		} catch (err) {
			// A directory that does not exist (yet) is no match.
			if ((err as NodeJS.ErrnoException).code !== "ENOENT")
				this.logger.warn(
					{ code: (err as NodeJS.ErrnoException).code },
					"Error searching for WAV file",
				)
			return undefined
		}
		let best: { file: string; timestamp: Date; diff: number } | undefined
		let candidates = 0
		let examined = 0
		try {
			// Breaking out of the loop closes the directory.
			for await (const entry of directory) {
				if (++examined > DSD_FME_WAV_LIST_MAX_ENTRIES) {
					// Once per directory per adapter (WAV_TRUNCATION_WARNED_MAX); never the path.
					if (!this.wavTruncationWarned.has(dir)) {
						if (this.wavTruncationWarned.size >= WAV_TRUNCATION_WARNED_MAX)
							this.wavTruncationWarned.clear()
						this.wavTruncationWarned.add(dir)
						this.logger.warn(
							{ limit: DSD_FME_WAV_LIST_MAX_ENTRIES },
							"Recording directory listing truncated",
						)
					}
					break
				}
				const file = entry.name
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
					// How close this file's timestamp is to call start; the first of equals stays
					const diff = Math.abs(fileMs - startWallMs)
					candidates++
					if (best === undefined || diff < best.diff)
						best = { file, timestamp: fileTimestamp, diff }
				}
			}
		} catch (err) {
			this.logger.warn(
				{ code: (err as NodeJS.ErrnoException).code },
				"Error searching for WAV file",
			)
			return undefined
		}
		if (best === undefined) return undefined
		this.logger.debug(
			{
				file: best.file,
				callStart: call.startTime.toISOString(),
				fileTimestamp: best.timestamp.toISOString(),
				diffMs: best.diff,
				candidates,
			},
			"Found matching WAV file for call",
		)
		return path.join(dir, best.file)
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
	 * clearance is clear; a P25, NXDN, dPMR or ProVoice call only on its own
	 * positive clear print (clearEvidence) and no privacy print (P25 phase
	 * 2, dPMR and ProVoice print none, so never); a D-STAR or YSF call (no
	 * privacy field) unless a privacy print. A future admission check (squelch,
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
		if (positiveClearProtocol(call.protocol))
			return call.clearEvidence === true && !call.flags.encrypted
		return !call.flags.encrypted && call.encryptionKnown !== false
	}

	/** This run's id in the transmission registry. */
	private txRun(): string {
		return `${this.id}#${this.txInstance}.${this.txRunSeq}`
	}

	/** Closes this run's transmissions (`decoder-restart`) and refuses its later claims. */
	private retireTxRun(): void {
		try {
			this.txPort?.retireRun(this.txRun(), this.clock.wall())
		} catch {
			// The registry never blocks the decoder.
		}
	}

	/** start(): the previous run is retired, the next one claims from here. */
	private nextTxRun(): void {
		this.retireTxRun()
		this.txRunSeq++
	}

	/**
	 * A call's transmission, claimed once when its call_start is made (the promotion that
	 * publishes; a pending call that never publishes mints none), keyed by this decoder, the
	 * call's TDMA lane (a repeater slot, else 0) and the run. A refused claim leaves no id.
	 */
	private claimCallTx(call: DsdFmeCallState): void {
		const port = this.txPort
		if (port === undefined || call.txId !== undefined) return
		const lane = this.laneKey === 1 || this.laneKey === 2 ? this.laneKey : 0
		try {
			const res = port.claim({
				origin: "dv-call",
				kind: "voice-digital",
				sourceId: this.config.sourceId ?? null,
				dvKey: `dv:${this.id}`,
				lane,
				run: this.txRun(),
				atMs: call.startWallMs,
				alias: `call:${this.id}:${call.callId}`,
			})
			if (res === null) return
			call.txId = res.txId
			call.txClaimant = res.claimant
			port.noteIdentity(res.claimant, this.txIdentityOf(call))
		} catch {
			// The registry never blocks the decoder: the call goes out without an id.
		}
	}

	/**
	 * The call's transmission ends with its call_end: its identity and encryption are noted
	 * first; a restart's end closes `decoder-restart`, stop()'s an operator stop.
	 */
	private endCallTx(call: DsdFmeCallState, endTime: Date): void {
		const port = this.txPort
		const claimant = call.txClaimant
		if (port === undefined || claimant === undefined) return
		call.txClaimant = undefined
		const reason: TxEndReason =
			call.flags.restart === true
				? "decoder-restart"
				: this.stopping
					? "stopped"
					: "ended"
		try {
			port.noteIdentity(claimant, this.txIdentityOf(call))
			if (call.flags.encrypted && call.txId !== undefined)
				port.noteRefusal(call.txId, "encrypted")
			port.end(
				claimant,
				call.startWallMs + (endTime.getTime() - call.startTime.getTime()),
				reason,
			)
		} catch {
			// The registry never blocks the decoder.
		}
	}

	private txIdentityOf(call: DsdFmeCallState): {
		protocol: string | null
		talkgroup: string | null
		source: string | null
	} {
		return {
			protocol: call.protocol,
			talkgroup: call.talkgroup === null ? null : String(call.talkgroup),
			source: call.source === null ? null : String(call.source),
		}
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
		// The file is looked up off the event loop (findWavFileAsync). This end is held (emitOutput,
		// at most DSD_FME_WAV_END_WAIT_MS) for the lookup's first attempt and carries the file it
		// finds; retries while dsd-fme may still be writing report it in a `wavFileUpdate`.
		const awaitingWav = linkable && this.recordingDir() !== null
		if (callInfo.protocol === "dmr")
			this.dmrClearance.ending(callInfo.callId, awaitingWav)
		const logEnd = (hasWavFile: boolean): void => {
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
					hasWavFile,
				},
				"Call ended",
			)
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
								atMs: callInfo.rival.atMs,
							},
			})

		this.endCallTx(callInfo, endTime)
		const data = {
			callId: callInfo.callId,
			...(callInfo.txId === undefined ? {} : { txId: callInfo.txId }),
			startedAt: this.startedAtIso(callInfo),
			endedAt: this.wallIso(callInfo, endTime),
			...this.encryptionKnownField(callInfo),
			...this.clearEvidenceField(callInfo),
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
			// Filled by the lookup's first attempt while the end is held (findWavFileAsync).
			wavFile: undefined as string | undefined,
		}
		if (awaitingWav) {
			const end: WavHeldEnd = {
				data,
				settled: false,
				released: false,
				deadline: undefined,
				log: logEnd,
			}
			end.deadline = setTimeout(() => {
				end.deadline = undefined
				this.settleEnd(end, undefined)
			}, DSD_FME_WAV_END_WAIT_MS)
			this.pendingEnds.set(data, end)
			this.findWavFileAsync(callInfo, endTime, end)
		} else logEnd(false)
		return { timestamp: now, decoder: this.id, type: "call_end", data }
	}
}

/**
 * Factory function for creating DSD-FME decoder instances.
 * Used by the DecoderRegistry.
 */
export function createDsdFmeDecoder(
	config: DecoderConfig,
	logger: Logger,
	runtime: DsdFmeRuntimeOptions = {},
): DsdFmeDecoder {
	return new DsdFmeDecoder(config, logger, SYSTEM_CLOCK, runtime)
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
