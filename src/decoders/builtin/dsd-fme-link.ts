/**
 * One dsd-fme link-layer line (sync, colour code / NAC / RAN, talkgroup,
 * source, slot) as parsed by DsdFmeDecoder. DsdFmeDecoder emits it as the
 * "link" event (Task 28); the scanner's dsd-fme confirm interpreter consumes it
 * (spec § 6.4, § 6.6). only explicitly `verified` lines without CRC/FEC errors can confirm values (H2).
 */
export type DsdFmeLinkLine = {
	protocol: "dmr" | "p25" | "nxdn" | "ysf" | "dstar" | "dpmr"
	cc?: number
	tg?: string
	src?: string
	slot?: 1 | 2
	nac?: string
	ran?: number
	dgid?: number
	callsign?: string
	/** True only when the printed fields have a known passing content check. */
	verified?: boolean
	/** Checked voice LC containing both target and source. */
	voiceLc?: boolean
	crcErr: boolean
	fecErrs?: number
	encrypted?: boolean
	/** Epoch ms when the line was read. */
	at: number
}
