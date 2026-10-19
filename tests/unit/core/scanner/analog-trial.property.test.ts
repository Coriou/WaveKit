import { DCS_MIN_AUDIO_SECONDS, DCS_STANDARD_CODES } from "@wavekit/api-types"
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { isCtcssToneHz } from "../../../../src/core/audio-tones/ctcss.js"
import { classifyAnalogTrial } from "../../../../src/core/scanner/analog-trial.js"
import {
	ANALOG_TRIAL_AM_CARRIER_DB,
	ANALOG_TRIAL_AUDIO_MIN_DB,
	ANALOG_TRIAL_DATA_SCORE,
	ANALOG_TRIAL_MIN_QUIET_FRACTION,
	ANALOG_TRIAL_QUIETING_DB,
	ANALOG_TRIAL_VOICE_INDEX,
	type AnalogTrialFrame,
	type AnalogTrialOutcome,
	type AnalogTrialStats,
	type AnalogTrialTones,
} from "../../../../src/core/scanner/scanner-redesign-contract.js"

const DCS_CODES = new Set<string>(DCS_STANDARD_CODES)

const db = fc.double({ min: -160, max: 40, noNaN: true })
const unit = fc.double({ min: 0, max: 1.5, noNaN: true })

const frameArb: fc.Arbitrary<AnalogTrialFrame> = fc.record({
	carrierDb: db,
	hfNoiseDb: db,
	audioDb: db,
	syllabic: unit,
	cluster: unit,
})

const tonesArb: fc.Arbitrary<AnalogTrialTones> = fc.record({
	ctcssHz: fc.option(fc.constantFrom(67, 88.5, 100, 254.1), { nil: null }),
	dcs: fc.option(
		fc.record({
			code: fc.constantFrom("023", "047", "754"),
			polarity: fc.constantFrom("normal" as const, "inverted" as const),
		}),
		{ nil: null },
	),
	audioSeconds: fc.double({ min: 0, max: 8, noNaN: true }),
})

const statsArb: fc.Arbitrary<AnalogTrialStats> = fc.record({
	mode: fc.constantFrom("nfm" as const, "am" as const),
	frames: fc.array(frameArb, { minLength: 0, maxLength: 24 }),
	gapSamples: fc.integer({ min: 0, max: 200_000 }),
	floorDb: db,
})

/** Middle after sorting; an even count averages the two central values. */
function median(values: readonly number[]): number | null {
	if (values.some(value => !Number.isFinite(value))) return null
	const sorted = [...values].sort((a, b) => a - b)
	const mid = sorted.length >> 1
	if (sorted.length % 2 === 1) return sorted[mid] ?? null
	const left = sorted[mid - 1]
	const right = sorted[mid]
	if (left === undefined || right === undefined) return null
	return (left + right) / 2
}

type CaseKind = "clean" | "bad-frame" | "bad-tone" | "both"

function applyCase(
	stats: AnalogTrialStats,
	tones: AnalogTrialTones,
	kind: CaseKind,
	field: number,
): { stats: AnalogTrialStats; tones: AnalogTrialTones } {
	let nextStats = stats
	let nextTones = tones
	if ((kind === "bad-frame" || kind === "both") && stats.frames.length > 0) {
		const frames = stats.frames.map(frame => ({ ...frame }))
		const frame = frames[0]
		if (frame) {
			const key = (
				["carrierDb", "hfNoiseDb", "audioDb", "syllabic", "cluster"] as const
			)[field % 5]
			if (key) frame[key] = Number.NaN
		}
		nextStats = { ...stats, frames }
	}
	if (kind === "bad-tone" || kind === "both") {
		const which = field % 4
		if (which === 0) nextTones = {} as AnalogTrialTones
		else if (which === 1)
			nextTones = { ctcssHz: Number.NaN, dcs: null, audioSeconds: 2 }
		else if (which === 2)
			nextTones = {
				ctcssHz: null,
				dcs: {} as AnalogTrialTones["dcs"],
				audioSeconds: 2,
			}
		else
			nextTones = {
				ctcssHz: 88.5,
				dcs: null,
				audioSeconds: DCS_MIN_AUDIO_SECONDS - 0.01,
			}
	}
	return { stats: nextStats, tones: nextTones }
}

function finite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value)
}

function frameFinite(frame: AnalogTrialFrame | null | undefined): boolean {
	if (frame === null || frame === undefined) return false
	return (
		finite(frame.carrierDb) &&
		finite(frame.hfNoiseDb) &&
		finite(frame.audioDb) &&
		finite(frame.syllabic) &&
		finite(frame.cluster)
	)
}

function toneQualified(tones: AnalogTrialTones | null | undefined): boolean {
	if (tones === null || tones === undefined || typeof tones !== "object")
		return false
	const seconds = (tones as { audioSeconds?: unknown }).audioSeconds
	if (!finite(seconds) || seconds < DCS_MIN_AUDIO_SECONDS) return false
	const hz = (tones as { ctcssHz?: unknown }).ctcssHz
	if (finite(hz) && isCtcssToneHz(hz)) return true
	const dcs = (tones as { dcs?: unknown }).dcs
	if (dcs === null || dcs === undefined || typeof dcs !== "object") return false
	const rec = dcs as { code?: unknown; polarity?: unknown }
	return (
		typeof rec.code === "string" &&
		DCS_CODES.has(rec.code) &&
		(rec.polarity === "normal" || rec.polarity === "inverted")
	)
}

/**
 * The requirement 5.4 order, written out separately from the implementation:
 * a qualified tone, then quieting fraction, then cluster, then voice, else
 * carrier. A non-finite frame fails closed to `no-sync`.
 */
function referenceOutcome(
	stats: AnalogTrialStats,
	tones: AnalogTrialTones,
): AnalogTrialOutcome {
	const frames = stats.frames
	if (!Array.isArray(frames) || frames.some(frame => !frameFinite(frame)))
		return "no-sync"
	if (stats.mode !== "nfm" && stats.mode !== "am") return "no-sync"
	if (toneQualified(tones)) return "decoded"
	if (frames.length === 0) return "no-sync"
	let quiet = 0
	for (const frame of frames) {
		// Zero power is −160 dB. At or below −159.9 the frame is silence.
		const silence = frame.carrierDb <= -159.9 || frame.hfNoiseDb <= -159.9
		const passed =
			!silence &&
			(stats.mode === "am"
				? finite(stats.floorDb) &&
					frame.carrierDb >= stats.floorDb + ANALOG_TRIAL_AM_CARRIER_DB
				: -frame.hfNoiseDb >= ANALOG_TRIAL_QUIETING_DB)
		if (passed) quiet += 1
	}
	if (quiet < frames.length * ANALOG_TRIAL_MIN_QUIET_FRACTION) return "no-sync"
	const cluster = median(frames.map(frame => frame.cluster))
	if (cluster !== null && cluster >= ANALOG_TRIAL_DATA_SCORE) return "data-like"
	const syllabic = median(frames.map(frame => frame.syllabic))
	const audio = median(frames.map(frame => frame.audioDb))
	if (
		syllabic !== null &&
		audio !== null &&
		syllabic >= ANALOG_TRIAL_VOICE_INDEX &&
		audio >= ANALOG_TRIAL_AUDIO_MIN_DB
	)
		return "heard"
	return "carrier-only"
}

describe("classifyAnalogTrial decision order", () => {
	// Feature: scanner-redesign, Property 10: The analog trial decides by its rules
	// Validates: Requirements 5.3, 5.4
	// random stats and tones → outcome equals the reference decision order. numRuns: 100
	it("matches the reference decision order", () => {
		fc.assert(
			fc.property(
				statsArb,
				tonesArb,
				fc.oneof(
					{ weight: 4, arbitrary: fc.constant("clean" as const) },
					{ weight: 1, arbitrary: fc.constant("bad-frame" as const) },
					{ weight: 1, arbitrary: fc.constant("bad-tone" as const) },
					{ weight: 1, arbitrary: fc.constant("both" as const) },
				),
				fc.integer({ min: 0, max: 20 }),
				(stats, tones, kind, field) => {
					const applied = applyCase(stats, tones, kind, field)
					expect(classifyAnalogTrial(applied.stats, applied.tones)).toBe(
						referenceOutcome(applied.stats, applied.tones),
					)
				},
			),
			{ numRuns: 100 },
		)
	})
})
