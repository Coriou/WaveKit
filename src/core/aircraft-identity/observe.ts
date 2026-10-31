/**
 * Turns decoder output into identity observations: pairs of identifiers that one decoded frame
 * carried together. Nothing here guesses: a pair is recorded only when both identifiers are in
 * the same frame and the decoder vouched for the frame.
 */
import { z } from "zod"
import type { DecoderOutput } from "../../decoders/types.js"
import type { AircraftIdentifier } from "@wavekit/api-types"
import {
	canonicalIcao,
	canonicalRegistration,
} from "../activity/presentation/budget.js"
import type { IdentityObservation } from "./registry.js"

const text = z.string().nullish()

const adsbSchema = z
	.object({
		icao: z.string(),
		callsign: text,
		modeS: z
			.object({ df: z.number(), crcOk: z.boolean() })
			.passthrough()
			.optional(),
	})
	.passthrough()
const acarsSchema = z
	.object({
		tail: text,
		flight: text,
		error: z.number().optional(),
		/** WaveKit's mapped flag (dumpvdl2's embedded ACARS) and the raw decoder field. */
		crcOk: z.boolean().optional(),
		crc_ok: z.boolean().optional(),
	})
	.passthrough()

/** A frame links identifiers only without bit errors and without a failed CRC. */
function acarsClean(acars: z.infer<typeof acarsSchema>): boolean {
	return (
		(acars.error ?? 0) === 0 && acars.crcOk !== false && acars.crc_ok !== false
	)
}

/**
 * Cheap shape check before any Zod parse: this runs for every decoder output, and a
 * frame that is not an object, or lacks the one string field a pair needs, can carry no
 * pair. Only plausible frames pay for the full parse.
 */
function record(v: unknown): Record<string, unknown> | null {
	return typeof v === "object" && v !== null
		? (v as Record<string, unknown>)
		: null
}
const isText = (v: unknown) => typeof v === "string"
const vdl2Schema = z
	.object({
		icao: text,
		acars: acarsSchema.nullish(),
	})
	.passthrough()

/** ICAO 24-bit address, upper-case hex. */
export function icaoId(
	raw: string | null | undefined,
): AircraftIdentifier | null {
	if (raw === null || raw === undefined) return null
	const value = canonicalIcao(raw)
	return value === null ? null : { kind: "icao", value }
}

/** Registration without ACARS padding dots, two to ten letters, digits or dashes. */
export function regId(
	raw: string | null | undefined,
): AircraftIdentifier | null {
	if (raw === null || raw === undefined) return null
	const value = canonicalRegistration(raw)
	if (value === null || !/^[A-Z0-9-]{2,10}$/.test(value)) return null
	return { kind: "reg", value }
}

function codeId(
	kind: "callsign" | "flight",
	raw: string | null | undefined,
): AircraftIdentifier | null {
	if (raw === null || raw === undefined) return null
	const value = raw.trim().toUpperCase()
	if (!/^[A-Z0-9]{2,8}$/.test(value)) return null
	return { kind, value }
}

/** Mode S formats whose address is proven by a CRC that leaves remainder 0. */
function addressProven(
	modeS: { df: number; crcOk: boolean } | undefined,
): boolean {
	if (modeS === undefined) return true // SBS and JSON lines: readsb validated them
	return modeS.crcOk && (modeS.df === 11 || modeS.df === 17 || modeS.df === 18)
}

function pair(
	a: AircraftIdentifier | null,
	b: AircraftIdentifier | null,
	source: IdentityObservation["source"],
	at: Date,
): IdentityObservation[] {
	if (a === null || b === null) return []
	return [{ a, b, evidence: "observed", source, at }]
}

/** The identity pairs one decoder output carried. Empty for anything else. */
export function observationsFrom(output: DecoderOutput): IdentityObservation[] {
	const type = output.type
	if (type !== "aircraft" && type !== "vdl2" && type !== "acars") return []
	const data = record(output.data)
	if (data === null) return []
	const at = output.timestamp
	if (type === "aircraft") {
		if (!isText(data["icao"]) || !isText(data["callsign"])) return []
		const parsed = adsbSchema.safeParse(output.data)
		if (!parsed.success || !addressProven(parsed.data.modeS)) return []
		return pair(
			icaoId(parsed.data.icao),
			codeId("callsign", parsed.data.callsign),
			"adsb",
			at,
		)
	}
	if (type === "vdl2") {
		const embedded = record(data["acars"])
		if (!isText(data["icao"]) || embedded === null) return []
		if (!isText(embedded["tail"]) && !isText(embedded["flight"])) return []
		const parsed = vdl2Schema.safeParse(output.data)
		if (!parsed.success) return []
		const acars = parsed.data.acars
		if (acars === null || acars === undefined || !acarsClean(acars)) return []
		const icao = icaoId(parsed.data.icao)
		return [
			...pair(icao, regId(acars.tail), "vdl2", at),
			...pair(icao, codeId("flight", acars.flight), "vdl2", at),
		]
	}
	// type === "acars"
	if (!isText(data["tail"]) || !isText(data["flight"])) return []
	const parsed = acarsSchema.safeParse(output.data)
	if (!parsed.success || !acarsClean(parsed.data)) return []
	return pair(
		regId(parsed.data.tail),
		codeId("flight", parsed.data.flight),
		"acars",
		at,
	)
}
