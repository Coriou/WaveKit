import type { FormattedMessage } from "../../data/types.js"
import { asObj, finish, num, obj, seg, str } from "./common.js"

/** Ported heuristic from decoded-message.tsx: 5 % per CRC/FEC error. */
function qualityPercent(errors: number): number {
	return Math.max(0, 100 - Math.min(errors * 5, 100))
}

/** "p25p1" → "P25 P1" (the label decoded-message.tsx intended); others upper-cased. */
function protocolLabel(p: string | undefined): string {
	if (p === undefined) return "VOICE"
	const m = /^p25p(\d)$/i.exec(p)
	return m ? `P25 P${m[1] ?? ""}` : p.toUpperCase()
}

/** Calls without a call_* type (older dsd-fme output) still carry talkgroup or source. */
export function isCallShape(data: unknown): boolean {
	const o = asObj(data)
	return num(o, "talkgroup") !== undefined || num(o, "source") !== undefined
}

export function formatCall(
	data: unknown,
	decoderId: string,
	type: string,
): FormattedMessage {
	const o = asObj(data)
	const protocol = protocolLabel(str(o, "protocol"))
	const tg = num(o, "talkgroup")
	const src = num(o, "source")
	const slot = num(o, "slot")
	const duration = num(o, "duration")
	const cc = num(obj(o, "dmr"), "cc")
	const nac = str(obj(o, "p25"), "nac")
	const ran = num(obj(o, "nxdn"), "ran")
	const my = str(obj(o, "dstar"), "my")?.trim()
	const ur = str(obj(o, "dstar"), "ur")?.trim()
	const q = o["quality"]
	const quality = obj(o, "quality")
	const errors = (num(quality, "crcErrs") ?? 0) + (num(quality, "fecErrs") ?? 0)
	const flags = obj(o, "flags")
	const isEnd = type === "call_end"
	const isStart = type === "call_start"
	const segments = [
		...(tg !== undefined && tg !== 0 ? [seg(`TG ${tg}`, 0)] : []),
		...(src !== undefined && src !== 0 ? [seg(`SRC ${src}`, 1)] : []),
		...(slot !== undefined ? [seg(`slot ${slot}`, 4)] : []),
		...(cc !== undefined ? [seg(`CC ${cc}`, 5)] : []),
		...(nac ? [seg(`NAC ${nac}`, 5)] : []),
		...(ran !== undefined ? [seg(`RAN ${ran}`, 5)] : []),
		...(my ? [seg(`MY ${my}`, 3)] : []),
		...(ur ? [seg(`UR ${ur}`, 4)] : []),
		...(isStart ? [seg("call start", 2)] : []),
		...(duration !== undefined
			? [seg(`${(duration / 1000).toFixed(1)} s`, 2)]
			: []),
		...(isEnd && q !== undefined
			? [seg(`quality ${qualityPercent(errors)}%`, 3)]
			: []),
		...(errors > 0 ? [seg(`${errors} err`, 3)] : []),
		...(flags["encrypted"] === true ? [seg("encrypted", 1)] : []),
		...(flags["badSignal"] === true ? [seg("bad signal", 3)] : []),
		...(flags["timeout"] === true ? [seg("timeout", 4)] : []),
	]
	const wav = str(o, "wavFile")
	const fields: FormattedMessage["fields"] = [
		...(tg !== undefined ? [{ label: "talkgroup", value: String(tg) }] : []),
		...(src !== undefined ? [{ label: "source", value: String(src) }] : []),
		...(slot !== undefined ? [{ label: "slot", value: String(slot) }] : []),
		...(cc !== undefined ? [{ label: "colour code", value: String(cc) }] : []),
		...(nac ? [{ label: "nac", value: nac }] : []),
		...(ran !== undefined ? [{ label: "ran", value: String(ran) }] : []),
		...(my ? [{ label: "my", value: my }] : []),
		...(ur ? [{ label: "ur", value: ur }] : []),
		...(duration !== undefined
			? [{ label: "duration", value: `${(duration / 1000).toFixed(1)} s` }]
			: []),
		...(q !== undefined
			? [
					{
						label: "errors",
						value: `${errors} (crc ${num(quality, "crcErrs") ?? "?"}, fec ${num(quality, "fecErrs") ?? "?"})`,
					},
				]
			: []),
		...(wav ? [{ label: "wav", value: wav.split("/").pop() ?? wav }] : []),
	]
	return finish(decoderId, type, protocol, "voice", segments, fields)
}
