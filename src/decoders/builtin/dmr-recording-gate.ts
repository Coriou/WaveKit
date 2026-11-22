/**
 * The DMR recording gate: which calls may have a recording (written, listed, served or linked to
 * their Activity row). Dependency-free, so the Activity writer worker can use it; re-exported by
 * call-recordings.ts.
 */

/**
 * Whether a DMR call's recording may be written, kept or linked to its Activity row. Off until
 * the DMR clearance gate passes its final review: no DMR recording is linked or playable, and
 * the digital-voice call recorder writes no DMR audio. Re-enabling is this one line.
 */
export const DMR_RECORDING_LINK_ENABLED = false

/**
 * Protocol labels (lower case, without `-`, `_` or spaces) whose calls may have a recording:
 * the labels the digital-voice service and dsd-fme produce for a protocol that is not DMR
 * (dsd-fme.ts DsdFmeProtocol and dsd-fme-link.ts, and the system prefix dsd-fme writes into its
 * per-call file names, dsd_events.c in the pinned build: P25_, NXDN_, YSF, DSTAR, DPMR_, M17_,
 * EDACS_).
 */
const RECORDABLE_PROTOCOLS: ReadonlySet<string> = new Set([
	"p25",
	"p25p1",
	"p25p2",
	"nxdn",
	"nxdn48",
	"nxdn96",
	"ysf",
	"dstar",
	"dpmr",
	"provoice",
	"edacs",
	"m17",
])

/** DMR labels: admitted only while DMR_RECORDING_LINK_ENABLED. */
const DMR_PROTOCOLS: ReadonlySet<string> = new Set(["dmr"])

/**
 * True when a call of this protocol may have a recording: an allow-list. A listed non-DMR
 * label (any case, `D-STAR` as `dstar`) is recordable; a DMR label only while
 * DMR_RECORDING_LINK_ENABLED; null (unknown, so it may be DMR) and every other label (a DMR
 * variant such as "Tier III" or "TRBO" included) never.
 */
export function protocolRecordable(protocol: string | null): boolean {
	if (protocol === null) return false
	const label = protocol
		.trim()
		.toLowerCase()
		.replace(/[-_\s]/g, "")
	if (DMR_PROTOCOLS.has(label)) return DMR_RECORDING_LINK_ENABLED
	return RECORDABLE_PROTOCOLS.has(label)
}

/** The system prefix of a dsd-fme call name: the letters and digits after the random field. */
const DSD_FME_CALL_SYSTEM = /^\d{8}_\d{6}_\d{5}_([A-Za-z0-9]+)_/

/**
 * The protocol of a dsd-fme per-call file name, from the system field dsd-fme writes first
 * (`DMR_CC_1`, `P25_1A3`, `NXDN_RAN_1`, `YSF`, `DSTAR`, `DPMR_CC_0`, ...), or null when the
 * name has none (dsd-fme leaves the field empty before it knows the system).
 */
export function dsdFmeCallProtocol(name: string): string | null {
	return DSD_FME_CALL_SYSTEM.exec(name)?.[1] ?? null
}

/**
 * dsd-fme per-call file labels (as protocolRecordable normalizes them) that are never listed,
 * served or linked: P25, NXDN, dPMR and ProVoice (dsd-fme names a ProVoice call `EDACS_`). Such
 * a call is clear only on its own positive clear print, which its file name does not carry, and
 * no stored link proves it to the recordings catalogue; the digital-voice call recorder keeps
 * their known clear calls instead (its own names, gated per call at write and read time).
 */
const DSD_FME_FILE_REFUSED: ReadonlySet<string> = new Set([
	"p25",
	"p25p1",
	"p25p2",
	"nxdn",
	"nxdn48",
	"nxdn96",
	"dpmr",
	"provoice",
	"edacs",
])

/**
 * True when a dsd-fme per-call file may be listed or served: its protocol is recordable
 * (protocolRecordable) and not one whose calls need a positive clear print
 * (DSD_FME_FILE_REFUSED). A DMR name while DMR_RECORDING_LINK_ENABLED is off, a P25, NXDN,
 * dPMR or ProVoice name, a name without a protocol and a name of an unknown protocol are
 * refused (fail closed). D-STAR, YSF and M17 names are served.
 */
export function dsdFmeCallRecordable(name: string): boolean {
	const protocol = dsdFmeCallProtocol(name)
	if (
		protocol !== null &&
		DSD_FME_FILE_REFUSED.has(protocol.toLowerCase().replace(/[-_\s]/g, ""))
	)
		return false
	return protocolRecordable(protocol)
}

/**
 * Protocol labels (as protocolRecordable normalizes them) whose calls are clear only on a
 * positive clear print of their own: P25, NXDN, dPMR and ProVoice (dsd-fme.ts
 * positiveClearProtocol), and DMR (its publication gate always says). D-STAR and YSF carry no
 * privacy field.
 */
const POSITIVE_CLEAR_PROTOCOLS: ReadonlySet<string> = new Set([
	"dmr",
	"p25",
	"p25p1",
	"p25p2",
	"nxdn",
	"nxdn48",
	"nxdn96",
	"dpmr",
	"provoice",
])

/** A call_end's trust fields, as the decoder reported them (dsd-fme's call data). */
export interface CallTrustFields {
	encrypted?: unknown
	encryptionKnown?: unknown
	flags?: unknown
}

/**
 * Whether a call_end's own trust fields admit its recording (written by dsd-fme before this
 * build, or by any decoder): never when it says encrypted; for a positive-clear protocol
 * (POSITIVE_CLEAR_PROTOCOLS, or no or an unknown label) only with `encryptionKnown: true`; for
 * D-STAR, YSF and the other recordable labels unless `encryptionKnown` is false. Fail closed: a
 * call_end that does not say it is clear is not.
 */
export function callTrustAdmits(
	protocol: unknown,
	data: CallTrustFields,
): boolean {
	const flags = data.flags
	const flagged =
		typeof flags === "object" &&
		flags !== null &&
		(flags as Record<string, unknown>)["encrypted"] !== false &&
		(flags as Record<string, unknown>)["encrypted"] !== undefined
	if (data.encrypted === true || flagged) return false
	const label =
		typeof protocol === "string"
			? protocol
					.trim()
					.toLowerCase()
					.replace(/[-_\s]/g, "")
			: null
	if (
		label === null ||
		POSITIVE_CLEAR_PROTOCOLS.has(label) ||
		!protocolRecordable(label)
	)
		return data.encryptionKnown === true
	return data.encryptionKnown !== false
}
