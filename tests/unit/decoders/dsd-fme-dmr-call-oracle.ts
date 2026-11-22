/**
 * An independent per-call clearance oracle for the dsd-fme DMR adapter.
 *
 * It reads the raw dsd-fme lines on its own (its parse shares no code with
 * the adapter's clearance module) and the call lifetimes the adapter's
 * lifecycle opens and ends (startPendingCall / endCall), and judges each
 * DMR publication at the moment it is emitted: a publication that says the
 * call is clear (encrypted false, encryptionKnown not false) is authorized
 * only when a settled proof chain owned by that call's lifetime backs it.
 *
 * Rules (fail closed):
 * - Proof belongs to one callId: its lines lie in the call's window (from
 *   the line after the previous boundary or the previous call of its lane,
 *   so lines a call had before it got its id count, unplaced ones included)
 *   and in no other call's lifetime. A clear for a callId the lifecycle never
 *   opened, or outside its lifetime, is never authorized.
 * - Privacy is sticky for the whole window: an Encrypted print, SVC bit 0x40,
 *   a non-clear ALG or a non-zero KEY ID on the call's lane, on any line that
 *   cannot be attributed to a lane (a bare or bracketless DMR sync's burst),
 *   or on another slot's line printing this call's slot, forbids clear.
 * - A call that was ever unplaced (born on an unattributable line, or a
 *   lane-0 call that saw a bare or bracketless DMR sync) is never clear.
 * - A restart forbids clear for every call alive at it. Another protocol, a
 *   BS/MS change or a gap over the call timeout ends the window: only a
 *   publication on that very line (the call's end) may still carry a clear
 *   proven before it.
 * - A chain is: a clean opening sync of the lane (VLC, voice, or a TLC of a
 *   call already named in its window), the burst's first link control with
 *   the publication's key (clean, plausible, no privacy field, not a
 *   "DMR Voice" print, not another slot's print), then the lane's next sync,
 *   clean, of the same format, before the publication; no error line on the
 *   lane or unattributable between the two syncs, no non-neutral line of
 *   the lane after the link control, and no checked rival key after a voice
 *   sync between the link control and the publication.
 */

export const ORACLE_TIMEOUT_MS = 4000
export const RESTART_LINE = "<restart>"

type Lane = "1" | "2" | "ms" | "x" | "foreign" | "none"
type Format = "bs" | "ms" | "x"
type BurstKind = "vlc" | "voice" | "tlc" | "pi" | "idle" | "bare" | "other"

interface OracleLine {
	seq: number
	atMs: number
	text: string
	restart: boolean
	foreign: boolean
	sync: boolean
	format: Format | undefined
	burst: BurstKind | undefined
	lane: Lane
	errored: boolean
	privacy: boolean
	key: string | undefined
	plausible: boolean
	neutral: boolean
	printedSlot: string | undefined
	/** A BS/MS change happened on this sync. */
	modeChange: boolean
}

export interface CallLife {
	callId: string
	born: number
	/** The adapter lane: 0 (MS or unplaced), 1 or 2 (a repeater slot). */
	adapterLane: number
	end: number
}

export interface Claim {
	callId: string
	seq: number
	talkgroup: number | null
	source: number | null
	encrypted: boolean
	encryptionKnown: boolean | undefined
	hasField: boolean
}

const PRIVACY_FIELDS = {
	svc: /SVC=0x([0-9A-F]+)/i,
	alg: /\bALG(?:\s+ID)?\s*[:=]\s*(?:0x)?([0-9A-F]{1,4})\b/i,
	keyId: /\bKEY\s+ID\s*[:=]\s*(?:0x)?([0-9A-F]{1,4})\b/i,
}

function hasPrivacy(text: string): boolean {
	if (/encrypt/i.test(text)) return true
	const svc = PRIVACY_FIELDS.svc.exec(text)?.[1]
	if (svc !== undefined && (parseInt(svc, 16) & 0x40) !== 0) return true
	const alg = PRIVACY_FIELDS.alg.exec(text)?.[1]
	if (alg !== undefined && ![0, 0x80].includes(parseInt(alg, 16))) return true
	const key = PRIVACY_FIELDS.keyId.exec(text)?.[1]
	return key !== undefined && parseInt(key, 16) !== 0
}

function hasError(text: string): boolean {
	if (/^\s*SLCO CRC ERR\s*$/.test(text)) return false
	return /ERR\b|\bErr\b|SYNC LOST|\s-RAS\s/i.test(text)
}

const NEUTRAL =
	/^\s*$|^\s*SLCO CRC ERR\s*$|^\s*SLCO NULL\b|^\s*Activity Update\b|^\s*DMR PDU Payload\b|^\s*SLCO Completed Block\b|^\s*SB: |^\s*AMBE /

export class CallOracle {
	private readonly lines: OracleLine[] = []
	private readonly lives = new Map<string, CallLife>()
	/** Calls published encrypted once: sticky. */
	private readonly encrypted = new Set<string>()
	private format: Format | undefined
	private slot: "1" | "2" = "1"
	private mode: "bs" | "ms" | undefined
	private dmr = false
	private foreignActive = false

	/** Feeds one input line (or RESTART_LINE) with its sequence number. */
	line(seq: number, atMs: number, text: string): void {
		const base: OracleLine = {
			seq,
			atMs,
			text,
			restart: false,
			foreign: false,
			sync: false,
			format: undefined,
			burst: undefined,
			lane: "none",
			errored: false,
			privacy: false,
			key: undefined,
			plausible: false,
			neutral: false,
			printedSlot: undefined,
			modeChange: false,
		}
		if (text === RESTART_LINE) {
			this.format = undefined
			this.mode = undefined
			this.dmr = false
			this.foreignActive = false
			this.lines.push({ ...base, restart: true })
			return
		}
		const errored = hasError(text)
		const privacy = hasPrivacy(text)
		const sync = /\bSync:\s*[+-]?(?!no\b)([A-Za-z0-9]+)/i.exec(text)
		if (sync) {
			if (sync[1]!.toUpperCase() !== "DMR") {
				this.format = undefined
				this.mode = undefined
				this.dmr = false
				this.foreignActive = true
				this.lines.push({
					...base,
					foreign: true,
					sync: true,
					lane: "foreign",
					errored,
					privacy,
				})
				return
			}
			this.dmr = true
			this.foreignActive = false
			const bracket = /\[SLOT([12])\]/i.exec(text)?.[1] as "1" | "2" | undefined
			const format: Format =
				bracket !== undefined ? "bs" : /MS\/DM/i.test(text) ? "ms" : "x"
			this.format = format
			if (bracket !== undefined) this.slot = bracket
			let modeChange = false
			if (format !== "x") {
				modeChange = this.mode !== undefined && this.mode !== format
				this.mode = format
			}
			const tail = text.includes("|")
				? text.slice(text.lastIndexOf("|") + 1)
				: ""
			const burst: BurstKind = !text.includes("|")
				? "bare"
				: /\bVLC\b/.test(tail)
					? "vlc"
					: /\bTLC\b/.test(tail)
						? "tlc"
						: /\bVC[1-6*]/.test(tail)
							? "voice"
							: /\bPI\b/.test(tail)
								? "pi"
								: /\bIDLE\b/.test(tail)
									? "idle"
									: "other"
			this.lines.push({
				...base,
				sync: true,
				format,
				burst,
				lane: format === "bs" ? this.slot : format,
				errored,
				privacy,
				modeChange,
			})
			return
		}
		const lane: Lane = this.foreignActive
			? "foreign"
			: !this.dmr
				? "x"
				: this.format === "bs"
					? this.slot
					: this.format === "ms"
						? "ms"
						: "x"
		const printed = /\bSLOT\s+([12])\b/i.exec(text)?.[1]
		const otherSlot =
			this.format === "bs" && printed !== undefined && printed !== this.slot
		const ids =
			otherSlot || /\bDMR\s+Voice\b/i.test(text)
				? undefined
				: /\bTGT\s*[=:]\s*(\d+)\b[^\n]*?\bSRC\s*[=:]\s*(\d+)\b/i.exec(text)
		const tg = Number(ids?.[1] ?? 0)
		const src = Number(ids?.[2] ?? 0)
		this.lines.push({
			...base,
			lane,
			errored,
			privacy,
			key: ids ? `${tg}/${src}` : undefined,
			plausible: tg >= 1 && tg <= 0xffffff && src >= 1 && src <= 0xffffff,
			neutral: !errored && !privacy && NEUTRAL.test(text),
			printedSlot: otherSlot ? printed : undefined,
		})
	}

	born(callId: string, seq: number, adapterLane: number): void {
		if (!this.lives.has(callId))
			this.lives.set(callId, { callId, born: seq, adapterLane, end: Infinity })
	}

	ended(callId: string, seq: number): void {
		const life = this.lives.get(callId)
		if (life && life.end === Infinity) life.end = seq
	}

	/** Returns null when the claim is authorized (or not a clear claim), else why not. */
	judge(claim: Claim): string | null {
		if (!claim.hasField || typeof claim.encryptionKnown !== "boolean")
			return "encryptionKnown omitted"
		if (claim.encrypted) {
			this.encrypted.add(claim.callId)
			return null
		}
		if (claim.encryptionKnown === false) return null
		if (this.encrypted.has(claim.callId)) return "clear after encrypted"
		const life = this.lives.get(claim.callId)
		if (!life) return "clear for a call the lifecycle never opened"
		if (claim.seq < life.born || claim.seq > life.end + 0.75)
			return "clear outside the call's lifetime"
		if (claim.talkgroup === null || claim.source === null)
			return "clear without a named key"
		const key = `${claim.talkgroup}/${claim.source}`
		const seen = this.lines.filter(l => l.seq < claim.seq)
		const birth = seen.find(l => l.seq === Math.floor(life.born))
		const lane: Lane | undefined =
			life.adapterLane === 1 ? "1" : life.adapterLane === 2 ? "2" : "ms"
		if (birth === undefined) return "no birth line"
		if (birth.lane !== lane) return "call born unplaced or off its lane"
		// Boundaries before birth bound the window.
		let windowStart = 1
		let lastLaneAt: number | undefined
		for (const l of seen) {
			if (l.seq >= life.born) break
			if (l.restart || l.foreign || l.modeChange) windowStart = l.seq + 1
			if (l.lane === lane) {
				if (lastLaneAt !== undefined && l.atMs - lastLaneAt > ORACLE_TIMEOUT_MS)
					windowStart = l.seq
				lastLaneAt = l.atMs
			}
		}
		const others = [...this.lives.values()].filter(
			o => o.callId !== claim.callId && o.adapterLane === life.adapterLane,
		)
		for (const o of others)
			if (o.born < life.born)
				windowStart = Math.max(
					windowStart,
					Math.floor(Math.min(o.end, life.born - 1)) + 1,
				)
		const ownedByOther = (seq: number) =>
			others.some(
				o => seq >= Math.floor(o.born) && seq <= Math.min(o.end, Infinity),
			)
		const life_ = seen.filter(l => l.seq >= windowStart)
		// Restarts, unplaced syncs for a lane-0 call, and later boundaries.
		let boundary: OracleLine | undefined
		lastLaneAt = undefined
		for (const l of life_) {
			if (l.seq >= life.born) {
				if (l.restart) return "restart during the call"
				if (lane === "ms" && l.sync && l.format === "x")
					return "lane-0 call saw an unplaced DMR sync"
				if (
					boundary === undefined &&
					(l.foreign ||
						l.modeChange ||
						(l.lane === lane &&
							lastLaneAt !== undefined &&
							l.atMs - lastLaneAt > ORACLE_TIMEOUT_MS))
				)
					boundary = l
			}
			if (l.lane === lane) lastLaneAt = l.atMs
		}
		if (boundary !== undefined && boundary.seq < Math.floor(claim.seq))
			return "clear after a protocol, mode or timeout boundary"
		const proofEnd = boundary?.seq ?? Infinity
		// Sticky privacy over the whole window.
		if (
			life_.some(
				l =>
					l.privacy &&
					(l.lane === lane || l.lane === "x" || l.printedSlot === lane),
			)
		)
			return "privacy print in the call's window"
		const laneLines = life_.filter(l => l.lane === lane && l.seq < proofEnd)
		for (let i = 0; i < laneLines.length; i++) {
			const lc = laneLines[i]!
			if (
				lc.sync ||
				lc.key !== key ||
				!lc.plausible ||
				lc.errored ||
				lc.privacy ||
				ownedByOther(lc.seq)
			)
				continue
			const before = laneLines.slice(0, i)
			const s = [...before].reverse().find(l => l.sync)
			if (s === undefined || s.errored) continue
			if (before.some(l => !l.sync && l.key !== undefined && l.seq > s.seq))
				continue
			const t = laneLines.slice(i + 1).find(l => l.sync)
			if (t === undefined || t.errored || t.format !== s.format) continue
			if (t.atMs - lc.atMs > ORACLE_TIMEOUT_MS) continue
			if (s.burst === "vlc") {
				if (t.burst !== "voice" && t.burst !== "vlc") continue
			} else if (s.burst === "tlc") {
				const named = before.some(
					l =>
						!l.sync &&
						l.seq < s.seq &&
						l.key === key &&
						!l.errored &&
						l.plausible &&
						before.some(v => v.sync && v.burst === "voice" && v.seq < l.seq),
				)
				if (!named) continue
			} else if (s.burst !== "voice") continue
			const between = life_.filter(l => l.seq > s.seq && l.seq < t.seq)
			if (between.some(l => l.errored && (l.lane === lane || l.lane === "x")))
				continue
			if (
				between.some(
					l => l.lane === lane && l.seq > lc.seq && !l.sync && !l.neutral,
				)
			)
				continue
			let afterVoice = false
			let rival = false
			for (const l of laneLines) {
				if (l.seq <= lc.seq) continue
				if (l.sync) afterVoice = l.burst === "voice"
				else if (
					afterVoice &&
					l.key !== undefined &&
					l.key !== key &&
					!l.errored &&
					l.plausible
				)
					rival = true
			}
			if (rival) continue
			return null
		}
		return "no settled proof chain owned by the call"
	}
}
