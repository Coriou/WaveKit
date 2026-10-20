/**
 * Identify regression snapshots, updated for scanner redesign 6.7/6.9:
 * narrow analog eligibility, nonzero priors, explicit requests, and evidence-only labels.
 * WAVEKIT_WRITE_IDENTIFY_GOLDENS=1 refreshes the snapshots locally.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
	identifyScores,
	planIdentifyTrials,
} from "../../../../src/core/scanner/identify.js"
import type { ScannerProtocol } from "../../../../src/core/scanner/types.js"
import type { TrackSnapshot } from "../../../../src/core/spectrum/types.js"
import { trackOf } from "../../../mocks/scanner/identify-fakes.js"

const FIXTURE = join(
	dirname(fileURLToPath(import.meta.url)),
	"identify-narrow-digital-goldens.json",
)

const OBWS = [3000, 5500, 7000, 9000, 11_000, 12_500, 16_000, 20_000]
const SHAPES: TrackSnapshot["spectralShape"][] = ["flat", "peaked"]
const EXTRAS: Partial<TrackSnapshot>[] = [
	{},
	{ acf30: -0.94, acf60: 0.99 },
	{ blocks: 3, flags: { ...trackOf().flags, burst: true } },
]
const PRIORS: Partial<Record<ScannerProtocol, number>>[] = [
	{},
	{ dmr: 0 },
	{ nxdn48: 0, dpmr: 2, dstar: 0.5 },
]
const PROTOCOLS: ScannerProtocol[][] = [[], ["dmr", "nxdn48", "dstar"]]

function cases() {
	const out: {
		key: string
		track: TrackSnapshot
		priors: Partial<Record<ScannerProtocol, number>>
		protocols: ScannerProtocol[]
	}[] = []
	for (const obwHz of OBWS)
		for (const spectralShape of SHAPES)
			EXTRAS.forEach((extra, e) =>
				PRIORS.forEach((priors, p) =>
					PROTOCOLS.forEach((protocols, q) =>
						out.push({
							key: `${obwHz}/${spectralShape}/${e}/${p}/${q}`,
							track: trackOf({ obwHz, spectralShape, ...extra }),
							priors,
							protocols,
						}),
					),
				),
			)
	return out
}

function compute(narrow: boolean | undefined): Record<string, unknown> {
	const out: Record<string, unknown> = {}
	for (const c of cases()) {
		const scores = identifyScores(c.track, {
			priors: c.priors,
			protocols: c.protocols,
			...(narrow !== undefined ? { narrow } : {}),
		})
		out[c.key] = {
			scores,
			offset: planIdentifyTrials(scores, {
				format: "U8_IQ",
				channelizer: false,
			}),
		}
	}
	return out
}

describe("identify plan goldens (WG11 1.3/1.7 absent dep)", () => {
	if (process.env["WAVEKIT_WRITE_IDENTIFY_GOLDENS"] === "1") {
		it("records the plans", () => {
			writeFileSync(FIXTURE, `${JSON.stringify(compute(undefined))}\n`)
		})
		return
	}
	const golden = JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<
		string,
		unknown
	>
	it("covers every case", () => {
		expect(Object.keys(golden)).toHaveLength(cases().length)
	})
	it("no narrow flag: matches evidence-bound scores and plans", () => {
		expect(compute(undefined)).toEqual(golden)
	})
	it("narrow false: matches evidence-bound scores and plans", () => {
		expect(compute(false)).toEqual(golden)
	})
})
