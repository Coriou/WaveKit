import type { Obj } from "../../data/guards.js"
import type { FormattedMessage } from "../../data/types.js"
import { asObj, finish, num, obj, seg, str } from "./common.js"

const positive = (x: number | undefined): number | undefined =>
	x !== undefined && x > 0 ? x : undefined

/**
 * Frequency in Hz: `frequency` (ACARSMessage, VDL2Message), `vdl2.freq` (raw dumpvdl2),
 * else MHz `freq`. dumpvdl2 sends 0 when it does not know (R44): 0 falls through,
 * and "?" means a frequency was sent but none is usable.
 */
function frequencyHz(o: Obj): number | "?" | undefined {
	const hz =
		positive(num(o, "frequency")) ?? positive(num(obj(o, "vdl2"), "freq"))
	if (hz !== undefined) return hz
	const mhz = positive(num(o, "freq"))
	if (mhz !== undefined) return mhz * 1e6
	const sent =
		num(o, "frequency") !== undefined ||
		num(obj(o, "vdl2"), "freq") !== undefined ||
		num(o, "freq") !== undefined
	return sent ? "?" : undefined
}

const mhzText = (hz: number): string => `${(hz / 1e6).toFixed(3)} MHz`
const freqSegment = (hz: number | "?" | undefined) =>
	typeof hz === "number" ? [seg(mhzText(hz), 4)] : []
const freqField = (hz: number | "?" | undefined): FormattedMessage["fields"] =>
	hz === undefined
		? []
		: [{ label: "frequency", value: hz === "?" ? "?" : mhzText(hz) }]

/** Server default strings ("unknown", "Unknown") are unknown values (R44). */
const known = (s: string | undefined): string | undefined =>
	s !== undefined && /^unknown$/i.test(s.trim()) ? "?" : s

interface AcarsParts {
	reg: string | undefined
	flight: string | undefined
	label: string | undefined
	text: string | undefined
}

function acarsParts(a: Obj): AcarsParts {
	return {
		reg: str(a, "tail") ?? str(a, "reg"),
		flight: str(a, "flight")?.trim(),
		label: str(a, "label"),
		text: str(a, "text") ?? str(a, "msg_text") ?? str(a, "message"),
	}
}

function acarsFields(p: AcarsParts): FormattedMessage["fields"] {
	return [
		...(p.reg ? [{ label: "reg", value: p.reg }] : []),
		...(p.flight ? [{ label: "flight", value: p.flight }] : []),
		...(p.label ? [{ label: "label", value: p.label }] : []),
	]
}

/** acarsdec emits type "acars" with ACARSMessage (frequency in Hz). */
export function formatAcars(
	data: unknown,
	decoderId: string,
	type: string,
): FormattedMessage {
	const o = asObj(data)
	const p = acarsParts(o)
	const hz = frequencyHz(o)
	const segments = [
		...(p.reg ? [seg(p.reg, 0)] : []),
		...(p.flight ? [seg(p.flight, 1)] : []),
		...(p.label ? [seg(p.label, 2)] : []),
		...freqSegment(hz),
	]
	const fields = [...acarsFields(p), ...freqField(hz)]
	return finish(
		decoderId,
		type,
		"ACARS",
		"aircraft",
		segments,
		fields,
		p.text !== undefined ? { text: p.text } : {},
	)
}

/** dumpvdl2 emits type "vdl2" with VDL2Message: ICAO, msgType, frequency (Hz) and an optional embedded ACARS message. */
export function formatVdl2(
	data: unknown,
	decoderId: string,
	type: string,
): FormattedMessage {
	const o = asObj(data)
	const embedded = obj(o, "acars")
	const raw = obj(obj(obj(o, "vdl2"), "avlc"), "acars")
	const a = Object.keys(embedded).length > 0 ? embedded : raw
	const p = acarsParts(a)
	const hasAcars = Object.keys(a).length > 0
	const icao = str(o, "icao")?.toUpperCase()
	const msgType = known(str(o, "msgType"))
	const station = str(o, "station")
	const hz = frequencyHz(o)
	const text = p.text ?? str(o, "text")
	const segments = [
		...(p.reg ? [seg(p.reg, 0)] : icao ? [seg(icao, 0)] : []),
		...(p.flight ? [seg(p.flight, 1)] : []),
		...(p.label ? [seg(p.label, 2)] : []),
		...(!hasAcars && msgType && msgType !== "?" ? [seg(msgType, 3)] : []),
		...freqSegment(hz),
	]
	const fields: FormattedMessage["fields"] = [
		...(icao ? [{ label: "icao", value: icao }] : []),
		...acarsFields(p),
		...(msgType ? [{ label: "type", value: msgType }] : []),
		...(station ? [{ label: "station", value: station }] : []),
		...freqField(hz),
	]
	return finish(
		decoderId,
		type,
		"VDL2",
		"aircraft",
		segments,
		fields,
		text !== undefined ? { text } : {},
	)
}
