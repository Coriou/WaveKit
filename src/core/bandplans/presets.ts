/**
 * Built-in scan presets and preset → scanner job bodies.
 * Pure: reads bandplansFor / resolveBandplan and never creates a scan job.
 */
import type {
	BandRegion,
	BuiltinScanPreset,
	PresetRange,
	ScanExclusion,
	ScanJobSpec,
	ScanPresetIssue,
	ScanPresetJob,
	ScanRange,
} from "@wavekit/api-types"
import {
	builtinBandplansFor,
	resolveBuiltinBandplan,
} from "./builtin-supplement.js"
import type {
	BuiltinPresetsFor,
	PresetIssuesFor,
	PresetToJobSpec,
} from "./contract.js"

/** Emitted only when at least two ids resolve; unresolved ids are omitted. */
const COMBINATIONS = [
	{
		id: "builtin-combo-ism-srd",
		name: "ISM / SRD",
		planIds: ["ism-433", "ism-868", "ism-169"],
	},
	{
		id: "builtin-combo-personal-radio",
		name: "Personal radio",
		planIds: ["pmr446", "dpmr446", "cb"],
	},
	{
		id: "builtin-combo-land-mobile-marine",
		name: "Land mobile + Marine",
		planIds: ["vhf-land-mobile", "marine-vhf"],
	},
] as const

function emptyJob(bandplans: readonly string[]): ScanPresetJob {
	return {
		mode: null,
		bandplans: [...bandplans],
		ranges: [],
		exclusions: [],
		protocols: [],
		sensitivity: null,
		thresholdDb: null,
		fftSize: null,
		integrationMs: null,
		dwellMs: null,
		settleMs: null,
	}
}

function builtinPreset(
	region: BandRegion,
	id: string,
	name: string,
	bandplans: readonly string[],
): BuiltinScanPreset {
	return { kind: "builtin", id, name, region, job: emptyJob(bandplans) }
}

export const builtinPresetsFor: BuiltinPresetsFor = region => {
	const presets: BuiltinScanPreset[] = builtinBandplansFor(region).map(plan =>
		builtinPreset(region, `builtin-${plan.id}`, plan.name, [plan.id]),
	)
	for (const combination of COMBINATIONS) {
		const bandplans = combination.planIds.filter(
			id => resolveBuiltinBandplan(id, region) !== undefined,
		)
		if (bandplans.length < 2) continue
		presets.push(
			builtinPreset(region, combination.id, combination.name, bandplans),
		)
	}
	return presets
}

export const presetIssuesFor: PresetIssuesFor = (
	preset,
	region,
	effectiveIds,
) =>
	preset.job.bandplans
		.filter(id =>
			effectiveIds === undefined
				? resolveBuiltinBandplan(id, region) === undefined
				: !effectiveIds.has(id),
		)
		.map(
			(bandplanId): ScanPresetIssue => ({
				code: "unknown-bandplan",
				bandplanId,
			}),
		)

/** Range arrays stay present when empty: the scanner treats [] like an absent field. */
function copyRange(range: PresetRange): ScanRange {
	return {
		startHz: range.startHz,
		endHz: range.endHz,
		rasters: range.rasters.map(raster => ({
			spacingHz: raster.spacingHz,
			firstChannelHz: raster.firstChannelHz,
		})),
		obwHz: [...range.obwHz],
		protocols: [...range.protocols],
	}
}

function copyExclusion(
	exclusion: ScanPresetJob["exclusions"][number],
): ScanExclusion {
	const copy: ScanExclusion = {
		startHz: exclusion.startHz,
		endHz: exclusion.endHz,
	}
	if (exclusion.reason !== null) copy.reason = exclusion.reason
	return copy
}

export const presetToJobSpec: PresetToJobSpec = preset => {
	const job = preset.job
	const spec: ScanJobSpec = { name: preset.name }
	if (job.mode !== null) spec.mode = job.mode
	if (job.bandplans.length > 0) spec.bandplans = [...job.bandplans]
	if (job.ranges.length > 0) spec.ranges = job.ranges.map(copyRange)
	if (job.exclusions.length > 0)
		spec.exclusions = job.exclusions.map(copyExclusion)
	if (job.protocols.length > 0) spec.protocols = [...job.protocols]
	if (job.sensitivity !== null) spec.sensitivity = job.sensitivity
	if (job.thresholdDb !== null) spec.thresholdDb = job.thresholdDb
	if (job.fftSize !== null) spec.fftSize = job.fftSize
	if (job.integrationMs !== null) spec.integrationMs = job.integrationMs
	if (job.dwellMs !== null) spec.dwellMs = job.dwellMs
	if (job.settleMs !== null) spec.settleMs = job.settleMs
	return spec
}
