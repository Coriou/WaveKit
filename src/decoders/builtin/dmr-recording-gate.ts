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
 * True when a dsd-fme per-call file may be listed or served: its protocol is recordable
 * (protocolRecordable). A DMR name while DMR_RECORDING_LINK_ENABLED is off, a name without a
 * protocol and a name of an unknown protocol are refused (fail closed).
 */
export function dsdFmeCallRecordable(name: string): boolean {
	return protocolRecordable(dsdFmeCallProtocol(name))
}
