import { WaveKitError } from "../../../utils/errors.js"

/** Runtime spec estimates in cores. Descriptive capacity fits below do not change admission. */
export const CPU_COST = {
	engine: 0.08,
	offsetProbe: 0.5,
	channelBase: 0.05,
	decoder: {
		"dsd-fme": 0.045,
		"multimon-ng": 0.03,
		direwolf: 0.05,
		rtl433: 0.1,
		// AM demodulation of one 48 kHz replay plus acarsdec (the enablement estimate, 0.05)
		acarsdec: 0.05,
	},
} as const

const UNKNOWN_DECODER_CORES = 0.1

export function probeCores(
	transport: "offset" | "channel",
	decoderType: string,
): number {
	if (transport === "offset") return CPU_COST.offsetProbe
	const decoders: Readonly<Record<string, number>> = CPU_COST.decoder
	return CPU_COST.channelBase + (decoders[decoderType] ?? UNKNOWN_DECODER_CORES)
}

export type ProbeCostDecoder = keyof typeof CPU_COST.decoder
/** All costs are cores, never percent of a core. */
export interface CpuCostTable {
	engine: number
	offsetProbe: number
	/** Marginal native-process cost per channel; not its process base. */
	channelBase: number
	/** Charge once per scanner-active source absent reliable shared-use accounting. */
	nativeBase: number
	decoder: Readonly<Record<ProbeCostDecoder, number>>
	decoderBasis: Readonly<Record<ProbeCostDecoder, "estimate" | "measurement">>
}

export interface CapacityMeasurements {
	source: string
	sampleRateHz: number
	outputRateHz: number
	nativeProcessCores: { oneChannel: number; eightChannels: number }
	/** Only measurements of these probe decoders on channel IQ belong here. */
	decoderCores: Partial<Record<ProbeCostDecoder, number>>
	scope: {
		fixture: "AIS"
		playback: "paced"
		placement: "spread"
		cpuQuotaCores: number
		hostNoiseCores: number
		n8Verdict: "conditional"
		n8InputGapPercent: readonly [number, number]
		piMeasured: false
		combinedScannerSustained: false
	}
}

const DECODERS: readonly ProbeCostDecoder[] = [
	"dsd-fme",
	"multimon-ng",
	"direwolf",
	"rtl433",
	"acarsdec",
]
const ESTIMATED_DECODERS = {
	"dsd-fme": "estimate",
	"multimon-ng": "estimate",
	direwolf: "estimate",
	rtl433: "estimate",
	acarsdec: "estimate",
} as const

/** Historical estimates omit a native base; descriptive fit replaces that omission. */
export const SPEC_COSTS: CpuCostTable = {
	...CPU_COST,
	nativeBase: 0,
	decoderBasis: ESTIMATED_DECODERS,
}

/** Cores from the report's cores column: no percent conversion is applicable. */
export const CAPACITY_MEASUREMENTS: CapacityMeasurements = {
	source: "docs/CAPACITY-2026-10-10-CHANNELIZER.md",
	sampleRateHz: 2_048_000,
	outputRateHz: 384_000,
	nativeProcessCores: { oneChannel: 0.22, eightChannels: 0.78 },
	decoderCores: {},
	scope: {
		fixture: "AIS",
		playback: "paced",
		placement: "spread",
		cpuQuotaCores: 4,
		hostNoiseCores: 0.3,
		n8Verdict: "conditional",
		n8InputGapPercent: [1.39, 2.04],
		piMeasured: false,
		combinedScannerSustained: false,
	},
}

function nonnegative(value: number, field: string): void {
	if (!Number.isFinite(value) || value < 0)
		throw new WaveKitError(
			`${field} must be finite and nonnegative`,
			"SCANNER_CPU_COST_INVALID",
		)
}

function validateCosts(costs: CpuCostTable): void {
	for (const field of [
		"engine",
		"offsetProbe",
		"channelBase",
		"nativeBase",
	] as const)
		nonnegative(costs[field], field)
	for (const type of DECODERS) nonnegative(costs.decoder[type], type)
}

/**
 * Two-point descriptive fit for paced 2.048 Msps AIS 384 kHz only:
 * marginal = (.78-.22)/7 = .08; base = .22-.08 = .14 cores.
 * N4 (.56 cores) is not exactly predicted; noise is about .3 core. N8 loses
 * input samples under a 4-CPU quota. This is not safe probe capacity, nor a
 * calibration of 48 kHz taps, Pi hosts, or sustained scanner/decoder/recording mixes.
 */
export function deriveCosts(
	measurements: CapacityMeasurements,
	base: CpuCostTable = SPEC_COSTS,
): CpuCostTable {
	validateCosts(base)
	if (
		!measurements.source.trim() ||
		!Number.isSafeInteger(measurements.sampleRateHz) ||
		measurements.sampleRateHz <= 0 ||
		!Number.isSafeInteger(measurements.outputRateHz) ||
		measurements.outputRateHz <= 0 ||
		measurements.outputRateHz > measurements.sampleRateHz
	)
		throw new WaveKitError(
			"Invalid capacity provenance/rates",
			"SCANNER_CPU_COST_INVALID",
		)
	const { oneChannel, eightChannels } = measurements.nativeProcessCores
	nonnegative(measurements.scope.hostNoiseCores, "hostNoiseCores")
	const [minGap, maxGap] = measurements.scope.n8InputGapPercent
	nonnegative(minGap, "minGapPercent")
	nonnegative(maxGap, "maxGapPercent")
	if (
		!Number.isFinite(measurements.scope.cpuQuotaCores) ||
		measurements.scope.cpuQuotaCores <= 0 ||
		minGap > maxGap ||
		maxGap > 100
	)
		throw new WaveKitError("Invalid capacity scope", "SCANNER_CPU_COST_INVALID")
	nonnegative(oneChannel, "oneChannel")
	nonnegative(eightChannels, "eightChannels")
	const channelBase = (eightChannels - oneChannel) / 7
	const nativeBase = oneChannel - channelBase
	nonnegative(channelBase, "channelBase")
	nonnegative(nativeBase, "nativeBase")
	const decoder = { ...base.decoder }
	const decoderBasis = { ...base.decoderBasis }
	for (const type of DECODERS) {
		const value = measurements.decoderCores[type]
		if (value !== undefined) {
			nonnegative(value, type)
			decoder[type] = value
			decoderBasis[type] = "measurement"
		}
	}
	return { ...base, channelBase, nativeBase, decoder, decoderBasis }
}

export const DESCRIPTIVE_CAPACITY_COSTS = deriveCosts(CAPACITY_MEASUREMENTS)

/**
 * Arithmetic estimate capped at eight, not safe admission or a configured default.
 * Reserves one engine, one offset probe and the native base per source (possibly
 * overcounting a shared process). Runtime policy must also account for classifier,
 * recording and pending/closing demand, CPU guard and unknown CPU semantics.
 */
export function maxChannelProbesFor(
	budgetCores: number,
	costs: CpuCostTable,
	reference: ProbeCostDecoder = "dsd-fme",
): number {
	nonnegative(budgetCores, "budgetCores")
	validateCosts(costs)
	const perProbe = costs.channelBase + costs.decoder[reference]
	if (!Number.isFinite(perProbe) || perProbe <= 0)
		throw new WaveKitError(
			"Per-probe cost must be positive",
			"SCANNER_CPU_COST_INVALID",
		)
	const remaining =
		budgetCores - costs.engine - costs.offsetProbe - costs.nativeBase
	return Math.max(0, Math.min(8, Math.floor(remaining / perProbe)))
}
