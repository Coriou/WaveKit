/**
 * Built-in band defaults and the one band resolver (band defaults spec §3.2,
 * §5.1). Pure: the manager passes the decoder declaration, the overrides and
 * the effective region; nothing here reads config files or persistence.
 *
 * Wide ranges are deliberate: an operator start or an override always wins,
 * and a wrong "in band" only keeps a decoder running.
 */

import type {
	BandRegion,
	DecoderBandOverride,
	DecoderBandRange,
	DecoderBandRegion,
} from "@wavekit/api-types"
import type {
	DecoderBandDeclaration,
	DecoderBandRequirements,
} from "./band-resolver.js"
import type { LoraRegion } from "./builtin/lora-meshtastic.js"

export interface BandDefault {
	targetsHz?: readonly number[]
	rangesHz?: readonly DecoderBandRange[]
}

export type BandDefaultEntry =
	| { scope: "all"; band: BandDefault }
	| { scope: "region"; byRegion: Readonly<Record<BandRegion, BandDefault>> }

const MHz = (value: number): number => Math.round(value * 1_000_000)
const range = (minMHz: number, maxMHz: number): DecoderBandRange => ({
	minHz: MHz(minMHz),
	maxHz: MHz(maxMHz),
})

/** ISS APRS digipeater, worldwide. */
const ISS_APRS_HZ = MHz(145.825)
const aprs = (mhz: number): BandDefault => ({
	targetsHz: [MHz(mhz), ISS_APRS_HZ],
})

const ISM_433 = range(433.05, 434.79)
const US_315 = range(314, 316)
const US_345 = range(344, 346)
const ISM_915_AU = range(915, 928)

export const BAND_DEFAULTS: Readonly<
	Partial<Record<string, BandDefaultEntry>>
> = {
	// VHF ACARS incl. EU 136.7-136.9 MHz.
	acarsdec: { scope: "all", band: { rangesHz: [range(129, 137)] } },
	// VHF, UHF incl. US T-band, 700/800/900 land mobile.
	"dsd-fme": {
		scope: "all",
		band: {
			rangesHz: [range(136, 174), range(380, 512), range(764, 941)],
		},
	},
	direwolf: {
		scope: "region",
		byRegion: {
			EU: aprs(144.8),
			US: aprs(144.39),
			CA: aprs(144.39),
			AU: aprs(145.175),
			NZ: aprs(144.575),
			JP: aprs(144.64),
			CN: aprs(144.64),
		},
	},
	rtl433: {
		scope: "region",
		byRegion: {
			EU: { rangesHz: [ISM_433, range(863, 870)] },
			US: { rangesHz: [US_315, US_345, ISM_433, range(902, 928)] },
			CA: { rangesHz: [US_315, US_345, ISM_433, range(902, 928)] },
			AU: { rangesHz: [ISM_433, ISM_915_AU] },
			NZ: { rangesHz: [ISM_433, range(864, 868), ISM_915_AU] },
			JP: { rangesHz: [US_315, range(920.5, 928.1)] },
			CN: { rangesHz: [US_315, ISM_433] },
		},
	},
	// multimon-ng: no entry. Country-specific paging plus FLEX/EAS/DTMF
	// modes make any default risky; unknown unless configured or overridden.
}

/** Meshtastic firmware region table (followCenter LoRa band). */
export const LORA_REGION_RANGES_HZ: Readonly<
	Record<LoraRegion, DecoderBandRange>
> = {
	US: range(902, 928),
	EU_433: range(433, 434),
	EU_868: range(869.4, 869.65),
	CN: range(470, 510),
	JP: range(920.5, 923.5),
	ANZ: range(915, 928),
	KR: range(920, 923),
	TW: range(920, 925),
	RU: range(868.7, 869.2),
	IN: range(865, 867),
	NZ_865: range(864, 868),
	TH: range(920, 925),
	UA_433: range(433, 434.7),
	UA_868: range(868, 868.6),
	MY_433: range(433, 435),
	MY_919: range(919, 924),
	SG_923: range(917, 925),
}

/** An override as Zod infers it (optional keys may hold undefined). */
export interface BandOverrideInput {
	rangesHz?: DecoderBandRange[] | undefined
	targetsHz?: number[] | undefined
	region?: BandRegion | undefined
	bandSuspension?: boolean | undefined
}

/** Copies an override, dropping undefined keys (the API/JSON shape). */
export function normalizeBandOverride(
	input: BandOverrideInput,
): DecoderBandOverride {
	return {
		...(input.rangesHz !== undefined
			? {
					rangesHz: input.rangesHz.map(r => ({
						minHz: r.minHz,
						maxHz: r.maxHz,
					})),
				}
			: {}),
		...(input.targetsHz !== undefined
			? { targetsHz: [...input.targetsHz] }
			: {}),
		...(input.region !== undefined ? { region: input.region } : {}),
		...(input.bandSuspension !== undefined
			? { bandSuspension: input.bandSuspension }
			: {}),
	}
}

export interface ResolveBandInput {
	/** config.type, the key into the table. */
	type: string
	declaration: DecoderBandDeclaration | undefined
	/** decoders[].band */
	configOverride?: BandOverrideInput | undefined
	/** API layer from the override store. */
	apiOverride?: BandOverrideInput | undefined
	/** Effective global region. */
	region: DecoderBandRegion
	table?: Readonly<Partial<Record<string, BandDefaultEntry>>> | undefined
}

export interface ResolvedBand {
	requirements?: DecoderBandRequirements
	/** false: the per-decoder opt-out from band suspension. */
	bandSuspension: boolean
	/** Effective region for this decoder (global, or the decoder override). */
	region: DecoderBandRegion
}

/** The merged override: API over config, field-wise; band lists as one unit. */
export interface MergedBandOverride {
	band?: { rangesHz?: DecoderBandRange[]; targetsHz?: number[] }
	bandSource?: "config" | "api"
	region?: BandRegion
	bandSuspension?: boolean
}

function bandOf(
	override: BandOverrideInput | undefined,
): { rangesHz?: DecoderBandRange[]; targetsHz?: number[] } | undefined {
	if (!override) return undefined
	const { rangesHz, targetsHz } = override
	if (!rangesHz?.length && !targetsHz?.length) return undefined
	return {
		...(rangesHz?.length
			? { rangesHz: rangesHz.map(r => ({ minHz: r.minHz, maxHz: r.maxHz })) }
			: {}),
		...(targetsHz?.length ? { targetsHz: [...targetsHz] } : {}),
	}
}

export function mergeBandOverrides(
	apiOverride: BandOverrideInput | undefined,
	configOverride: BandOverrideInput | undefined,
): MergedBandOverride {
	const apiBand = bandOf(apiOverride)
	const configBand = bandOf(configOverride)
	const region = apiOverride?.region ?? configOverride?.region
	const bandSuspension =
		apiOverride?.bandSuspension ?? configOverride?.bandSuspension
	return {
		...(apiBand
			? { band: apiBand, bandSource: "api" as const }
			: configBand
				? { band: configBand, bandSource: "config" as const }
				: {}),
		...(region !== undefined ? { region } : {}),
		...(bandSuspension !== undefined ? { bandSuspension } : {}),
	}
}

function fromDefault(
	band: BandDefault,
	region: DecoderBandRegion | undefined,
): DecoderBandRequirements | undefined {
	if (!band.rangesHz?.length && !band.targetsHz?.length) return undefined
	return {
		...(band.targetsHz?.length ? { targetsHz: [...band.targetsHz] } : {}),
		...(band.rangesHz?.length
			? {
					rangesHz: band.rangesHz.map(r => ({
						minHz: r.minHz,
						maxHz: r.maxHz,
					})),
				}
			: {}),
		basis: "region-default",
		...(region ? { region: { ...region } } : {}),
	}
}

/**
 * Band requirements for one decoder; first match wins (spec §3.2):
 * ownSource, API override, config override, configured, ownTuning, the
 * built-in table, then the decoder's intrinsic declaration.
 */
export function resolveBandRequirements(input: ResolveBandInput): ResolvedBand {
	const merged = mergeBandOverrides(input.apiOverride, input.configOverride)
	const region: DecoderBandRegion =
		merged.region !== undefined
			? { code: merged.region, source: "decoder" }
			: { ...input.region }
	const bandSuspension = merged.bandSuspension ?? true
	const declaration = input.declaration ?? {}
	const resolved = (requirements?: DecoderBandRequirements): ResolvedBand => ({
		...(requirements ? { requirements } : {}),
		bandSuspension,
		region,
	})

	if (declaration.ownSource) return resolved()
	if (merged.band && merged.bandSource)
		return resolved({
			...merged.band,
			basis: "override",
			overrideSource: merged.bandSource,
		})
	if (declaration.configured) return resolved(declaration.configured)
	if (declaration.ownTuning) return resolved()
	const entry = (input.table ?? BAND_DEFAULTS)[input.type]
	if (entry) {
		const fromTable =
			entry.scope === "all"
				? fromDefault(entry.band, undefined)
				: fromDefault(entry.byRegion[region.code], region)
		if (fromTable) return resolved(fromTable)
	}
	return resolved(declaration.intrinsic)
}
