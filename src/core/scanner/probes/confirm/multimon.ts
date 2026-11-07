/**
 * multimon-ng confirm interpreter (spec § 6.4): a POCSAG/FLEX capcode is accepted on two decodes
 * with the same capcode, or on one decode whose payload is plausible. POCSAG holds more to it than
 * FLEX, since its 32-bit sync is short enough for chance to find (see `POCSAG_BODY_MIN_CHARS`). It
 * looks at the decode alone, never at the channel's spectral class: `POCSAG_ZERO_WORD_ADDRESSES`
 * says why a class would add nothing.
 */
import { z } from "zod"
import type { DecodeEvidence } from "../../types.js"
import {
	CONFIRM_MIN_SEPARATION_MS,
	CONFIRM_WINDOW_MS,
} from "./confirm-memory.js"
import { evidenceBase } from "./double-match.js"
import type { DecoderOutputLike, InterpreterState } from "./double-match.js"

const PagerSchema = z
	.object({
		protocol: z.string(),
		address: z.number().int().nonnegative().optional(),
		capcode: z.string().optional(),
		function: z.number().int().optional(),
		messageType: z.string().optional(),
		message: z.string().optional(),
	})
	.passthrough()

const MIN_PAYLOAD_CHARS = 4
const MIN_PRINTABLE_RATIO = 0.9
/** multimon-ng prints control characters as their ASCII names in angle brackets. */
const CONTROL_TOKEN =
	/<(NUL|SOH|STX|ETX|EOT|ENQ|ACK|BEL|BS|HT|LF|VT|FF|CR|SO|SI|DLE|DC1|DC2|DC3|DC4|NAK|SYN|ETB|CAN|EM|SUB|ESC|FS|GS|RS|US|DEL)>/g
const TEXT_CONTROLS = new Set(["CR", "LF", "HT"])

/**
 * One POCSAG decode names a pager only with a body of at least this many characters.
 *
 * Why a body is not enough. A chance sync comes (1 + 32 + 496) / 2^32 = 1.2e-7 per bit with its 2
 * correctable errors, so at most 4112 bit/s x 1.2e-7 = 5.1e-4 per second over the three modes, one
 * per 33 minutes of fair bits. Past it each random word is valid about 1 time in 4 (2^21 x 529 /
 * 2^32), and a word with its top bit set extends the body: alpha holds 2.9 characters per word and
 * numeric 5. Chance bits fed to multimon-ng 1.2.0 (140k chance syncs at 512, 1200 and 2400 baud) gave
 * 0.06 decodes per sync, so one per 9 hours at most, and 3.6 % of those passed the 4-character bar
 * FLEX keeps: one false identity per 10 days of decoding. They are 5 numeric digits (one word) or 5
 * alpha characters (two words). At 8 characters, alpha needs 3 words, 1 of the 8542 decodes passed, and
 * numeric needs 2.
 *
 * What it costs: a shorter body is no identity on its own and counts as a repeat instead, as a
 * tone-only decode does. A real page of 8 characters or more identifies on its first decode.
 */
export const POCSAG_BODY_MIN_CHARS = 8
/**
 * Share of a numeric POCSAG body that is digits, space or dash, the characters a phone or call-back
 * number uses. Each of the 16 BCD symbols prints, so `payloadPlausible` passes any numeric body;
 * random symbols hit these 12 with p = 0.75, and at 0.9 a 2-word 10-symbol body needs 9 of the 10
 * (0.75^10 + 10 x 0.25 x 0.75^9 = 24 %). With the length bar 13 of the 8542 decodes passed, alpha included
 * (0.15 %): one false identity per 240 days of decoding. A stuck slicer's "((((" fails.
 */
export const POCSAG_NUMERIC_MIN_RATIO = 0.9
const POCSAG_NUMERIC_CHARS = /[0-9 -]/
/**
 * An all-zero word is a valid POCSAG address word: address 0 plus the frame position, 0 to 7, function 0.
 * So after one chance sync a slicer held on one level (a bare carrier off the channel's centre, with
 * no CTCSS tone to move it) decodes these 8 addresses for as long as it holds, multimon-ng 1.2.0
 * staying in lock over an 8 s test. Two decodes 2 s apart would then "repeat" from one chance sync, so
 * these decodes pair only across a quiet gap (`POCSAG_LOW_QUIET_MS`); a body of its own
 * (`pocsagBodyReal`) still identifies them.
 *
 * Every other address repeats by chance only if false decodes are uniform over the 2^21 addresses,
 * and then such repeats are negligible. Nothing makes them uniform: a false address that recurs on one
 * channel can not be told from a beacon without further evidence. That is a known limit. A shorter
 * window on analog-fm channels would not end it and would lose a tone-only beacon about every 60 s on
 * any channel read as analog-fm. So the same window holds on every channel, whatever its class, and
 * such a beacon identifies on its second decode.
 */
export const POCSAG_ZERO_WORD_ADDRESSES = 8
/**
 * Quiet needed before a decode of the 8 all-zero-word addresses may count as a repeat: 30 s. A stuck
 * slicer prints every batch (17 words of 32 bits at 512 baud, about 1 s, the slowest mode), so its gaps
 * stay far under this, and 30 s is half of a 60 s beacon's period.
 */
export const POCSAG_LOW_QUIET_MS = 30_000
/**
 * Occurrences a state with no shared memory remembers, oldest dropped first: 256, as `DoubleMatch`
 * keeps per key, at about 200 bytes each 51 KB per state. A state made by `CapcodeWindows` holds one.
 */
export const POCSAG_FIRST_HEARD_MAX = 256

/**
 * The all-zero-word addresses' run, for one multimon decoder: one timestamp and one counter, whichever
 * of the 8 addresses it hears. `CapcodeWindows` holds it across its windows, since those last the hold
 * plus 4 s and a run outlasts them. A decode inside the gap proves the decodes before it were a run,
 * so `pairKey` moves on and an earlier decode no longer pairs with anything.
 *
 * Its memory ends with the decoder: a run met by two separate short probes gives each its own first
 * decode, and those two can pair. Telling them apart needs a run heard across the gap between probes.
 */
export class PocsagLowRun {
	private lastAt: number | null = null
	private voided = 0

	/** Records one decode, whatever becomes of it; true when the quiet gap came before it. */
	note(at: number): boolean {
		if (!Number.isFinite(at)) return false
		const quiet =
			this.lastAt === null || at - this.lastAt >= POCSAG_LOW_QUIET_MS
		this.lastAt = at
		if (!quiet) this.voided++
		return quiet
	}

	/** The pairing key of a decode heard now; every key past the first is empty until used. */
	pairKey(key: string): string {
		return this.voided === 0 ? key : `${key}#${this.voided}`
	}
}

/** A state's own run, for a state not under `CapcodeWindows`. */
const ownRuns = new WeakMap<InterpreterState, PocsagLowRun>()
/** First occurrences on a state with no shared memory (`pairPocsag`). */
const firstHeard = new WeakMap<InterpreterState, Map<string, number>>()

/**
 * Whether this POCSAG decode completes a pair under `pairKey`, marking `capcode` accepted under `key`.
 * The shared memory measures separation itself. With none (a replay, a pool without one) it is measured
 * here on the decode's own time: closer than `CONFIRM_MIN_SEPARATION_MS` counts once and keeps the
 * earlier time, as the memory does, and one older than `CONFIRM_WINDOW_MS` is replaced by this decode.
 */
function pairPocsag(
	state: InterpreterState,
	key: string,
	pairKey: string,
	capcode: string,
	at: number,
	again: boolean,
): boolean {
	if (state.match.scope() !== null) {
		if (!state.match.accept(pairKey, capcode, true, again)) return false
		if (pairKey !== key) state.match.markAccepted(key, capcode)
		return true
	}
	let heard = firstHeard.get(state)
	if (heard === undefined) {
		heard = new Map()
		firstHeard.set(state, heard)
	}
	const id = `${pairKey}\u0000${capcode}`
	const first = heard.get(id)
	if (first === undefined || at - first > CONFIRM_WINDOW_MS) {
		heard.delete(id)
		heard.set(id, at)
		if (heard.size > POCSAG_FIRST_HEARD_MAX) {
			const oldest = heard.keys().next()
			if (oldest.done !== true) heard.delete(oldest.value)
		}
		return false
	}
	if (!(at - first >= CONFIRM_MIN_SEPARATION_MS)) return false
	heard.delete(id)
	state.match.markAccepted(key, capcode)
	return state.match.isAccepted(key, capcode)
}

function payloadPlausible(
	message: string,
	minChars: number = MIN_PAYLOAD_CHARS,
): boolean {
	let controls = 0
	let textControls = 0
	const stripped = message.replace(CONTROL_TOKEN, (_token, name: string) => {
		if (TEXT_CONTROLS.has(name)) textControls++
		else controls++
		return ""
	})
	let printable = textControls
	let chars = 0
	for (const ch of stripped) {
		chars++
		const code = ch.codePointAt(0) ?? 0
		if (code >= 0x20 && code <= 0x7e) printable++
	}
	const total = chars + controls + textControls
	return total >= minChars && printable / total >= MIN_PRINTABLE_RATIO
}

/** Padding after an alpha body: it is no text, and it must neither fill the length nor fail the ratio. */
const TRAILING_PAD = /(?:<(?:NUL|ETX|EOT)>)+$/

/** Whether a POCSAG body is one chance does not print (`POCSAG_BODY_MIN_CHARS`). */
function pocsagBodyReal(
	type: string | undefined,
	message: string | undefined,
): boolean {
	if (type !== "alpha" && type !== "numeric") return false
	const body = (message ?? "").replace(TRAILING_PAD, "")
	if (!payloadPlausible(body, POCSAG_BODY_MIN_CHARS)) return false
	if (type === "alpha") return true
	let good = 0
	for (const ch of body) if (POCSAG_NUMERIC_CHARS.test(ch)) good++
	return good / body.length >= POCSAG_NUMERIC_MIN_RATIO
}

/**
 * Whether an accepted capcode still names this decode on its own: its last refreshed decode is at
 * most `CONFIRM_WINDOW_MS` (5 min) old, the window a pair is made in. Older, the decode is one decode
 * again and needs its pair or a page, as dsd-fme's identities do: acceptance itself never ages, but a
 * capcode accepted once, maybe from two chance syncs, must not let any later false line identify.
 * With no shared memory the age is null: that acceptance lives no longer than its decoder, so it
 * always counts.
 *
 * Only a decode that would count without the acceptance refreshes the age: a real body
 * (`pocsagBodyReal`, outside `requirePair`) or a fresh pair (2 s to 5 min after the decode before
 * it, see `ConfirmMemory`). A lone decode counted by age alone leaves the age where it was, or one
 * line within each 5 min would keep a false capcode alive for ever; it is still recorded, so the
 * next decode can pair with it. A beacon about every 60 s pairs on each decode and stays fresh.
 */
function acceptanceAge(
	state: InterpreterState,
	key: string,
	capcode: string,
): { counts: boolean; shared: boolean } {
	const age = state.match.acceptedAgeMs(key, capcode)
	return {
		counts: age === null || age <= CONFIRM_WINDOW_MS,
		shared: age !== null,
	}
}

export function interpretMultimon(
	out: DecoderOutputLike,
	state: InterpreterState,
	lowRun?: PocsagLowRun,
): DecodeEvidence[] {
	if (out.type !== "message") return []
	const parsed = PagerSchema.safeParse(out.data)
	if (!parsed.success) return []
	const d = parsed.data
	let protocol: "pocsag" | "flex"
	let capcode: string | undefined
	let plausible: boolean
	let zeroWord = false
	if (/^POCSAG\d+$/i.test(d.protocol)) {
		protocol = "pocsag"
		capcode = d.address !== undefined ? String(d.address) : undefined
		const fn = d.function
		const type = d.messageType?.toLowerCase()
		plausible =
			fn !== undefined && fn >= 0 && fn <= 3 && pocsagBodyReal(type, d.message)
		zeroWord =
			d.address !== undefined &&
			d.address < POCSAG_ZERO_WORD_ADDRESSES &&
			fn === 0
	} else if (d.protocol.toUpperCase() === "FLEX") {
		protocol = "flex"
		const raw = d.capcode?.trim()
		capcode = raw !== undefined && raw !== "" ? raw : undefined
		const type = d.messageType?.toUpperCase()
		plausible =
			(type === "ALN" || type === "NUM") && payloadPlausible(d.message ?? "")
	} else return []
	if (capcode === undefined) return []
	const key = `${protocol}:cap`
	const at = out.timestamp.getTime()
	let run: PocsagLowRun | undefined
	let quiet = true
	if (zeroWord) {
		run = lowRun ?? ownRuns.get(state)
		if (run === undefined) {
			run = new PocsagLowRun()
			ownRuns.set(state, run)
		}
		quiet = run.note(at)
	}
	const accepted = state.match.isAccepted(key, capcode)
	const age = accepted ? acceptanceAge(state, key, capcode) : undefined
	if (age?.counts === true) {
		// A stuck slicer's run stays a run after acceptance: only a decode after the quiet gap counts.
		if (zeroWord && !plausible && !quiet) return []
		if (age.shared) {
			if (plausible && !state.requirePair)
				state.match.touchAccepted(key, capcode)
			else if (protocol === "flex") state.match.accept(key, capcode, true, true)
			else {
				// A pair marks `key` accepted again, which restarts its age; a lone decode does not.
				const pairKey = run && !plausible ? run.pairKey(key) : key
				pairPocsag(state, key, pairKey, capcode, at, true)
			}
		}
	} else if (plausible && !state.requirePair) {
		state.match.markAccepted(key, capcode)
	} else if (protocol === "flex") {
		if (!state.match.accept(key, capcode, true, accepted)) return []
	} else if (zeroWord && !plausible && !quiet) return []
	else {
		const pairKey = run && !plausible ? run.pairKey(key) : key
		if (!pairPocsag(state, key, pairKey, capcode, at, accepted)) return []
	}
	return [
		{
			...evidenceBase(state, at),
			protocol,
			identity: { kind: "pocsag-capcode", value: capcode },
			metadata: { capcodes: [capcode] },
		},
	]
}
