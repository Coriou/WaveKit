/**
 * Per-band gain table: schema, defaults and lookup. Pure (zod and api-types only) so the
 * config schema can import it without pulling in the store.
 *
 * Why: a manual gain that suits one band can overload the RTL-SDR front end in another
 * (strong nearby cellular and ISM emitters raise the whole window at once). Scanner hops,
 * dwells and jobs that retune away from the operator's tuning apply the band's gain and
 * restore the operator's exact gain when they hand the tuner back.
 */
import { z } from "zod"
import {
	BAND_GAIN_LABEL_MAX_LENGTH,
	BAND_GAIN_MAX_ENTRIES,
	BAND_GAIN_MAX_HZ,
	BAND_GAIN_MAX_TENTHS_DB,
	BAND_GAIN_MIN_HZ,
	BAND_GAIN_MIN_TENTHS_DB,
} from "@wavekit/api-types"
import type {
	BandGainEntry,
	BandGainSettings,
	BandGainValue,
} from "@wavekit/api-types"

const HzSchema = z.number().int().min(BAND_GAIN_MIN_HZ).max(BAND_GAIN_MAX_HZ)

export const BandGainEntrySchema = z
	.object({
		minHz: HzSchema,
		maxHz: HzSchema,
		gain: z.union([
			z.literal("keep"),
			z
				.number()
				.int()
				.min(BAND_GAIN_MIN_TENTHS_DB)
				.max(BAND_GAIN_MAX_TENTHS_DB),
		]),
		// Printable ASCII only: a label is shown, never interpreted.
		label: z
			.string()
			.min(1)
			.max(BAND_GAIN_LABEL_MAX_LENGTH)
			.regex(/^[\x20-\x7e]+$/)
			.optional(),
	})
	.strict()
	.refine(entry => entry.minHz < entry.maxHz, {
		message: "minHz must be below maxHz",
		path: ["maxHz"],
	})

/**
 * Defaults, one reason each (all ranges inclusive):
 * - 863-870 MHz (EU SRD/ISM 868: LoRa, Meshtastic, wM-Bus) and 902-928 MHz (US ISM 915):
 *   37.2 dB. Both sit beside strong cellular downlinks (LTE 800, GSM/LTE 900). A measured
 *   49.6 dB overloaded the front end at 868 MHz (busy moments raised the whole window about
 *   25 dB) and 29.7 dB did not; 37.2 dB (an R820T step) is about 12 dB below the overloading
 *   gain while keeping most of the sensitivity weak LoRa needs. Lower it if raises persist.
 * - 1085-1095 MHz (ADS-B/Mode S): keep. Readsb wants the operator's (usually high) gain, and
 *   a lower gain shortens aircraft range.
 * - 144-148 MHz (2 m) and 420-450 MHz (70 cm): keep. These are the bands an operator usually
 *   tunes with a gain chosen for them; "keep" documents that explicitly.
 * Any frequency without an entry also keeps the gain.
 */
export const DEFAULT_BAND_GAIN_ENTRIES: readonly BandGainEntry[] =
	Object.freeze(
		[
			{ minHz: 144_000_000, maxHz: 148_000_000, gain: "keep", label: "2 m" },
			{ minHz: 420_000_000, maxHz: 450_000_000, gain: "keep", label: "70 cm" },
			{
				minHz: 863_000_000,
				maxHz: 870_000_000,
				gain: 372,
				label: "868 MHz ISM",
			},
			{
				minHz: 902_000_000,
				maxHz: 928_000_000,
				gain: 372,
				label: "915 MHz ISM",
			},
			{
				minHz: 1_085_000_000,
				maxHz: 1_095_000_000,
				gain: "keep",
				label: "ADS-B",
			},
		].map(entry => Object.freeze(entry as BandGainEntry)),
	)

/** Index pairs of overlapping entries (inclusive ranges), at most one pair per entry. */
function overlaps(
	entries: readonly { minHz: number; maxHz: number }[],
): [number, number][] {
	// n <= BAND_GAIN_MAX_ENTRIES (32): the pairwise check is at most 496 comparisons.
	const found: [number, number][] = []
	for (let i = 0; i < entries.length; i++) {
		const a = entries[i]
		if (a === undefined) continue
		for (let j = i + 1; j < entries.length; j++) {
			const b = entries[j]
			if (b === undefined) continue
			if (a.minHz <= b.maxHz && b.minHz <= a.maxHz) {
				found.push([i, j])
				break
			}
		}
	}
	return found
}

export const BandGainEntriesSchema = z
	.array(BandGainEntrySchema)
	.max(BAND_GAIN_MAX_ENTRIES)
	.superRefine((entries, ctx) => {
		for (const [i, j] of overlaps(entries))
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: `entries ${i} and ${j} overlap (ranges are inclusive and must not overlap)`,
				path: [j],
			})
	})

export const BandGainSettingsSchema = z
	.object({
		applyToMyTuning: z.boolean(),
		entries: BandGainEntriesSchema,
	})
	.strict()

/** The YAML `tuner.bandGain` section (both fields defaulted). */
export const BandGainConfigSchema = z
	.object({
		applyToMyTuning: z.boolean().default(false),
		entries: BandGainEntriesSchema.default(() =>
			DEFAULT_BAND_GAIN_ENTRIES.map(entry => ({ ...entry })),
		),
	})
	.strict()

/**
 * The gain of the band containing `hz`: tenths of a dB, or "keep" for a keep entry or no
 * entry. Entries never overlap, so the first match is the only match. Malformed input
 * (non-finite frequency) keeps the gain: the safe answer.
 */
export function bandGainAt(
	entries: readonly Pick<BandGainEntry, "minHz" | "maxHz" | "gain">[],
	hz: number,
): BandGainValue {
	if (!Number.isFinite(hz)) return "keep"
	for (const entry of entries)
		if (hz >= entry.minHz && hz <= entry.maxHz) return entry.gain
	return "keep"
}

/**
 * The supported step nearest `tenthsDb` (the lower one on a tie), or `tenthsDb` itself when
 * the tuner's step table is unknown or empty (librtlsdr then picks its own nearest step).
 */
export function nearestGainStep(
	tenthsDb: number,
	steps: readonly number[] | null,
): number {
	if (steps === null || steps.length === 0) return tenthsDb
	let best: number | null = null
	for (const step of steps) {
		if (!Number.isInteger(step)) continue
		if (
			best === null ||
			Math.abs(step - tenthsDb) < Math.abs(best - tenthsDb) ||
			(Math.abs(step - tenthsDb) === Math.abs(best - tenthsDb) && step < best)
		)
			best = step
	}
	if (best === null) return tenthsDb
	// A table can list negative steps (E4000, FC0012): the write range is 0-500.
	return Math.min(
		BAND_GAIN_MAX_TENTHS_DB,
		Math.max(BAND_GAIN_MIN_TENTHS_DB, best),
	)
}

export function defaultBandGainSettings(): BandGainSettings {
	return {
		applyToMyTuning: false,
		entries: DEFAULT_BAND_GAIN_ENTRIES.map(entry => ({ ...entry })),
	}
}
