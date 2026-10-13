/**
 * Read-only projection of bandplansFor (docs/specs/band-plans/design.md).
 * One frozen pack per BandRegion. Adds no frequency data.
 */
import type {
	Band,
	BandPlanCitation,
	BandPlanPack,
	BandProvenance,
	BandScan,
	DisplayGroup,
	ScanRange,
} from "@wavekit/api-types"
import type { BandRegion } from "@wavekit/api-types"
import { bandplansFor } from "../scanner/bandplan/index.js"
import type { Bandplan } from "../scanner/bandplan/index.js"
import { BandPlansError } from "./contract.js"
import type {
	BuiltinGroupFor,
	BuiltinPackIdFor,
	ProjectBuiltinPacks,
} from "./contract.js"

const BAND_REGIONS = ["EU", "US", "CA", "AU", "NZ", "JP", "CN"] as const satisfies readonly BandRegion[]

/** Explicit group for every plan id in builtin.ts. Unknown ids fall through to "other". */
const BUILTIN_GROUPS: Readonly<Record<string, DisplayGroup>> = Object.freeze({
	airband: "air",
	cb: "personal-radio",
	pmr446: "personal-radio",
	dpmr446: "personal-radio",
	"ism-169": "ism-srd",
	"ism-433": "ism-srd",
	"ism-868": "ism-srd",
	"pager-vhf": "pagers",
	"vhf-land-mobile": "land-mobile",
	"uhf-land-mobile": "land-mobile",
	"amateur-2m": "amateur",
	"amateur-70cm": "amateur",
	aprs: "amateur",
	"marine-vhf": "marine",
})

/**
 * Citations transcribed from builtin.ts comments, keyed by variant region and plan id.
 * `all` variants stay `builtin` even when the same plan id is cited for EU.
 */
const CITATIONS: Readonly<
	Record<string, readonly BandPlanCitation[]>
> = Object.freeze({
	"EU:airband": Object.freeze([
		Object.freeze({
			title: "Ofcom Spectrum Pricing §7.2.3/4: 118–137 MHz, 25/8.33 kHz.",
			url: "https://www.ofcom.org.uk/siteassets/resources/documents/consultations/uncategorised/8801-spec_pricing/summary/spec_pricing.pdf",
		}),
		Object.freeze({
			title:
				"Ofcom carrier-frequency explanation: exact thirds, not 8,330 Hz or channel designators.",
			url: "https://www.ofcom.org.uk/__data/assets/pdf_file/0023/144590/Understanding-8.33kHz-frequencies-and-their-specific-channel-number.pdf",
		}),
	]),
	"EU:cb": Object.freeze([
		Object.freeze({
			title:
				"Ofcom IR 2027.2, Table 2.2: 10 kHz carrier steps within each run.",
			url: "https://www.ofcom.org.uk/__data/assets/pdf_file/0030/84765/ir_2027.2.pdf",
		}),
	]),
	"EU:ism-169": Object.freeze([
		Object.freeze({
			title:
				"ERC Report 25 (October 2017), p78: meter reading within 169.400–169.475 MHz.",
			url: "https://docdb.cept.org/download/2830",
		}),
	]),
	"EU:pager-vhf": Object.freeze([
		Object.freeze({
			title:
				"ERC Report 25 (October 2017), p78: 169.4–169.475 MHz is meter reading; exclude only that interval.",
			url: "https://docdb.cept.org/download/2830",
		}),
	]),
	"EU:pmr446": Object.freeze([
		Object.freeze({
			title:
				"ECC/DEC/(15)05, decides 2 and 4: analogue 12.5 kHz; digital 6.25/12.5 kHz.",
			url: "https://docdb.cept.org/download/1491",
		}),
	]),
	"EU:dpmr446": Object.freeze([
		Object.freeze({
			title:
				"ECC/DEC/(15)05, decides 4: full digital band and lowest 6.25 kHz carrier since 2018.",
			url: "https://docdb.cept.org/download/1491",
		}),
	]),
})

const NO_CHANNELS: Band["channels"] = Object.freeze([])

export const builtinPackIdFor: BuiltinPackIdFor = region =>
	`builtin-${region.toLowerCase()}`

export const builtinGroupFor: BuiltinGroupFor = bandplanId =>
	Object.hasOwn(BUILTIN_GROUPS, bandplanId)
		? BUILTIN_GROUPS[bandplanId]!
		: "other"

function copyScanRange(range: Bandplan["ranges"][number]): ScanRange {
	const copy: ScanRange = { startHz: range.startHz, endHz: range.endHz }
	if (range.rasters !== undefined)
		copy.rasters = range.rasters.map(raster => ({
			spacingHz: raster.spacingHz,
			firstChannelHz: raster.firstChannelHz,
		}))
	if (range.obwHz !== undefined) copy.obwHz = [...range.obwHz]
	if (range.protocols !== undefined) copy.protocols = [...range.protocols]
	if (range.bandplanId !== undefined) copy.bandplanId = range.bandplanId
	return copy
}

function provenanceFor(plan: Bandplan): BandProvenance {
	const citations =
		plan.region === "all" ? undefined : CITATIONS[`${plan.region}:${plan.id}`]
	if (!citations) return { kind: "builtin" }
	return { kind: "builtin-cited", citations }
}

function projectBand(plan: Bandplan): Band {
	const first = plan.ranges[0]
	if (!first)
		throw new BandPlansError("BANDPLANS_INVALID")
	let startHz = first.startHz
	let endHz = first.endHz
	for (const range of plan.ranges) {
		if (range.startHz < startHz) startHz = range.startHz
		if (range.endHz > endHz) endHz = range.endHz
	}
	const scan: BandScan = {
		bandplanId: plan.id,
		ranges: plan.ranges.map(copyScanRange),
	}
	return {
		id: plan.id,
		name: plan.name,
		startHz,
		endHz,
		group: builtinGroupFor(plan.id),
		mode: null,
		bandwidthHz: null,
		stepHz: null,
		skip: null,
		channels: NO_CHANNELS,
		parentId: null,
		colourHint: null,
		registryRef: null,
		scan,
		provenance: provenanceFor(plan),
	}
}

function projectRegion(region: BandRegion): BandPlanPack {
	return {
		id: builtinPackIdFor(region),
		kind: "builtin",
		name: `Built-in (${region})`,
		region,
		provenance: { kind: "builtin" },
		bands: bandplansFor(region).map(projectBand),
	}
}

function deepFreeze<T>(value: T): T {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		for (const child of Object.values(value as Record<string, unknown>))
			deepFreeze(child)
		Object.freeze(value)
	}
	return value
}

let cached: readonly BandPlanPack[] | undefined

export const projectBuiltinPacks: ProjectBuiltinPacks = () => {
	cached ??= deepFreeze(BAND_REGIONS.map(projectRegion))
	return cached
}
