import { RTL_TUNER_GAIN_TABLES, RTL_TUNER_NAMES } from "@wavekit/api-types"
import { z } from "zod"
import type {
	ReceiverCapabilities,
	ReceiverGainTable,
	ReceiverHeaderEvidence,
	ReceiverSourceDescription,
	RtlTunerName,
} from "@wavekit/api-types"

/** librtlsdr reports the single placeholder 0 for these tuner types (unknown, FC2580). */
const NO_TABLE_TUNER_TYPES: readonly number[] = Object.freeze([0, 4])

/**
 * WG7 req 5.1-5.3: the cited librtlsdr gain list of the advertised tuner, matched on the
 * item's own current peer header only (no cache across sessions). Constant work; the
 * suggested values are the frozen array itself. Every unknown input fails to a reason.
 */
export function gainTableFor(
	peerHeader: ReceiverHeaderEvidence,
	transport: ReceiverSourceDescription["type"],
): ReceiverGainTable {
	if (transport !== "rtl_tcp")
		return { state: "not-applicable", reason: "non-rtl-transport" }
	if (peerHeader.state !== "advertised")
		return { state: "unknown", reason: "header-not-advertised" }
	const { tunerType, gainCount } = peerHeader
	if (NO_TABLE_TUNER_TYPES.includes(tunerType))
		return { state: "unknown", reason: "no-gain-table" }
	const entry = Object.hasOwn(RTL_TUNER_GAIN_TABLES, tunerType)
		? RTL_TUNER_GAIN_TABLES[tunerType]
		: undefined
	if (entry === undefined)
		return { state: "unknown", reason: "unlisted-tuner-type" }
	if (gainCount !== entry.valuesTenthsDb.length)
		return { state: "unknown", reason: "gain-count-mismatch" }
	return {
		state: "suggested",
		provenance: "librtlsdr-tuner-gains",
		tuner: entry.tuner,
		valuesTenthsDb: entry.valuesTenthsDb,
	}
}

const TUNER_NAMES = RTL_TUNER_NAMES as unknown as readonly [
	RtlTunerName,
	...RtlTunerName[],
]

const listedTables = Object.values(RTL_TUNER_GAIN_TABLES).filter(
	entry => entry !== undefined,
)

function sameValues(
	left: readonly number[],
	right: readonly number[],
): boolean {
	return left.length === right.length && left.every((v, i) => v === right[i])
}

/** Zod item schema: a suggested table is exactly the frozen table of the named tuner. */
export const receiverGainTableSchema = z.union([
	z
		.object({
			state: z.literal("suggested"),
			provenance: z.literal("librtlsdr-tuner-gains"),
			tuner: z.enum(TUNER_NAMES),
			valuesTenthsDb: z.array(z.number().int().safe()).max(29),
		})
		.strict()
		.refine(value =>
			listedTables.some(
				entry =>
					entry.tuner === value.tuner &&
					sameValues(entry.valuesTenthsDb, value.valuesTenthsDb),
			),
		),
	z
		.object({
			state: z.literal("unknown"),
			reason: z.enum([
				"header-not-advertised",
				"unlisted-tuner-type",
				"gain-count-mismatch",
				"no-gain-table",
			]),
		})
		.strict(),
	z
		.object({
			state: z.literal("not-applicable"),
			reason: z.literal("non-rtl-transport"),
		})
		.strict(),
])

/** Coherence (failure is CONFLICT): the item's table equals the one its own header derives. */
export function gainTableCoherent(
	item: Pick<ReceiverCapabilities, "source" | "peerHeader" | "gainTable">,
): boolean {
	const table = item.gainTable
	if (table === undefined) return false
	const expected = gainTableFor(item.peerHeader, item.source.type)
	if (expected.state !== table.state) return false
	if (expected.state === "suggested")
		return (
			table.state === "suggested" &&
			table.provenance === expected.provenance &&
			table.tuner === expected.tuner &&
			sameValues(table.valuesTenthsDb, expected.valuesTenthsDb)
		)
	return table.state !== "suggested" && table.reason === expected.reason
}
