/**
 * An independent per-call privacy oracle for dsd-fme's non-DMR digital voice
 * (P25 phase 1 and 2, NXDN48/96, dPMR, ProVoice, D-STAR, YSF). It reads the
 * same lines the adapter reads, learns which call is live from the adapter's
 * call births and ends, and says whether a publication may call a call clear
 * or link its recording. It imports nothing from the adapter.
 *
 * The rule, from the prints of the pinned dsd-fme build:
 * - P25 phase 1: only an error-free LDU2 print "ALG ID: 0x80 KEY ID: 0x0000"
 *   while the call is live proves it clear (p25p1_ldu2.c prints the ALG of
 *   every LDU2 that decoded, clear or not).
 * - NXDN: only a CRC-checked VCALL naming the call's own source and
 *   destination, whose next line is not a cipher print, proves it clear
 *   (nxdn_element.c prints the cipher type and key on the next line whenever
 *   the 2-bit cipher type is not 0, and nothing when it is 0).
 * - P25 phase 2, dPMR, ProVoice: nothing proves a call clear (phase 2 prints
 *   an ALG only when it is neither 0x80 nor 0x00; dPMR prints "Scrambler"
 *   for encryption mode 3 only; ProVoice prints no privacy field). Never.
 * - D-STAR and YSF carry no privacy field: clear unless a privacy print.
 * - Any privacy print marks the live call encrypted for good, and taints the
 *   protocol's context: a call born in it within CONTEXT_MS, before a
 *   terminator, a protocol switch or a restart, is encrypted.
 */

/** The context window: the adapter's call timeout. */
export const CONTEXT_MS = 4000

export const RESTART_LINE = "<<restart>>"

type Family = "p25p1" | "p25p2" | "nxdn" | "dpmr" | "provoice" | "dstar" | "ysf"

const STRICT: ReadonlySet<Family> = new Set([
	"p25p1",
	"p25p2",
	"nxdn",
	"dpmr",
	"provoice",
])

function familyOf(protocol: string | null | undefined): Family | null {
	const p = (protocol ?? "").toLowerCase()
	if (p === "p25p1") return "p25p1"
	if (p === "p25p2") return "p25p2"
	if (p === "nxdn48" || p === "nxdn96" || p === "nxdn") return "nxdn"
	if (p === "dpmr") return "dpmr"
	if (p === "provoice") return "provoice"
	if (p === "dstar") return "dstar"
	if (p === "ysf") return "ysf"
	return null
}

function familyOfSync(text: string): Family | null | undefined {
	const m = /\bSync:\s*[+-]?([A-Za-z0-9]+)/.exec(text)
	if (!m) return undefined
	const p = (m[1] ?? "").toUpperCase()
	if (p === "P25P1") return "p25p1"
	if (p === "P25P2") return "p25p2"
	if (p.startsWith("NXDN")) return "nxdn"
	if (p === "DPMR") return "dpmr"
	if (p === "PROVOICE") return "provoice"
	if (p === "DSTAR") return "dstar"
	if (p === "YSF") return "ysf"
	return null
}

function privacyPrint(family: Family | null, text: string): boolean {
	if (family === "p25p1" || family === "p25p2") {
		const alg = /\bALG(?:\s+ID)?:\s*0x([0-9A-Fa-f]{2})\b/.exec(text)?.[1]
		if (alg !== undefined) {
			const v = parseInt(alg, 16)
			if (v !== 0x80 && v !== 0x00) return true
		}
		return /\bEncrypted\b|\bENC\b|\bLCW Protected\b/.test(text)
	}
	if (family === "nxdn")
		return /\b(?:Scrambler|DES|AES) - Key ID\b|\bENC;|\bEncrypted\b/.test(text)
	if (family === "dpmr") return /\bScrambler\b|\bEncrypted\b/.test(text)
	return false
}

function terminator(family: Family | null, text: string): boolean {
	if (!/\bSync:/.test(text)) return false
	if (family === "p25p1" || family === "p25p2")
		return /\bTDU(?:LC)?\b/.test(text)
	if (family === "nxdn") return /\b(?:TX_REL|TX_REL_EX|DISC)\s*$/.test(text)
	return false
}

export interface NonDmrClaim {
	callId: string
	protocol: string | null | undefined
	talkgroup: number | null | undefined
	source: number | null | undefined
	/** The publication says the call is clear (not encrypted, encryptionKnown not false). */
	saysClear: boolean
	/** The publication links a recording to the call. */
	linked: boolean
}

interface Evidence {
	talkgroup?: number
	source?: number
}

export class NonDmrOracle {
	private context: Family | null = null
	private readonly live = new Map<string, Family>()
	private lastBorn: string | null = null
	private readonly encrypted = new Set<string>()
	private readonly clear = new Map<string, Evidence[]>()
	private taint: { family: Family; atMs: number } | null = null
	/** NXDN: the last line was a checked VCALL frame line. */
	private vcallFrame = false
	/** NXDN: the VCALL's IDs, waiting for the next line. */
	private vcallIds: { talkgroup: number; source: number } | null = null

	born(
		callId: string,
		protocol: string | null | undefined,
		atMs: number,
	): void {
		const family = familyOf(protocol)
		if (family === null) return
		this.live.set(callId, family)
		this.lastBorn = callId
		const t = this.taint
		if (t !== null && t.family === family && atMs - t.atMs <= CONTEXT_MS)
			this.encrypted.add(callId)
	}

	ended(callId: string): void {
		this.live.delete(callId)
		if (this.lastBorn === callId) this.lastBorn = null
	}

	private liveCall(family: Family): string | null {
		const id = this.lastBorn
		if (id !== null && this.live.get(id) === family) return id
		for (const [callId, f] of this.live) if (f === family) return callId
		return null
	}

	/** One line, before the adapter reads it. */
	line(atMs: number, text: string): void {
		if (text === RESTART_LINE) {
			this.taint = null
			this.vcallFrame = false
			this.vcallIds = null
			return
		}
		if (this.taint !== null && atMs - this.taint.atMs > CONTEXT_MS)
			this.taint = null
		const sync = familyOfSync(text)
		if (sync !== undefined && sync !== this.context) {
			this.taint = null
			this.vcallFrame = false
			this.vcallIds = null
			this.context = sync
		}
		const family = this.context
		const privacy = privacyPrint(family, text)
		// NXDN: the line after a VCALL's IDs settles them.
		if (family === "nxdn" && this.vcallIds !== null && text.trim() !== "") {
			const ids = this.vcallIds
			this.vcallIds = null
			const call = this.liveCall("nxdn")
			if (!privacy && call !== null) this.addClear(call, ids)
		}
		if (privacy && family !== null) {
			const call = this.liveCall(family)
			if (call !== null) this.encrypted.add(call)
			this.taint = { family, atMs }
		} else if (terminator(family, text)) this.taint = null
		if (
			family === "p25p1" &&
			/^\s*LDU2 ALG ID: 0x80 KEY ID: 0x0000\b/.test(text) &&
			!/\bERR\b/.test(text)
		) {
			const call = this.liveCall("p25p1")
			if (call !== null) this.addClear(call, {})
		}
		if (family === "nxdn") {
			if (this.vcallFrame && text.trim() !== "") {
				this.vcallFrame = false
				const m = /\bSrc=(\d+) - Dst\/TG=(\d+)\b/.exec(text)
				if (m) this.vcallIds = { source: Number(m[1]), talkgroup: Number(m[2]) }
			}
			if (
				/\bSync:/.test(text) &&
				/\bR(?:DCH|TCH)\b/.test(text) &&
				/\bVCALL\s*$/.test(text) &&
				!/\bCRC\s+ERR\b/i.test(text)
			)
				this.vcallFrame = true
		}
	}

	private addClear(callId: string, evidence: Evidence): void {
		const list = this.clear.get(callId) ?? []
		list.push(evidence)
		this.clear.set(callId, list)
	}

	/** Null when the claim is allowed, else why not. */
	judge(claim: NonDmrClaim): string | null {
		if (!claim.saysClear && !claim.linked) return null
		const family = familyOf(claim.protocol)
		if (family === null) return "unknown protocol"
		if (this.encrypted.has(claim.callId)) return "privacy print for the call"
		if (!STRICT.has(family)) return null
		const evidence = this.clear.get(claim.callId) ?? []
		const own = evidence.some(
			e =>
				(e.talkgroup === undefined || e.talkgroup === claim.talkgroup) &&
				(e.source === undefined || e.source === claim.source),
		)
		return own ? null : "no positive clear evidence for the call"
	}
}
