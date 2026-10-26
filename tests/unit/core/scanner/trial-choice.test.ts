/** pager classification, replay extras behind capability, trial memory, pending capture. */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { builtinBandplansFor } from "../../../../src/core/bandplans/builtin-supplement.js"
import {
	classHypotheses,
	classifySpectral,
	familyOf,
	inPagerRange,
} from "../../../../src/core/scanner/classify/classifier.js"
import {
	isPagerTonePair,
	refineChannelClassification,
} from "../../../../src/core/scanner/classify/channel-tier.js"
import type { ChannelFeatureEvidence } from "../../../../src/core/scanner/classify/channel-features.js"
import {
	narrowestPriors,
	PAGER_UHF_RANGE,
	withScannerOverlays,
} from "../../../../src/core/scanner/classify/priors.js"
import {
	IQ_CAPTURE_PER_SOURCE_PER_MINUTE,
	IQ_REPLAY_MAX_TRIALS,
	type IqCaptureView,
	type IqReplayPlanInput,
} from "../../../../src/core/scanner/iq-capture-contract.js"
import {
	PENDING_CAPTURE_MAX_SOURCES,
	PENDING_CAPTURE_WINDOW_MS,
	PENDING_CAPTURES_PER_SOURCE_PER_MINUTE,
	PendingCaptureLimiter,
} from "../../../../src/core/scanner/pending-capture.js"
import {
	ADSB_REPLAY_HIGH_HZ,
	ADSB_REPLAY_LOW_HZ,
	planReplayTrials,
	planReplayTrialsDetailed,
} from "../../../../src/core/scanner/replay-plan.js"
import {
	orderTrialsByMemory,
	parseTrialMemory,
	TRIAL_BACKOFF_BASE_MS,
	TRIAL_BACKOFF_MAX_MS,
	TRIAL_MEMORY_COUNT_MAX,
	TRIAL_MEMORY_FILE,
	TRIAL_MEMORY_FILE_MAX_BYTES,
	TRIAL_MEMORY_MAX_DISCOVERIES,
	TRIAL_MEMORY_MAX_TRIALS,
	TrialMemory,
	trialBackoffMs,
	type TrialMemoryEntry,
} from "../../../../src/core/scanner/trial-memory.js"
import type { ScannerClass } from "../../../../src/core/scanner/types.js"
import { makeTrack } from "../../../mocks/scanner/observations.js"

// Synthetic frequencies only: a pager channel inside the overlay span, a land-mobile one outside.
const PAGER_HZ = 466_100_000
const LAND_MOBILE_HZ = 455_000_000
const EU = withScannerOverlays(builtinBandplansFor("EU").flatMap(p => p.ranges))

function pagerPriors(): ReturnType<typeof narrowestPriors> {
	return narrowestPriors(EU, PAGER_HZ)
}

function pagerTrack(obwHz: number, flat = true) {
	const t = makeTrack({
		id: "p",
		centreHz: PAGER_HZ,
		startedAt: 0,
		obwHz,
		blocks: 8,
	})
	return flat ? t : { ...t, spectralShape: "peaked" as const }
}

describe("pager classification (part 1)", () => {
	it("the EU UHF paging overlay is the narrowest range at a pager channel and lists pocsag and flex", () => {
		expect(PAGER_UHF_RANGE.endHz - PAGER_UHF_RANGE.startHz).toBe(575_000)
		// 466.4 MHz lies in the overlay part outside the French plan
		const p = narrowestPriors(EU, 466_400_000)
		expect(p.pocsag).toBe(1)
		expect(p.flex).toBe(1)
		expect(p.dmr).toBe(1)
		expect(pagerPriors().pocsag).toBe(1)
		expect(inPagerRange(p)).toBe(true)
		expect(inPagerRange(narrowestPriors(EU, LAND_MOBILE_HZ))).toBe(false)
		// edges inclusive, one hertz past is outside
		expect(narrowestPriors(EU, PAGER_UHF_RANGE.startHz).pocsag).toBe(1)
		expect(narrowestPriors(EU, PAGER_UHF_RANGE.startHz - 1).pocsag).not.toBe(1)
		expect(narrowestPriors(EU, PAGER_UHF_RANGE.endHz).pocsag).toBe(1)
		expect(narrowestPriors(EU, PAGER_UHF_RANGE.endHz + 1).pocsag).not.toBe(1)
		// a non-EU plan set has no overlay
		expect(
			withScannerOverlays(
				builtinBandplansFor("JP").flatMap(p => p.ranges),
			).some(r => r.bandplanId === "pager-uhf"),
		).toBe(false)
	})

	it("the French paging plan is in the built-in catalogue and the overlay never overlaps it", () => {
		const fr = builtinBandplansFor("EU").find(p => p.id === "pager-fr")
		expect(fr?.ranges.map(r => [r.startHz, r.endHz])).toEqual([
			[466_025_000, 466_230_000],
			[446_526_250, 446_538_750],
		])
		const pagers = EU.filter(
			r => r.bandplanId === "pager-fr" || r.bandplanId === "pager-uhf",
		)
		for (const a of pagers)
			for (const b of pagers)
				if (a !== b)
					expect(a.endHz < b.startHz || b.endHz < a.startHz).toBe(true)
		// overlay parts stop 1 Hz short of the plan's edges
		expect(
			EU.some(r => r.bandplanId === "pager-uhf" && r.endHz === 466_024_999),
		).toBe(true)
		expect(
			EU.some(r => r.bandplanId === "pager-uhf" && r.startHz === 466_230_001),
		).toBe(true)
		// hiding pager-fr brings the whole overlay back
		const hidden = withScannerOverlays(
			builtinBandplansFor("EU")
				.filter(p => p.id !== "pager-fr")
				.flatMap(p => p.ranges),
		).filter(r => r.bandplanId === "pager-uhf")
		expect(hidden.map(r => [r.startHz, r.endHz])).toEqual([
			[PAGER_UHF_RANGE.startHz, PAGER_UHF_RANGE.endHz],
		])
		// 446.5325 MHz: the single pager channel, edges inclusive
		expect(narrowestPriors(EU, 446_532_500).pocsag).toBe(1)
		expect(narrowestPriors(EU, 446_538_750).pocsag).toBe(1)
		expect(narrowestPriors(EU, 446_538_751).pocsag).not.toBe(1)
	})

	it.each([466_100_000, 446_532_500])(
		"a synthetic POCSAG discovery at %i Hz plans POCSAG first",
		hz => {
			const track = makeTrack({
				id: "p",
				centreHz: hz,
				startedAt: 0,
				obwHz: 9000,
				blocks: 8,
			})
			const order = planReplayTrials({
				capture: { ...capture, rfHz: hz },
				track,
				knownProtocol: null,
				priors: narrowestPriors(EU, hz),
				narrowRaster: true,
			}).map(t => t.protocol)
			expect(order).toEqual([
				"pocsag",
				"analog-fm",
				"dmr",
				"aprs",
				"dpmr",
				"nxdn48",
				"nxdn96",
			])
		},
	)

	it.each([
		["fsk2-wide", 12_000, true],
		["fsk4-12k5", 9_000, true],
		["analog-fm", 12_000, false],
	] as const)(
		"%s in a paging range yields pager hypotheses ahead of DMR",
		(cls, obw, flat) => {
			const r = classifySpectral(pagerTrack(obw, flat), {
				priors: pagerPriors(),
				protocols: [],
			})
			expect(r.class).toBe(cls)
			const order = r.hypotheses.map(h => h.protocol)
			expect(familyOf(order[0]!)).toBe("pager")
			const dmr = order.indexOf("dmr")
			if (dmr >= 0) {
				expect(order.indexOf("pocsag")).toBeLessThan(dmr)
				expect(order.indexOf("flex")).toBeLessThan(dmr)
			}
		},
	)

	it("outside a paging range the class hypotheses are unchanged", () => {
		const priors = narrowestPriors(EU, LAND_MOBILE_HZ)
		for (const cls of ["fsk4-12k5", "analog-fm"] as ScannerClass[])
			expect(classHypotheses(cls, priors).map(h => h.protocol)).not.toContain(
				"pocsag",
			)
		expect(classHypotheses("fsk4-12k5", {})[0]?.protocol).toBe("dmr")
		// malformed priors: the safe answer is today's list
		expect(
			classHypotheses("fsk4-12k5", { pocsag: Number.NaN })[0]?.protocol,
		).toBe("dmr")
	})

	// Feature: trial-choice, Property 1: pager first in a paging range
	// Validates: Requirements 9.1
	it("property: any pager-class track inside the span ranks a pager protocol first", () => {
		fc.assert(
			fc.property(
				fc.integer({
					min: PAGER_UHF_RANGE.startHz,
					max: PAGER_UHF_RANGE.endHz,
				}),
				fc.constantFrom<ScannerClass>("fsk2-wide", "fsk4-12k5", "analog-fm"),
				(hz, cls) => {
					const priors = narrowestPriors(EU, hz)
					const first = classHypotheses(cls, priors)
						.map(h => ({ ...h, score: h.score * (priors[h.protocol] ?? 1) }))
						.sort((a, b) => b.score - a.score)[0]
					return first !== undefined && familyOf(first.protocol) === "pager"
				},
			),
			{ numRuns: 200 },
		)
	})

	function twoTone(low: number, high: number): ChannelFeatureEvidence {
		return {
			kind: "evidence",
			sampleCount: 24_000,
			onSamples: 24_000,
			durationMs: 500,
			onDurationMs: 500,
			discriminator: {
				histogram: new Array<number>(128).fill(0),
				binWidthHz: 187.5,
				centerOffsetHz: 0,
				peaksHz: [low, high],
				peakStdHz: [200, 200],
				peakSpacingHz: [high - low],
				deviationHz: Math.max(Math.abs(low), Math.abs(high)),
				stdHz: 4500,
				voiceBandFraction: 0.05,
			},
			afsk: { kind: "absent", markFraction: 0, spaceFraction: 0 },
			ctcss: { kind: "absent" },
			symbolRate: { kind: "absent" },
		}
	}
	const spectral = {
		class: "fsk4-12k5" as const,
		hypotheses: [{ protocol: "dmr" as const, score: 0.55 }],
		tier: "spectral" as const,
	}

	it("a 2-tone FSK with about 9 kHz spacing is fsk2-wide (pager), never digital voice", () => {
		for (const [low, high] of [
			[-4500, 4500],
			[-3500, 5500], // 1 kHz tuning error
			[-3750, 3750], // spacing 7 500 (edge)
			[-5250, 5250], // spacing 10 500 (edge)
			[-3000, 6000], // midpoint 1 500 (edge)
		] as const) {
			const r = refineChannelClassification(spectral, twoTone(low, high), {
				priors: pagerPriors(),
				protocols: [],
				rfTrusted: true,
				obwHz: 12_000,
			})
			expect(r.kind).toBe("refined")
			if (r.kind !== "refined") continue
			expect(r.classification.class).toBe("fsk2-wide")
			expect(familyOf(r.classification.hypotheses[0]!.protocol)).toBe("pager")
			expect(
				r.classification.hypotheses.some(
					h => familyOf(h.protocol) === "digital-voice",
				),
			).toBe(false)
		}
	})

	it("the tone-pair window: at and just past each bound", () => {
		expect(isPagerTonePair(-3750, 3750)).toBe(true)
		expect(isPagerTonePair(-3749, 3750)).toBe(false) // spacing 7 499
		expect(isPagerTonePair(-5250, 5250)).toBe(true)
		expect(isPagerTonePair(-5251, 5250)).toBe(false) // spacing 10 501
		expect(isPagerTonePair(-3000, 6000)).toBe(true)
		expect(isPagerTonePair(-2998, 6002)).toBe(false) // midpoint 1 502
		expect(isPagerTonePair(Number.NaN, 4500)).toBe(false)
	})
})

const capture: IqCaptureView = {
	captureId: "c1",
	sourceId: "rtl",
	observationId: "o_1",
	epoch: 1,
	rfHz: PAGER_HZ,
	tuningTrust: "commanded",
	capturedAtMs: 1_000_000,
	durationMs: 3000,
	gapSamples: 0,
}

function pocsagInput(over: Partial<IqReplayPlanInput> = {}): IqReplayPlanInput {
	return {
		capture,
		track: pagerTrack(9000),
		knownProtocol: null,
		priors: pagerPriors(),
		narrowRaster: true,
		...over,
	}
}

const label = (i: IqReplayPlanInput): string[] =>
	planReplayTrials(i).map(t => `${t.protocol}:${t.mode.decoderType}`)

describe("replay extras behind a capability check (part 2)", () => {
	it("ISM calls rtl433, skipped today (no probe mode), even with the capability", () => {
		const ism: IqReplayPlanInput = {
			capture: { ...capture, rfHz: 868_300_000 },
			track: null,
			knownProtocol: null,
			priors: narrowestPriors(EU, 868_300_000),
			narrowRaster: false,
		}
		for (const caps of [
			undefined,
			new Set(["dsd-fme", "multimon-ng", "direwolf", "rtl433"]),
		]) {
			const out = planReplayTrialsDetailed(ism, caps)
			expect(out.trials.some(t => t.mode.decoderType === "rtl433")).toBe(false)
			expect(out.skipped).toContainEqual({
				protocol: "ism",
				decoder: "rtl433",
				reason: "no-probe-mode",
			})
		}
		// a decoder outside the capability set never runs, even with a probe mode
		const none = planReplayTrialsDetailed(pocsagInput(), new Set<string>())
		expect(none.trials.every(t => t.kind === "analog")).toBe(true)
	})

	it.each([
		["acars", "acarsdec"],
		["vdl2", "dumpvdl2"],
		["lora", "lora-meshtastic"],
		["ais", "ais-catcher"],
	] as const)(
		"a known %s discovery calls %s, skipped (no probe mode)",
		(protocol, decoder) => {
			const out = planReplayTrialsDetailed(
				pocsagInput({ knownProtocol: protocol, track: null, priors: {} }),
			)
			expect(out.skipped).toContainEqual({
				protocol,
				decoder,
				reason: "no-probe-mode",
			})
			expect(
				out.trials.every(t => String(t.mode.decoderType) !== decoder),
			).toBe(true)
		},
	)

	it("readsb is called at 1090 MHz ± 1 MHz inclusive and not 1 Hz past", () => {
		const at = (rfHz: number) =>
			planReplayTrialsDetailed({
				capture: { ...capture, rfHz },
				track: null,
				knownProtocol: null,
				priors: {},
				narrowRaster: false,
			}).skipped.some(s => s.decoder === "readsb")
		expect(at(ADSB_REPLAY_LOW_HZ)).toBe(true)
		expect(at(ADSB_REPLAY_HIGH_HZ)).toBe(true)
		expect(at(ADSB_REPLAY_LOW_HZ - 1)).toBe(false)
		expect(at(ADSB_REPLAY_HIGH_HZ + 1)).toBe(false)
	})

	// Feature: trial-choice, Property 2: extras never run without capability
	// Validates: Requirements 9.2
	it("property: every ISM-868 plan names rtl433 (planned or skipped) and never runs it without capability", () => {
		fc.assert(
			fc.property(fc.integer({ min: 863_000_000, max: 870_000_000 }), hz => {
				const out = planReplayTrialsDetailed({
					capture: { ...capture, rfHz: hz },
					track: null,
					knownProtocol: null,
					priors: narrowestPriors(EU, hz),
					narrowRaster: false,
				})
				return (
					out.skipped.some(s => s.decoder === "rtl433") &&
					out.trials.every(t => t.mode.decoderType !== "rtl433") &&
					out.trials.length <= IQ_REPLAY_MAX_TRIALS
				)
			}),
			{ numRuns: 100 },
		)
	})
})

function entry(over: Partial<TrialMemoryEntry>): TrialMemoryEntry {
	return {
		protocol: "pocsag",
		decoder: "multimon-ng",
		attempts: 1,
		decoded: 1,
		consecutiveFailures: 0,
		lastOutcome: "decoded",
		lastAt: 0,
		lastDecodedAt: 0,
		...over,
	}
}

describe("trial memory order (part 3)", () => {
	it("a synthetic POCSAG discovery: the trial order before and after", () => {
		// Before (the frozen plans, no overlay, no memory): POCSAG is the last trial.
		// the plans before the French plan: no French plan, no overlay
		const legacy = narrowestPriors(
			builtinBandplansFor("EU")
				.filter(p => p.id !== "pager-fr")
				.flatMap(p => p.ranges),
			PAGER_HZ,
		)
		expect(label(pocsagInput({ priors: legacy }))).toEqual([
			"analog-fm:dsd-fme",
			"dmr:dsd-fme",
			"nxdn48:dsd-fme",
			"nxdn96:dsd-fme",
			"aprs:direwolf",
			"dpmr:dsd-fme",
			"pocsag:multimon-ng",
		])
		// After (overlay): POCSAG first, the analog trial after it.
		expect(label(pocsagInput())).toEqual([
			"pocsag:multimon-ng",
			"analog-fm:dsd-fme",
			"dmr:dsd-fme",
			"aprs:direwolf",
			"dpmr:dsd-fme",
			"nxdn48:dsd-fme",
			"nxdn96:dsd-fme",
		])
		// Memory alone also fixes the legacy order: a remembered POCSAG success leads and
		// remembered DMR failures in backoff are left out.
		const now = capture.capturedAtMs
		const dmrFail: TrialMemoryEntry = {
			protocol: "dmr",
			decoder: "dsd-fme",
			attempts: 3,
			decoded: 0,
			consecutiveFailures: 3,
			lastOutcome: "no-sync",
			lastAt: now - 1000,
		}
		const memory = [
			entry({ lastAt: now - 1000, lastDecodedAt: now - 1000 }),
			dmrFail,
		]
		const after = label(
			pocsagInput({ priors: legacy, trialMemory: memory, nowMs: now }),
		)
		expect(after[0]).toBe("pocsag:multimon-ng")
		expect(after).not.toContain("dmr:dsd-fme")
		expect(after).not.toContain("p25p1:dsd-fme")
		// out of backoff (3 failures: 240 s) the dsd-fme auto run returns, last; in backoff no
		// sibling protocol of that run (D-STAR, P25) brings it back
		const autoRun = (nowMs: number) =>
			planReplayTrials(
				pocsagInput({ priors: legacy, trialMemory: memory, nowMs }),
			).findIndex(
				t =>
					t.mode.decoderType === "dsd-fme" && t.mode.options["mode"] === "auto",
			)
		const len = planReplayTrials(
			pocsagInput({
				priors: legacy,
				trialMemory: memory,
				nowMs: now + 240_000,
			}),
		).length
		expect(autoRun(now - 1000 + 240_000)).toBe(len - 1)
		expect(autoRun(now - 1000 + 239_999)).toBe(-1)
	})

	it("tiers: success, prior order (no failures), untried, failures out of backoff; all-in-backoff keeps every trial", () => {
		const t = (protocol: string, known = false) => ({
			protocol: protocol as TrialMemoryEntry["protocol"],
			decoder: "d",
			known,
		})
		const trials = [t("dmr"), t("ysf"), t("p25p1"), t("pocsag"), t("flex")]
		const m = (protocol: string, over: Partial<TrialMemoryEntry>) =>
			entry({
				protocol: protocol as TrialMemoryEntry["protocol"],
				decoder: "d",
				...over,
			})
		const out = orderTrialsByMemory(
			trials,
			[
				m("flex", { lastDecodedAt: 5 }),
				m("dmr", {
					decoded: 0,
					consecutiveFailures: 1,
					lastOutcome: "no-sync",
					lastAt: 0,
				}),
				m("p25p1", {
					decoded: 0,
					consecutiveFailures: 0,
					lastOutcome: "timeout",
				}),
			],
			TRIAL_BACKOFF_BASE_MS, // dmr's 60 s backoff just ended
		).map(x => x.protocol)
		expect(out).toEqual(["flex", "p25p1", "ysf", "pocsag", "dmr"])
		const allBack = orderTrialsByMemory(
			[t("dmr")],
			[
				m("dmr", {
					decoded: 0,
					consecutiveFailures: 1,
					lastOutcome: "no-sync",
					lastAt: 0,
				}),
			],
			TRIAL_BACKOFF_BASE_MS - 1,
		)
		expect(allBack.map(x => x.protocol)).toEqual(["dmr"])
		expect(orderTrialsByMemory(trials, null, 0)).toEqual(trials)
	})

	it("backoff arithmetic: 60 s doubling, capped at 3 600 s from 7 failures", () => {
		expect(trialBackoffMs(0)).toBe(0)
		expect(trialBackoffMs(1)).toBe(60_000)
		expect(trialBackoffMs(2)).toBe(120_000)
		expect(trialBackoffMs(6)).toBe(1_920_000)
		expect(trialBackoffMs(7)).toBe(TRIAL_BACKOFF_MAX_MS)
		expect(trialBackoffMs(1e9)).toBe(TRIAL_BACKOFF_MAX_MS)
		expect(trialBackoffMs(Number.NaN)).toBe(0)
	})
})

describe("trial memory store (part 3)", () => {
	it("counts attempts, ignores non-attempts and bad input", () => {
		let now = 10
		const mem = new TrialMemory({ now: () => now })
		expect(mem.record("d1", "pocsag", "multimon-ng", "no-sync")).toBe(true)
		now = 20
		expect(mem.record("d1", "pocsag", "multimon-ng", "decoded")).toBe(true)
		for (const o of [
			"cancelled",
			"pending",
			"unsupported",
			"skipped-budget",
			"not-needed",
			"x",
		])
			expect(mem.record("d1", "pocsag", "multimon-ng", o)).toBe(false)
		expect(mem.record("", "pocsag", "m", "decoded")).toBe(false)
		expect(mem.record("d".repeat(129), "pocsag", "m", "decoded")).toBe(false)
		expect(mem.view("d1")).toEqual([
			{
				protocol: "pocsag",
				decoder: "multimon-ng",
				attempts: 2,
				decoded: 1,
				consecutiveFailures: 0,
				lastOutcome: "decoded",
				lastAt: 20,
				lastDecodedAt: 20,
			},
		])
	})

	it("bounds: 16 trials per discovery, 2 048 discoveries (least recently updated goes)", () => {
		const mem = new TrialMemory({ now: () => 1 })
		for (let i = 0; i <= TRIAL_MEMORY_MAX_TRIALS; i++)
			mem.record("d", "dmr", `dec-${i}`, "no-sync")
		const v = mem.view("d")
		expect(v).toHaveLength(TRIAL_MEMORY_MAX_TRIALS)
		expect(v[0]?.decoder).toBe("dec-1")
		for (let i = 0; i < TRIAL_MEMORY_MAX_DISCOVERIES; i++)
			mem.record(`x${i}`, "dmr", "dsd-fme", "no-sync")
		expect(mem.size).toBe(TRIAL_MEMORY_MAX_DISCOVERIES)
		expect(mem.view("d")).toEqual([])
		mem.record("x0", "dmr", "dsd-fme", "no-sync")
		mem.record("new", "dmr", "dsd-fme", "no-sync")
		expect(mem.size).toBe(TRIAL_MEMORY_MAX_DISCOVERIES)
		expect(mem.view("x0")).toHaveLength(1)
		expect(mem.view("x1")).toEqual([])
	})

	it("counters saturate at 1 000 000", () => {
		const raw = {
			version: 1,
			discoveries: {
				d: [
					entry({
						attempts: TRIAL_MEMORY_COUNT_MAX,
						decoded: 0,
						consecutiveFailures: TRIAL_MEMORY_COUNT_MAX,
						lastOutcome: "no-sync",
					}),
				],
			},
		}
		const parsed = parseTrialMemory(raw).get("d")
		expect(parsed?.[0]?.attempts).toBe(TRIAL_MEMORY_COUNT_MAX)
		const over = structuredClone(raw)
		over.discoveries.d[0]!.attempts = TRIAL_MEMORY_COUNT_MAX + 1
		expect(parseTrialMemory(over).size).toBe(0)
	})

	it("one malformed discovery never discards the others", () => {
		for (const bad of [null, 5, "x", {}, [{ protocol: 1 }]]) {
			const out = parseTrialMemory({
				version: 1,
				discoveries: { good: [entry({})], bad },
			})
			expect(out.get("good")).toHaveLength(1)
			expect(out.has("bad")).toBe(false)
		}
		const longId = "d".repeat(129)
		const out = parseTrialMemory({
			version: 1,
			discoveries: { good: [entry({})], [longId]: [entry({})] },
		})
		expect([...out.keys()]).toEqual(["good"])
	})

	it("Zod on load: corrupt files and rows are ignored, good rows load", () => {
		expect(parseTrialMemory(null).size).toBe(0)
		expect(parseTrialMemory({ version: 2, discoveries: {} }).size).toBe(0)
		expect(parseTrialMemory({ version: 1, discoveries: [] }).size).toBe(0)
		const mixed = parseTrialMemory({
			version: 1,
			discoveries: {
				a: [entry({}), { protocol: "x" }, entry({ decoded: 5, attempts: 1 })],
				b: ["junk"],
			},
		})
		expect(mixed.get("a")).toHaveLength(1)
		expect(mixed.has("b")).toBe(false)
	})

	// Feature: trial-choice, Property 3: corrupt trial memory never throws
	// Validates: Requirements 9.3
	it("property: parse never throws and never exceeds its bounds", () => {
		fc.assert(
			fc.property(fc.anything(), raw => {
				const out = parseTrialMemory({
					version: 1,
					discoveries: { a: [raw, raw] },
				})
				parseTrialMemory(raw)
				return [...out.values()].every(l => l.length <= TRIAL_MEMORY_MAX_TRIALS)
			}),
			{ numRuns: 200 },
		)
	})

	it("persists through a file, ignores a corrupt or oversized file", async () => {
		const dir = await mkdtemp(join(tmpdir(), "wk-trial-memory-"))
		try {
			const a = new TrialMemory({ dir, now: () => 5 })
			await a.load()
			a.record("d1", "pocsag", "multimon-ng", "decoded")
			await a.flush()
			const b = new TrialMemory({ dir, now: () => 6 })
			await b.load()
			expect(b.view("d1")[0]?.decoded).toBe(1)
			await writeFile(join(dir, TRIAL_MEMORY_FILE), "{not json")
			const c = new TrialMemory({ dir, now: () => 7 })
			await c.load()
			expect(c.size).toBe(0)
			await writeFile(
				join(dir, TRIAL_MEMORY_FILE),
				Buffer.alloc(TRIAL_MEMORY_FILE_MAX_BYTES + 1, 32),
			)
			const d = new TrialMemory({ dir, now: () => 8 })
			await d.load()
			expect(d.size).toBe(0)
			// forget writes too
			b.forget("d1")
			await b.flush()
			expect(
				JSON.parse(await readFile(join(dir, TRIAL_MEMORY_FILE), "utf8")),
			).toEqual({
				version: 1,
				discoveries: {},
			})
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})
})

describe("pending capture share (part 4)", () => {
	it("2 per source per rolling minute, leaving 4 of the port's 6 for admitted tracks", () => {
		expect(
			IQ_CAPTURE_PER_SOURCE_PER_MINUTE - PENDING_CAPTURES_PER_SOURCE_PER_MINUTE,
		).toBe(4)
		let now = 0
		const l = new PendingCaptureLimiter(() => now)
		expect(l.take("s")).toBe(true)
		expect(l.take("s")).toBe(true)
		expect(l.take("s")).toBe(false)
		now = PENDING_CAPTURE_WINDOW_MS - 1
		expect(l.take("s")).toBe(false)
		now = PENDING_CAPTURE_WINDOW_MS
		expect(l.take("s")).toBe(true)
		l.release("s")
		expect(l.take("s")).toBe(true)
		expect(l.take("")).toBe(false)
	})

	it("at most 64 sources; one more is refused", () => {
		const l = new PendingCaptureLimiter(() => 0)
		for (let i = 0; i < PENDING_CAPTURE_MAX_SOURCES; i++)
			expect(l.take(`s${i}`)).toBe(true)
		expect(l.take("extra")).toBe(false)
		expect(l.sources).toBe(PENDING_CAPTURE_MAX_SOURCES)
	})
})
