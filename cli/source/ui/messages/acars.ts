import type { Obj } from "../../data/guards.js"
import type { FormattedMessage } from "../../data/types.js"
import { asObj, finish, num, obj, seg, str } from "./common.js"

/** Frequency in Hz: `frequency` (ACARSMessage, VDL2Message), `vdl2.freq` (raw dumpvdl2), else MHz `freq`. */
function frequencyHz(o: Obj): number | undefined {
	const hz = num(o, "frequency") ?? num(obj(o, "vdl2"), "freq")
	if (hz !== undefined) return hz
	const mhz = num(o, "freq")
	return mhz !== undefined ? mhz * 1e6 : undefined
}

const mhzText = (hz: number): string => `${(hz / 1e6).toFixed(3)} MHz`

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
		...(hz !== undefined ? [seg(mhzText(hz), 4)] : []),
	]
	const fields = [
		...acarsFields(p),
		...(hz !== undefined ? [{ label: "frequency", value: mhzText(hz) }] : []),
	]
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
	const msgType = str(o, "msgType")
	const station = str(o, "station")
	const hz = frequencyHz(o)
	const text = p.text ?? str(o, "text")
	const segments = [
		...(p.reg ? [seg(p.reg, 0)] : icao ? [seg(icao, 0)] : []),
		...(p.flight ? [seg(p.flight, 1)] : []),
		...(p.label ? [seg(p.label, 2)] : []),
		...(!hasAcars && msgType ? [seg(msgType, 3)] : []),
		...(hz !== undefined ? [seg(mhzText(hz), 4)] : []),
	]
	const fields: FormattedMessage["fields"] = [
		...(icao ? [{ label: "icao", value: icao }] : []),
		...acarsFields(p),
		...(msgType ? [{ label: "type", value: msgType }] : []),
		...(station ? [{ label: "station", value: station }] : []),
		...(hz !== undefined ? [{ label: "frequency", value: mhzText(hz) }] : []),
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
