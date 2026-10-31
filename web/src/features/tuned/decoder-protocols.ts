// The band plan half of the core's decoderCoversHz (src/api/routes/decoder-summary.ts), shared by the tuned card's
// status fallback and the mock's summary so the two cannot drift: which band plan protocols a decoder type decodes,
// and whether a plan range at a frequency lists one of them. Pure.
import type { ScanRange } from "@wavekit/api-types"

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
