// Gain steps for the Receiver island's slider. Pure.
//
// The slider moves over an index into the tuner's gain table (receiver capabilities, WG7: the list
// librtlsdr reports for the tuner the rtl_tcp header advertised, in tenths of dB). Without a table
// (older core, header not seen yet, unlisted tuner) it falls back to 1 dB steps over the range the
// core's gain command admits. The core does not snap: rtl_tcp picks the nearest table value itself,
// so the slider sends table values to keep what it shows and what the dongle uses the same.
import type { ScannerEngineStatus, TunerBandGain } from "@wavekit/api-types"

import type { ReceiverCaps } from "../../data/index.ts"

/** The core's gain command range (TUNER_REST_COMMAND_POLICY gain: 0..500 tenths of dB). */
export const GAIN_RANGE = { min: 0, max: 500 } as const

export interface GainSteps {
	valuesTenthsDb: readonly number[]
	/** `table`: the tuner's gain table; `fallback`: 1 dB steps. */
	source: "table" | "fallback"
	/** The tuner name from the table ("R820T"), else null. */
	tuner: string | null
	/** Why there is no table, for the hint line (null with a table). */
	reason: string | null
}

/** The range the capabilities' gain command admits, else the core's known range. */
export function gainRange(caps: ReceiverCaps | null): {
	min: number
	max: number
} {
	const rule = caps?.controls.find(c => c.id === "gain")?.command.validation
		.rule
	return rule?.kind === "integer-range"
		? { min: rule.min, max: rule.max }
		: { ...GAIN_RANGE }
}

function fallbackSteps(range: { min: number; max: number }): number[] {
	const out: number[] = []
	const start = Math.ceil(range.min / 10) * 10
	for (let v = start; v <= range.max; v += 10) out.push(v)
	return out.length > 0 ? out : [range.min]
}

const NO_TABLE: Record<string, string> = {
	"header-not-advertised": "The receiver has not sent its tuner header yet",
	"unlisted-tuner-type": "The tuner type is not one WaveKit knows",
	"gain-count-mismatch": "The tuner's gain count matches no known table",
	"no-gain-table": "This tuner has no gain table",
	"non-rtl-transport": "Not an rtl_tcp source",
}

export function gainSteps(caps: ReceiverCaps | null): GainSteps {
	const range = gainRange(caps)
	const table = caps?.gainTable
	if (table?.state === "suggested") {
		const values = [...new Set(table.valuesTenthsDb)]
			.filter(v => v >= range.min && v <= range.max)
			.sort((a, b) => a - b)
		if (values.length > 0)
			return {
				valuesTenthsDb: values,
				source: "table",
				tuner: table.tuner,
				reason: null,
			}
	}
	const reason =
		table === undefined
			? caps
				? "This core does not report a gain table"
				: "Receiver capabilities unavailable"
			: table.state === "suggested"
				? "The gain table is outside the command range"
				: (NO_TABLE[table.reason] ?? "No gain table")
	return {
		valuesTenthsDb: fallbackSteps(range),
		source: "fallback",
		tuner: null,
		reason,
	}
}

/** Index of the step nearest `tenthsDb` (the lower one on a tie). */
export function nearestGainIndex(steps: GainSteps, tenthsDb: number): number {
	const values = steps.valuesTenthsDb
	let best = 0
	let bestDistance = Number.POSITIVE_INFINITY
	for (let i = 0; i < values.length; i++) {
		const value = values[i]
		if (value === undefined) continue
		const distance = Math.abs(value - tenthsDb)
		if (distance < bestDistance) {
			best = i
			bestDistance = distance
		}
	}
	return best
}

/** The step value nearest `tenthsDb`. */
export function snapGain(steps: GainSteps, tenthsDb: number): number {
	return steps.valuesTenthsDb[nearestGainIndex(steps, tenthsDb)] ?? tenthsDb
}

/** The table value at slider position `index` (clamped). */
export function gainAt(steps: GainSteps, index: number): number {
	const values = steps.valuesTenthsDb
	const i = Math.min(values.length - 1, Math.max(0, Math.round(index)))
	return values[i] ?? GAIN_RANGE.min
}

/** "29.7 dB". */
export function gainDb(tenthsDb: number): string {
	return `${(tenthsDb / 10).toFixed(1)} dB`
}

/** The hint under the slider. */
export function gainHint(steps: GainSteps): string {
	if (steps.source === "table")
		return `Steps follow the ${steps.tuner ?? "tuner"}'s own gain table.`
	return `${steps.reason ?? "No gain table"}: 1 dB steps, the dongle picks its nearest gain.`
}

// ---- per-band gain (TunerState.bandGain) and the scanner's overload hint

/**
 * "Band gain 37.2 dB · 868 MHz ISM · while the scanner tunes", from the core's confirmed
 * TunerState.bandGain only: the core reports it while the band gain it wrote (snapped to the
 * tuner's step) is the gain on the tuner, and drops it on any later gain, mode or frequency change.
 */
export function bandGainText(bandGain: TunerBandGain): string {
	const by =
		bandGain.owner === "scanner" ? "while the scanner tunes" : "for your tuning"
	return [`Band gain ${gainDb(bandGain.tenthsDb)}`, bandGain.label, by]
		.filter(Boolean)
		.join(" · ")
}

/** The scanner engine's overload hint for `sourceId`, in words, or null. */
export function overloadHintText(
	engines: readonly Pick<ScannerEngineStatus, "sourceId" | "overloadHint">[],
	sourceId: string,
): string | null {
	const hint = engines.find(e => e.sourceId === sourceId)?.overloadHint
	if (!hint) return null
	return `Front end may be overloaded at this gain (${gainDb(hint.gain)}, ${hint.blankedPercent.toFixed(1)} % of frames blanked)`
}
