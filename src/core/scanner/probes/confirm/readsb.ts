/**
 * readsb ambient interpreter: Mode S / ADS-B at 1090 MHz, the 24-bit ICAO address as identity.
 *
 * Beast evidence proves CRC locally. SBS/JSON aircraft records instead inherit readsb's
 * validation policy: they do NOT prove an uncorrected CRC here. SBS confirmation uses
 * validated source timestamps and distinct source-line identities, never receipt time.
 * JSON snapshots require cumulative count advancement and source-time spacing.
 * Upstream CRC correction/address acceptance is outside this parser's guarantee; only use
 * configured, trusted local readsb output, never arbitrary feeders as receiver evidence.
 */
import {
	CONFIRM_MIN_SEPARATION_MS,
	CONFIRM_WINDOW_MS,
} from "./confirm-memory.js"
import { z } from "zod"
import type { DecoderOutputLike } from "./double-match.js"
import { asRecord, nearTarget } from "./ambient-decode.js"
import type { AmbientInterpretCtx, AmbientParsed } from "./ambient-decode.js"

/** The Mode S downlink frequency (ICAO Annex 10 Vol IV): 1090 MHz. */
export const ADSB_HZ = 1_090_000_000

/** Exactly 6 hex digits; anything longer is refused before it is read. */
const IcaoSchema = z
	.string()
	.max(6)
	.regex(/^[0-9A-Fa-f]{6}$/)

/** A Beast frame is at most 14 bytes: 28 hex digits. */
const ModeSSchema = z.object({
	df: z.number().int().min(0).max(31),
	crcOk: z.boolean(),
	frame: z
		.string()
		.max(28)
		.regex(/^[0-9a-f]+$/)
		.optional(),
})

const StateSchema = z.object({
	messageCount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
	lastSeen: z
		.union([z.date(), z.string().datetime()])
		.transform(v => new Date(v).getTime()),
	jsonSourceTimestamp: z
		.union([z.date(), z.string().datetime()])
		.transform(v => new Date(v).getTime())
		.optional(),
	sbsSourceTimestamp: z
		.union([z.date(), z.string().datetime()])
		.transform(v => new Date(v).getTime())
		.optional(),
	sbsContentId: z
		.string()
		.length(64)
		.regex(/^[0-9a-f]{64}$/)
		.optional(),
	readsbFormat: z.enum(["sbs", "json"]).optional(),
})

const ChannelSchema = z.object({
	channelHz: z.number().finite().positive(),
})

/** Pure parse step: no acceptance memory is touched (null: no evidence). */
export function parseReadsb(
	out: DecoderOutputLike,
	ctx: AmbientInterpretCtx,
): AmbientParsed | null {
	if (out.type !== "aircraft") return null
	const data = asRecord(out.data)
	if (data === undefined) return null
	const icao = IcaoSchema.safeParse(data["icao"])
	if (!icao.success) return null
	const modeS = data["modeS"]
	let frame: string | undefined
	let readsbState: AmbientParsed["readsbState"]
	if (modeS !== undefined) {
		const parsed = ModeSSchema.safeParse(modeS)
		if (!parsed.success || !parsed.data.crcOk) return null
		frame = parsed.data.frame
	} else {
		const state = StateSchema.safeParse(data)
		if (!state.success) return null
		const snapshot = state.data.readsbFormat === "json"
		if (
			snapshot &&
			(state.data.messageCount <= 1 ||
				state.data.jsonSourceTimestamp === undefined)
		)
			return null
		if (
			!snapshot &&
			(state.data.sbsSourceTimestamp === undefined ||
				state.data.sbsContentId === undefined)
		)
			return null
		readsbState = {
			messageCount: state.data.messageCount,
			lastSeen: snapshot
				? state.data.jsonSourceTimestamp!
				: state.data.sbsSourceTimestamp!,
			...(!snapshot ? { contentId: state.data.sbsContentId! } : {}),
			snapshot,
		}
	}
	const placed = ChannelSchema.safeParse(out.provenanceBinding)
	const hz = placed.success ? placed.data.channelHz : ADSB_HZ
	if (!nearTarget(hz, ctx.targetsHz)) return null
	return {
		hz,
		timestamp: out.timestamp,
		protocol: "adsb",
		crcClean: true,
		...(readsbState !== undefined ? { readsbState } : {}),
		...(frame !== undefined ? { frame } : {}),
		identity: {
			key: "adsb:icao",
			kind: "icao",
			value: icao.data.toLowerCase(),
		},
	}
}

/** At most 4096 ICAOs, matching the existing raw-frame/accepted identity bounds. */
export const READSB_STATES_MAX = 4096

/** Per decoder/source epoch; a replayed record never advances acceptance. */
export class ReadsbStateMemory {
	private readonly records = new Map<
		string,
		{
			at: number
			messageCount: number
			lastSeen: number
			snapshot: boolean
			contentId?: string
		}
	>()

	get size(): number {
		return this.records.size
	}

	accept(p: AmbientParsed): boolean {
		const state = p.readsbState
		const address = p.identity.value
		const at = state?.lastSeen
		if (!state || !address || at === undefined || !Number.isFinite(at))
			return false
		const previous = this.records.get(address)
		const reset =
			!previous ||
			at < previous.at ||
			at - previous.at > CONFIRM_WINDOW_MS ||
			state.messageCount < previous.messageCount ||
			state.snapshot !== previous.snapshot
		if (!reset) {
			const advanced = state.snapshot
				? state.messageCount > previous.messageCount
				: state.contentId !== previous.contentId &&
					state.lastSeen > previous.lastSeen
			if (!advanced || at - previous.at < CONFIRM_MIN_SEPARATION_MS)
				return false
		}
		this.records.delete(address)
		this.records.set(address, { at, ...state })
		if (this.records.size > READSB_STATES_MAX) {
			const oldest = this.records.keys().next()
			if (!oldest.done) this.records.delete(oldest.value)
		}
		return !reset
	}
}
