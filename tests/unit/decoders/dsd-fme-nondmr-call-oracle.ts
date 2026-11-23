/**
 * An independent per-call privacy oracle for dsd-fme's non-DMR digital voice
 * (P25 phase 1 and 2, NXDN48/96, dPMR, ProVoice, D-STAR, YSF). It reads the
 * same lines the adapter reads and derives the overs ITSELF from them (P25
 * HDU and terminator syncs, a change of the talkgroup / source a link
 * control names, a protocol switch, a silence longer than the call timeout,
 * a restart). Evidence binds to the over it was printed in and the identity
 * that over's own link control named. The adapter's publications are judged
 * by their protocol, talkgroup and source against the overs heard while the
 * publication's call was live (from its first publication to the judged
 * one): the oracle never asks the adapter which call is live, and it imports
 * nothing from the adapter.
 *
 * The rule, from the prints of the pinned dsd-fme build:
 * - P25 phase 1: only an error-free LDU2 print "ALG ID: 0x80 KEY ID: 0x0000"
 *   proves an over clear, and only for the identity the clean LCW of the
 *   same superframe's LDU1 named (p25p1_ldu2.c prints the ALG of every LDU2
 *   that decoded, clear or not; the LDU2 carries no IDs). An LDU2 after an
 *   HDU or a failed LDU1, before a clean LCW, proves nothing.
 * - NXDN: only a CRC-checked VCALL naming the over's source and destination,
 *   whose next line is not a cipher print, proves it clear (nxdn_element.c
 *   prints the cipher type and key on the next line whenever the 2-bit
 *   cipher type is not 0, and nothing when it is 0).
 * - P25 phase 2, dPMR, ProVoice: nothing proves a call clear (phase 2 prints
 *   an ALG only when it is neither 0x80 nor 0x00; dPMR prints "Scrambler"
 *   for encryption mode 3 only; ProVoice prints no privacy field). Never.
 * - D-STAR and YSF carry no privacy field: clear unless a privacy print.
 * - Any privacy print marks its over encrypted for good, and taints the
 *   protocol's context: an over born in it within CONTEXT_MS, before a
 *   terminator, a protocol switch or a restart, is encrypted.
 * - A call is clear when one over of its protocol and identity heard while it
 *   was live was proven clear, and no over heard while it was live that
 *   could be it (same identity, or not yet named) was encrypted.
 */

/** The context window: the adapter's call timeout. */
export const CONTEXT_MS = 4000

export const RESTART_LINE = "<<restart>>"

type Family = "p25p1" | "p25p2" | "nxdn" | "dpmr" | "provoice" | "dstar" | "ysf"

/** Families with a positive clear print. */
const PROVABLE: ReadonlySet<Family> = new Set(["p25p1", "nxdn"])
/** Families with no positive clear print at all: never clear. */
const NEVER: ReadonlySet<Family> = new Set(["p25p2", "dpmr", "provoice"])

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

/** A line printing an error of its burst: nothing on it is checked. */
const ERRORED = /\bERR\b|\bduid:EE\b/

/** The P25 phase 1 data unit a sync line prints. */
function p25Duid(text: string): string | null {
	if (/\bduid:EE\b/.test(text)) return null
	return /\b(HDU|LDU1|LDU2|TDULC|TDU|TSBK|MPDU)\b/.exec(text)?.[1] ?? null
}

interface Id {
	talkgroup: number
	source: number
}

/** The identity a P25 phase 1 link control print names, if any. */
function p25Lcw(text: string): Id | null {
	const g = /Group Voice Channel User - Group (\d+) Source (\d+)/.exec(text)
	if (g) return { talkgroup: Number(g[1]), source: Number(g[2]) }
	const u = /Unit to Unit Voice Channel User - Target \d+ Source (\d+)/.exec(
		text,
	)
	if (u) return { talkgroup: 0, source: Number(u[1]) }
	return null
}

const sameId = (a: Id | null, b: Id | null): boolean =>
	a !== null &&
	b !== null &&
	a.talkgroup === b.talkgroup &&
	a.source === b.source

interface Over {
	family: Family
	startMs: number
	lastMs: number
	/** Null while open. */
	endMs: number | null
	/** The identity the over's own link control named; null while unnamed. */
	id: Id | null
	encrypted: boolean
	/** Proven clear for its identity (`id`). */
	clear: boolean
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
	/** When the publication was emitted. */
	atMs: number
}

export class NonDmrOracle {
	private context: Family | null = null
	private readonly overs: Over[] = []
	private open: Over | null = null
	private taint: { family: Family; atMs: number } | null = null
	/** First publication of each call id. */
	private readonly firstSeen = new Map<string, number>()
	/** P25 phase 1: the LDU1 waiting for its LCW. */
	private lcwDue = false
	/** P25 phase 1: the identity this superframe's LDU1 named cleanly. */
	private ldu1Named: Id | null = null
	/** P25 phase 1: the identity the current LDU2 may prove clear. */
	private ldu2Credit: Id | null = null
	/** NXDN: the last line was a checked VCALL frame line. */
	private vcallFrame = false
	/** NXDN: the VCALL's IDs, waiting for the next line. */
	private vcallIds: Id | null = null

	/** Ends the open over at its last line. */
	private close(): void {
		const over = this.open
		if (over === null) return
		over.endMs = over.lastMs
		this.open = null
	}

	private begin(family: Family, atMs: number, id: Id | null = null): Over {
		this.close()
		const t = this.taint
		const over: Over = {
			family,
			startMs: atMs,
			lastMs: atMs,
			endMs: null,
			id,
			encrypted:
				t !== null && t.family === family && atMs - t.atMs <= CONTEXT_MS,
			clear: false,
		}
		this.overs.push(over)
		this.open = over
		return over
	}

	/** The open over of `family`, begun if none. */
	private current(family: Family, atMs: number): Over {
		const over = this.open
		if (over !== null && over.family === family) {
			over.lastMs = atMs
			return over
		}
		return this.begin(family, atMs)
	}

	/** A link control names `id`: another identity is another over. */
	private name(family: Family, atMs: number, id: Id): Over {
		let over = this.current(family, atMs)
		if (over.id !== null && !sameId(over.id, id))
			over = this.begin(family, atMs)
		over.id = id
		return over
	}

	private reset(): void {
		this.lcwDue = false
		this.ldu1Named = null
		this.ldu2Credit = null
		this.vcallFrame = false
		this.vcallIds = null
	}

	/** One line, before the adapter reads it. */
	line(atMs: number, text: string): void {
		if (text === RESTART_LINE) {
			this.close()
			this.taint = null
			this.context = null
			this.reset()
			return
		}
		if (this.taint !== null && atMs - this.taint.atMs > CONTEXT_MS)
			this.taint = null
		const open = this.open
		if (open !== null && atMs - open.lastMs > CONTEXT_MS) this.close()
		const sync = familyOfSync(text)
		if (sync !== undefined && sync !== this.context) {
			this.close()
			this.taint = null
			this.reset()
			this.context = sync
		}
		const family = this.context
		if (family === null) return
		if (text.trim() === "") return
		const privacy = privacyPrint(family, text)
		if (family === "p25p1") this.p25Line(atMs, text, sync !== undefined)
		else if (family === "nxdn") this.nxdnLine(atMs, text, privacy)
		else if (sync !== undefined || this.open !== null)
			this.current(family, atMs)
		if (privacy) {
			this.current(family, atMs).encrypted = true
			this.taint = { family, atMs }
		}
	}

	private p25Line(atMs: number, text: string, isSync: boolean): void {
		if (isSync) {
			const duid = p25Duid(text)
			const named = this.ldu1Named
			this.lcwDue = false
			this.ldu1Named = null
			this.ldu2Credit = null
			if (duid === "HDU") {
				// The header opens the next over.
				this.begin("p25p1", atMs)
				return
			}
			if (duid === "TDU" || duid === "TDULC") {
				if (this.open !== null) this.open.lastMs = atMs
				this.close()
				this.taint = null
				return
			}
			if (duid === "LDU1" || duid === "LDU2") this.current("p25p1", atMs)
			if (duid === "LDU1" && !ERRORED.test(text)) this.lcwDue = true
			if (duid === "LDU2") this.ldu2Credit = named
			// The LDU2's ALG print on its own sync line (no newline between them).
			if (
				duid === "LDU2" &&
				/\bLDU2\s+ALG ID: 0x80 KEY ID: 0x0000\b/.test(text)
			)
				this.ldu2Clear(text)
			return
		}
		const lcw = p25Lcw(text)
		if (lcw !== null) {
			const due = this.lcwDue
			this.lcwDue = false
			if (lcw.talkgroup === 0 && lcw.source === 0) return
			this.name("p25p1", atMs, lcw)
			if (due && !ERRORED.test(text)) this.ldu1Named = lcw
			return
		}
		if (/^\s*LDU2 ALG ID: 0x80 KEY ID: 0x0000\b/.test(text))
			this.ldu2Clear(text)
		if (this.open !== null) this.open.lastMs = atMs
	}

	/** An LDU2 clear print: proves clear only the identity this superframe's LDU1 named. */
	private ldu2Clear(text: string): void {
		if (ERRORED.test(text) || privacyPrint("p25p1", text)) return
		const credit = this.ldu2Credit
		this.ldu2Credit = null
		const over = this.open
		if (
			credit !== null &&
			over !== null &&
			over.family === "p25p1" &&
			sameId(over.id, credit)
		)
			over.clear = true
	}

	private nxdnLine(atMs: number, text: string, privacy: boolean): void {
		const isSync = /\bSync:/.test(text)
		// The line after a VCALL's IDs settles them.
		if (this.vcallIds !== null) {
			const ids = this.vcallIds
			this.vcallIds = null
			const over = this.open
			if (
				!privacy &&
				!ERRORED.test(text) &&
				over !== null &&
				over.family === "nxdn" &&
				sameId(over.id, ids)
			)
				over.clear = true
		}
		if (this.vcallFrame && !isSync) {
			this.vcallFrame = false
			const m = /\bSrc=(\d+) - Dst\/TG=(\d+)\b/.exec(text)
			if (m) {
				const id = { source: Number(m[1]), talkgroup: Number(m[2]) }
				this.name("nxdn", atMs, id)
				this.vcallIds = id
			}
		} else this.vcallFrame = false
		if (isSync) {
			this.current("nxdn", atMs)
			if (/\b(?:TX_REL|TX_REL_EX|DISC)\s*$/.test(text)) {
				this.close()
				this.taint = null
			} else if (
				/\bR(?:DCH|TCH)\b/.test(text) &&
				/\bVCALL\s*$/.test(text) &&
				!ERRORED.test(text)
			)
				this.vcallFrame = true
		} else if (this.open !== null) this.open.lastMs = atMs
	}

	/** Null when the claim is allowed, else why not. */
	judge(claim: NonDmrClaim): string | null {
		const first = this.firstSeen.get(claim.callId) ?? claim.atMs
		this.firstSeen.set(claim.callId, first)
		if (!claim.saysClear && !claim.linked) return null
		const family = familyOf(claim.protocol)
		if (family === null) return "unknown protocol"
		if (NEVER.has(family)) return "no positive clear print exists"
		const id: Id = {
			talkgroup: claim.talkgroup ?? 0,
			source: claim.source ?? 0,
		}
		const heard = this.overs.filter(
			o =>
				o.family === family &&
				o.startMs <= claim.atMs &&
				(o.endMs === null || o.endMs >= first),
		)
		if (heard.some(o => o.encrypted && (o.id === null || sameId(o.id, id))))
			return "privacy print for the call"
		if (!PROVABLE.has(family)) return null
		return heard.some(o => o.clear && sameId(o.id, id))
			? null
			: "no positive clear evidence for the call"
	}
}
