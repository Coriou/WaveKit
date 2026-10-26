/**
 * multimon-ng confirm interpreter (spec § 6.4): a POCSAG/FLEX capcode is accepted on two decodes
 * with the same capcode, or on one decode whose payload is plausible.
 */
import { z } from "zod"
import type { DecodeEvidence } from "../../types.js"
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

function payloadPlausible(message: string): boolean {
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
	return total >= MIN_PAYLOAD_CHARS && printable / total >= MIN_PRINTABLE_RATIO
}

export function interpretMultimon(
	out: DecoderOutputLike,
	state: InterpreterState,
): DecodeEvidence[] {
	if (out.type !== "message") return []
	const parsed = PagerSchema.safeParse(out.data)
	if (!parsed.success) return []
	const d = parsed.data
	let protocol: "pocsag" | "flex"
	let capcode: string | undefined
	let plausible: boolean
	if (/^POCSAG\d+$/i.test(d.protocol)) {
		protocol = "pocsag"
		capcode = d.address !== undefined ? String(d.address) : undefined
		const fn = d.function
		const type = d.messageType?.toLowerCase()
		plausible =
			fn !== undefined &&
			fn >= 0 &&
			fn <= 3 &&
			(type === "alpha" || type === "numeric") &&
			payloadPlausible(d.message ?? "")
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
	// once accepted, every later decode of the capcode is evidence again (ambient refreshes lastConfirm)
	if (!state.match.isAccepted(key, capcode)) {
		if (plausible && !state.requirePair) state.match.markAccepted(key, capcode)
		else if (!state.match.accept(key, capcode, true)) return []
	}
	return [
		{
			...evidenceBase(state, out.timestamp.getTime()),
			protocol,
			identity: { kind: "pocsag-capcode", value: capcode },
			metadata: { capcodes: [capcode] },
		},
	]
}
