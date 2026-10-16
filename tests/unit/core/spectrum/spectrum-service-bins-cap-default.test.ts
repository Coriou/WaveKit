// Feature: web-gaps-8, Property 13: Default profile unchanged
// Validates: Requirements 5.4, 5.5
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import type { SpectrumBinsCapView } from "@wavekit/api-types"
import {
	GOLDEN_OPTIONS,
	SAMPLED_RUNS,
	optionArb,
	runScenario,
	type MakeOptions,
} from "./spectrum-service-bins-cap-harness.js"
import golden from "./fixtures/spectrum-service-bins-cap-golden.json" with { type: "json" }

/* ---- frozenNormalise: verbatim from git show 30f17b43:src/core/spectrum/spectrum-averaging.ts ---- */
const PROFILE_LIMITS = {
	hz: { min: 0.5, max: 25, step: 0.5 },
	bins: { min: 128, max: 2048 },
	averaging: { min: 1, max: 32 },
} as const
interface FrozenProfile {
	key: string
	hz: number
	bins: number
	averaging?: number
}
const clamp = (v: number, min: number, max: number): number =>
	Math.min(max, Math.max(min, v))

/** 1 = off. Absent means off. */
function averagingOf(profile: { averaging?: number }): number {
	return profile.averaging ?? 1
}

/** `${hz}:${bins}` when off; `${hz}:${bins}:a${n}` otherwise. The off form is the CLI guard. */
function profileKey(hz: number, bins: number, averaging = 1): string {
	return averaging > 1 ? `${hz}:${bins}:a${averaging}` : `${hz}:${bins}`
}

function makeProfile(hz: number, bins: number, averaging = 1): FrozenProfile {
	const n = averaging > 1 ? averaging : 1
	return {
		key: profileKey(hz, bins, n),
		hz,
		bins,
		...(n > 1 ? { averaging: n } : {}),
	}
}

/**
 * Omitted fields take the fallback unchanged. Given hz/bins/averaging are snapped and clamped;
 * `adjusted` names each one that changed.
 */
function frozenNormalise(
	req: {
		hz?: number | undefined
		bins?: number | undefined
		averaging?: number | undefined
	},
	fallback: FrozenProfile,
): { profile: FrozenProfile; adjusted: string[] } {
	const adjusted: string[] = []
	let hz = fallback.hz
	let bins = fallback.bins
	let averaging = averagingOf(fallback)
	if (req.hz !== undefined) {
		const { min, max, step } = PROFILE_LIMITS.hz
		hz = clamp(Math.round(req.hz / step) * step, min, max)
		if (hz !== req.hz) adjusted.push("hz")
	}
	if (req.bins !== undefined) {
		const { min, max } = PROFILE_LIMITS.bins
		bins = clamp(Math.round(req.bins), min, max)
		if (bins !== req.bins) adjusted.push("bins")
	}
	if (req.averaging !== undefined) {
		const { min, max } = PROFILE_LIMITS.averaging
		averaging = clamp(Math.round(req.averaging), min, max)
		if (averaging !== req.averaging) adjusted.push("averaging")
	}
	return { profile: makeProfile(hz, bins, averaging), adjusted }
}

/* ---- end verbatim ---- */

const view = (cap: number, source: SpectrumBinsCapView["source"] = "config") =>
	({ setting: cap, cap, source }) as SpectrumBinsCapView
const roundTrip = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
const DEF: FrozenProfile = { key: "10:512", hz: 10, bins: 512 }

interface GoldenEntry {
	options: unknown
	logged: unknown
	live: unknown
	status: { limits: Record<string, unknown> }
}
interface SampledEntry {
	options: unknown
	logged: unknown
	live: unknown
}
const fixture = golden as unknown as {
	fixed: GoldenEntry[]
	sampled: SampledEntry[]
}
const entries = fixture.fixed

describe("bins cap: default profile unchanged (golden from 30f17b43)", () => {
	it("the golden covers the fixed option list with live frames", () => {
		expect(entries).toHaveLength(GOLDEN_OPTIONS.length)
		expect(entries.length).toBeGreaterThanOrEqual(40)
		for (const e of entries)
			if (
				(e.logged as { ack?: { profile?: unknown } } | undefined)?.ack?.profile
			)
				expect((e.live as unknown[]).length).toBeGreaterThan(0)
	})

	it("absent dep: every golden subscribe, frame and the status are identical", async () => {
		for (const [i, options] of GOLDEN_OPTIONS.entries()) {
			const got = roundTrip(await runScenario({ summaryBins: 2048 }, options))
			const { options: _o, ...want } = entries[i]!
			expect(got, JSON.stringify(options)).toEqual(want)
			expect(Object.keys(got.status.limits)).not.toContain("binsCap")
		}
	}, 60_000)

	it("cap dep with the default 2048 budget: golden equal except limits.binsCap", async () => {
		for (const cap of [2048, 4096, 8192]) {
			for (const [i, options] of GOLDEN_OPTIONS.entries()) {
				const got = roundTrip(
					await runScenario(
						{ summaryBins: 2048, binsCap: () => view(cap) },
						options,
					),
				)
				const want = roundTrip(entries[i]!) as GoldenEntry
				expect(got.logged, `${cap} ${JSON.stringify(options)}`).toEqual(
					want.logged,
				)
				expect(got.live).toEqual(want.live)
				const { binsCap, ...limits } = got.status
					.limits as unknown as unknown as Record<string, unknown>
				expect(binsCap).toEqual(view(cap))
				expect(limits).toEqual(want.status.limits)
			}
		}
	}, 60_000)

	const capArb = fc.constantFrom<number | null>(null, 2048, 4096, 8192)

	it("frozen oracle: sampled options give the 30f17b43 ack, snapshots, backfill and live frames under every cap", async () => {
		expect(fixture.sampled).toHaveLength(SAMPLED_RUNS)
		const caps = [null, 2048, 4096, 8192] as const
		for (const [i, entry] of fixture.sampled.entries()) {
			const cap = caps[i % caps.length]!
			const base: MakeOptions = { summaryBins: 2048 }
			const got = roundTrip(
				await runScenario(
					cap === null ? base : { ...base, binsCap: () => view(cap) },
					entry.options,
				),
			)
			expect(got.logged, `${cap} ${JSON.stringify(entry.options)}`).toEqual(
				entry.logged,
			)
			expect(got.live).toEqual(entry.live)
			expect((got.live as unknown[]).length).toBeGreaterThan(0)
		}
	}, 60_000)

	/*
	 * Property 13 frames: the frozen code cannot run here, so frames are pinned in two steps.
	 * (1) The frozen oracle above (and the fixed golden) captured ack, snapshot, backfill and live
	 * frames at 30f17b43 for 140 option sets spanning every clamp branch; the current dep-absent
	 * and dep-present paths must reproduce them exactly. (2) For each random option here, frames
	 * with the dep equal frames with the dep absent, and the served profile, adjusted list and
	 * backfill normalisation equal the frozen normaliser's; frames are a function of exactly
	 * that (profile, backfillMs) and the identical summary feed, which (1) pins against 30f17b43.
	 */
	it("Property 13: random options and caps with budget 2048 equal the frozen behaviour", async () => {
		await fc.assert(
			fc.asyncProperty(optionArb, capArb, async (opt, cap) => {
				const options = { sourceId: "rtl", ...opt }
				const base: MakeOptions = { summaryBins: 2048 }
				const plain = roundTrip(await runScenario(base, options))
				const withCap = roundTrip(
					await runScenario(
						cap === null ? base : { ...base, binsCap: () => view(cap) },
						options,
					),
				)
				expect(withCap.logged).toEqual(plain.logged)
				expect(withCap.live).toEqual(plain.live)
				expect((withCap.live as unknown[]).length).toBeGreaterThan(0)
				const { binsCap, ...limits } = withCap.status
					.limits as unknown as unknown as Record<string, unknown>
				expect(limits).toEqual(plain.status.limits)
				expect("binsCap" in withCap.status.limits).toBe(cap !== null)
				if (cap !== null) expect(binsCap).toEqual(view(cap))
				// profile and adjusted against the frozen normaliser (bins and hz and averaging)
				const want = frozenNormalise(options, DEF)
				const ack = withCap.logged!.ack
				expect(ack.profile).toMatchObject({
					hz: want.profile.hz,
					bins: want.profile.bins,
				})
				expect(
					ack.adjusted.filter(
						a => a === "bins" || a === "hz" || a === "averaging",
					),
				).toEqual(want.adjusted)
			}),
			{ numRuns: 150 },
		)
	}, 60_000)
})
