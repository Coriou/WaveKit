// The band plan half of the core's decoderCoversHz (src/api/routes/decoder-summary.ts), shared by the tuned card's
// status fallback and the mock's summary so the two cannot drift: which band plan protocols a decoder type decodes,
// and whether a plan range at a frequency lists one of them, and which configured targets are fixed. Pure.
import type { DecoderInfo, ScanRange } from "@wavekit/api-types"

/**
 * The core's DECODER_PROTOCOLS (src/decoders/enablement/contract.ts): the band plan protocols a decoder type
 * decodes. Types without an entry have a fixed band of their own. web/tests/features/decoder-protocols.test.ts
 * holds the two equal.
 */
export const DECODER_PROTOCOLS: Readonly<Record<string, readonly string[]>> = {
	"dsd-fme": [
		"dmr",
		"p25p1",
		"p25p2",
		"ysf",
		"dstar",
		"nxdn48",
		"nxdn96",
		"dpmr",
	],
	"multimon-ng": ["pocsag", "flex"],
}

/** The band plan protocols `type` decodes; empty for a type with a fixed band. */
export function protocolsOf(type: string): readonly string[] {
	return Object.hasOwn(DECODER_PROTOCOLS, type) ? DECODER_PROTOCOLS[type]! : []
}

/** True when a plan range holding `hz` lists one of `type`'s protocols (the core's planListsAt over `ranges`). */
export function planListsHz(
	type: string,
	ranges: readonly Pick<ScanRange, "startHz" | "endHz" | "protocols">[],
	hz: number,
): boolean {
	if (!Number.isFinite(hz) || hz <= 0) return false
	const protocols = protocolsOf(type)
	if (protocols.length === 0) return false
	return ranges.some(
		r =>
			hz >= r.startHz &&
			hz <= r.endHz &&
			(r.protocols ?? []).some(p => protocols.includes(p)),
	)
}

/**
 * The core's VFO_CHANNEL_TYPES (src/decoders/enablement/placement.ts): single-channel audio types, whose
 * "configured" channel sits on the VFO or the source centre when no channel is configured.
 * web/tests/features/decoder-protocols.test.ts holds the two equal.
 */
export const VFO_CHANNEL_TYPES: readonly string[] = [
	"dsd-fme",
	"multimon-ng",
	"direwolf",
	"acarsdec",
]

const positive = (n: unknown): n is number =>
	typeof n === "number" && Number.isFinite(n) && n > 0

/**
 * The core's fixedTargetsHz (src/api/routes/decoder-summary.ts): the configured targets that do not just follow
 * the tuner. Without placements, every positive target; with only fixed placements of a wideband type, the same;
 * otherwise only the channels of band, band plan and activity placements (and a wideband type's configured ones).
 * A VFO, fallback or centre-reach placement, or a single-channel audio type's configured channel, never counts.
 */
export function fixedTargetsHz(
	d: Pick<DecoderInfo, "type" | "targetFrequenciesHz" | "placements">,
): number[] {
	const declared = Array.isArray(d.targetFrequenciesHz)
		? d.targetFrequenciesHz.filter(positive)
		: []
	const placements = Array.isArray(d.placements) ? d.placements : []
	if (placements.length === 0) return declared
	const audio = VFO_CHANNEL_TYPES.includes(d.type)
	const fixed = (p: (typeof placements)[number]): boolean =>
		p != null &&
		p.reach !== "centre" &&
		(p.origin === "band" ||
			p.origin === "bandplan" ||
			p.origin === "activity" ||
			(p.origin === "configured" && !audio))
	if (!audio && placements.every(fixed)) return declared
	return placements
		.filter(fixed)
		.flatMap(p => (positive(p.channelHz) ? [p.channelHz] : []))
}
