/**
 * Mock band plans: the routes of src/api/routes/bandplans.ts as a protected core serves them (reads,
 * the stack, band edits, operator bands, file and URL import, check for update) and `bandplans:changed`
 * on the `bandplans` channel after each write. The packs are the shared band plan of the canvas
 * (wk-bandplan v1, BAND_SEEDS): France over CEPT / EU, Your edits on top (a renamed CB channel, the
 * operator's Harbour channels, DAB+ hidden), and the International import (Gqrx CSV, off). Same
 * expected token, status codes and error bodies as core; bodies are checked with the core's schemas.
 *
 * Runs under `node --experimental-strip-types`.
 */
import { createHash, randomUUID } from "node:crypto"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import {
	BAND_EDIT_FIELDS,
	BANDPLAN_IMPORT_FORMATS,
	BANDPLAN_URL_IMPORT_HOSTS,
	BANDPLANS_ERROR_DEFINITIONS,
	BANDPLANS_LIMITS,
	bandPlanMutationSchema,
	importPreviewRequestSchema,
	importUrlPreviewRequestSchema,
} from "@wavekit/api-types"
import type {
	Band,
	BandEdit,
	BandEditFields,
	BandPlanImportFormat,
	BandPlanMutation,
	BandPlanPack,
	BandPlanStackView,
	BandPlansErrorCode,
	BandPlanUpdateCheck,
	BandPlanWriteDto,
	DisplayGroup,
	ImportedProvenance,
	ImportGroupMappingRow,
	ImportGroupOverride,
	ImportPreview,
	ImportUrlPreview,
	OperatorScanPreset,
	PlanStackEntry,
	ResolvedBand,
	ResolvedBandPlanView,
	ScanExclusion,
	ScanJobSpec,
	ScanPreset,
	ScanPresetJob,
	ScanPresetListView,
	ScanRange,
} from "@wavekit/api-types"
import {
	BAND_SEEDS,
	SCANNER_BANDPLANS,
	merge,
	subtract,
	toBand,
} from "./data.ts"
import type { Interval } from "./data.ts"

// ---- scan presets (src/core/bandplans/presets.ts)

const PRESET_COMBINATIONS = [
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

function presetJob(bandplans: readonly string[]): ScanPresetJob {
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

function presetToJobSpec(preset: ScanPreset): ScanJobSpec {
	const job = preset.job
	const spec: ScanJobSpec = { name: preset.name }
	if (job.mode !== null) spec.mode = job.mode
	if (job.bandplans.length > 0) spec.bandplans = [...job.bandplans]
	if (job.ranges.length > 0)
		spec.ranges = job.ranges.map(
			(r): ScanRange => ({
				startHz: r.startHz,
				endHz: r.endHz,
				rasters: r.rasters.map(x => ({ ...x })),
				obwHz: [...r.obwHz],
				protocols: [...r.protocols],
			}),
		)
	if (job.exclusions.length > 0)
		spec.exclusions = job.exclusions.map(
			(x): ScanExclusion => ({
				startHz: x.startHz,
				endHz: x.endHz,
				...(x.reason !== null ? { reason: x.reason } : {}),
			}),
		)
	if (job.protocols.length > 0) spec.protocols = [...job.protocols]
	if (job.sensitivity !== null) spec.sensitivity = job.sensitivity
	if (job.thresholdDb !== null) spec.thresholdDb = job.thresholdDb
	if (job.fftSize !== null) spec.fftSize = job.fftSize
	if (job.integrationMs !== null) spec.integrationMs = job.integrationMs
	if (job.dwellMs !== null) spec.dwellMs = job.dwellMs
	if (job.settleMs !== null) spec.settleMs = job.settleMs
	return spec
}

export interface MockBandPlans {
	view(): BandPlanStackView
	resolved(): ResolvedBandPlanView
	token(): { storeId: string; revision: number }
}

export interface MockBandPlansOptions {
	/** Called after each committed write (the server broadcasts `bandplans:changed`). */
	onCommit(token: { storeId: string; revision: number }): void
	now?: () => number
}

class BandPlansFailure extends Error {
	readonly code: BandPlansErrorCode
	readonly current: { storeId: string; revision: number } | undefined
	constructor(
		code: BandPlansErrorCode,
		current?: { storeId: string; revision: number },
	) {
		super(BANDPLANS_ERROR_DEFINITIONS[code][1])
		this.code = code
		this.current = current
	}
}

function sendFailure(reply: FastifyReply, failure: BandPlansFailure) {
	return reply.code(BANDPLANS_ERROR_DEFINITIONS[failure.code][0]).send({
		error: "BandPlansError",
		code: failure.code,
		message: BANDPLANS_ERROR_DEFINITIONS[failure.code][1],
		...(failure.code === "BANDPLANS_CONFLICT" && failure.current
			? { details: { current: failure.current } }
			: {}),
	})
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

const sha256 = (text: string | Buffer) =>
	createHash("sha256").update(text).digest("hex")

// ---- the International file (Arrin-KN1E/SDR-Band-Plans, as the Settings board reads it)

export const INTERNATIONAL_URL =
	"https://raw.githubusercontent.com/Arrin-KN1E/SDR-Band-Plans/main/International.csv"

type Row = readonly [string, number, number, string]
const INTERNATIONAL_ROWS: readonly Row[] = [
	["CB", 26.965, 27.405, "CB"],
	["10m Amateur", 28, 29.7, "Amateur"],
	["VHF Low Band", 30, 50, "Land mobile"],
	["6m Amateur", 50, 54, "Amateur"],
	["TV Ch 2-6", 54, 88, "TV"],
	["FM Broadcast", 87.5, 108, "Broadcast"],
	["Aircraft Navigation", 108, 118, "Aviation"],
	["Aircraft Voice", 118, 137, "Aviation"],
	["Weather Satellites", 137, 138, "Satellite"],
	["2m Amateur", 144, 148, "Amateur"],
	["Marine VHF", 156, 162.025, "Marine"],
	["NOAA Weather Radio", 162.4, 162.55, "Weather"],
	["1.25m Amateur", 222, 225, "Amateur"],
	["Military Aircraft", 225, 380, "Military"],
	["70cm Amateur", 420, 450, "Amateur"],
	["FRS / GMRS", 462.5625, 467.7125, "Personal"],
	["Cellular 850", 824, 894, "Cellular"],
	["ADS-B", 1089, 1091, "Aviation"],
]
/** The newer file "Check for update" finds: 2 bands changed, 1 added. */
const INTERNATIONAL_ROWS_V2: readonly Row[] = [
	...INTERNATIONAL_ROWS.map(
		(r): Row =>
			r[0] === "Marine VHF"
				? [r[0], 156, 162.05, r[3]]
				: r[0] === "70cm Amateur"
					? [r[0], 430, 440, r[3]]
					: r,
	),
	["PMR446", 446, 446.2, "Personal"],
]

const csvOf = (rows: readonly Row[]) =>
	[
		"# International band plan · Arrin-KN1E · CC0",
		"name,start_mhz,end_mhz,type",
		...rows.map(r => `${r[0]},${r[1]},${r[2]},${r[3]}`),
	].join("\n") + "\n"
export const INTERNATIONAL_CSV = csvOf(INTERNATIONAL_ROWS)
const INTERNATIONAL_CSV_V2 = csvOf(INTERNATIONAL_ROWS_V2)

/** Source `type` to a display group, the way core's import table and name keywords map them. */
const GROUP_TABLE: Readonly<Record<string, DisplayGroup>> = {
	amateur: "amateur",
	ham: "amateur",
	broadcast: "broadcast",
	aviation: "air",
	air: "air",
	marine: "marine",
	cb: "personal-radio",
	personal: "personal-radio",
	pmr: "personal-radio",
	"land mobile": "land-mobile",
	public: "land-mobile",
	ism: "ism-srd",
	srd: "ism-srd",
	pager: "pagers",
	pagers: "pagers",
}

interface ParsedRow {
	name: string
	startHz: number
	endHz: number
	type: string
	colour: string | null
}

/** A tiny reader for the mock: SDR++ JSON (Hz edges) and the CSV above (MHz edges). */
function parseFile(
	format: BandPlanImportFormat,
	text: string,
): { meta: ImportPreview["meta"]; rows: ParsedRow[]; total: number } {
	if (format === "sdrpp-json") {
		let json: unknown
		try {
			json = JSON.parse(text)
		} catch {
			throw new BandPlansFailure("BANDPLANS_IMPORT_INVALID")
		}
		if (!isRecord(json) || !Array.isArray(json["bands"]))
			throw new BandPlansFailure("BANDPLANS_IMPORT_INVALID")
		const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null)
		const rows: ParsedRow[] = []
		for (const b of json["bands"]) {
			if (!isRecord(b)) continue
			const name = str(b["name"])
			const start = Number(b["start"])
			const end = Number(b["end"])
			if (!name || !(start > 0) || !(end > start)) continue
			rows.push({
				name,
				startHz: Math.round(start),
				endHz: Math.round(end),
				type: str(b["type"]) ?? "",
				colour: null,
			})
		}
		return {
			meta: {
				name: str(json["name"]),
				countryName: str(json["country_name"]),
				countryCode: str(json["country_code"]),
				author: str(json["author_name"]),
				version: null,
			},
			rows,
			total: json["bands"].length,
		}
	}
	if (format === "gqrx-csv") {
		const lines = text
			.split(/\r?\n/)
			.map(l => l.trim())
			.filter(l => l && !l.startsWith("#") && !l.startsWith("name,"))
		const rows: ParsedRow[] = []
		for (const line of lines) {
			const [name, a, b, type] = line.split(",").map(x => x.trim())
			const start = Number(a)
			const end = Number(b)
			if (!name || !(start > 0) || !(end > start)) continue
			rows.push({
				name,
				startHz: Math.round(start * 1e6),
				endHz: Math.round(end * 1e6),
				type: type ?? "",
				colour: null,
			})
		}
		if (!rows.length) throw new BandPlansFailure("BANDPLANS_IMPORT_INVALID")
		const author = /·\s*([^·]+?)\s*·/.exec(lines[0] ?? text)?.[1] ?? null
		return {
			meta: {
				name: null,
				countryName: null,
				countryCode: null,
				author: author ?? (text.includes("Arrin-KN1E") ? "Arrin-KN1E" : null),
				version: null,
			},
			rows,
			total: lines.length,
		}
	}
	throw new BandPlansFailure("BANDPLANS_IMPORT_INVALID")
}

const slugOf = (s: string) =>
	s
		.toLowerCase()
		.normalize("NFD")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48) || "band"

function previewOf(
	format: BandPlanImportFormat,
	fileName: string,
	bytes: Buffer,
	overrides: readonly ImportGroupOverride[],
	sourceUrl: string | null,
): ImportPreview {
	const parsed = parseFile(format, bytes.toString("utf8"))
	const mapping = new Map<string, ImportGroupMappingRow>()
	const ids = new Set<string>()
	const bands: Band[] = []
	for (const row of parsed.rows.slice(0, BANDPLANS_LIMITS.bandsPerPack)) {
		const t = row.type.slice(0, 64)
		const override = overrides.find(o => o.sourceType === t)
		const table = GROUP_TABLE[t.toLowerCase()]
		const group: DisplayGroup = override?.group ?? table ?? "other"
		const rule = override ? "override" : table ? "table" : "fallback-other"
		const m = mapping.get(t)
		mapping.set(t, {
			sourceType: t,
			group,
			rule,
			count: (m?.count ?? 0) + 1,
		})
		let id = slugOf(row.name)
		for (let n = 2; ids.has(id); n++) id = `${slugOf(row.name)}-${n}`
		ids.add(id)
		bands.push({
			id,
			name: row.name.slice(0, 80),
			startHz: row.startHz,
			endHz: row.endHz,
			group,
			mode: null,
			bandwidthHz: null,
			stepHz: null,
			skip: null,
			channels: [],
			parentId: null,
			colourHint: row.colour,
			registryRef: null,
			scan: null,
			provenance: { kind: "imported" },
		})
	}
	const groupMapping = [...mapping.values()].sort((a, b) =>
		a.sourceType < b.sourceType ? -1 : a.sourceType > b.sourceType ? 1 : 0,
	)
	const toOther = bands.filter(b => b.group === "other").length
	const sha = sha256(bytes)
	return {
		format,
		fileName,
		bytes: bytes.length,
		sha256: sha,
		previewDigest: sha256(
			`${sha}\n${JSON.stringify(overrides)}\n${sourceUrl ?? ""}`,
		),
		meta: parsed.meta,
		trust: "community-unverified",
		bands,
		report: {
			rowsTotal: parsed.total,
			accepted: bands.length,
			skipped:
				parsed.total > bands.length
					? [{ reason: "malformed-row", count: parsed.total - bands.length }]
					: [],
			groupMapping,
			mapped: bands.length - toOther,
			toOther,
			colourHints: bands.filter(b => b.colourHint !== null).length,
		},
	}
}

// ---- state

interface State {
	storeId: string
	revision: number
	/** null: the default stack (France, CEPT / EU). */
	stack: PlanStackEntry[] | null
	imported: BandPlanPack[]
	operatorBands: Band[]
	edits: BandEdit[]
	presets: OperatorScanPreset[]
}

const PACK_NAMES = {
	"builtin-fr": "France",
	"builtin-eu": "CEPT / EU baseline",
} as const
type BuiltinMockPack = keyof typeof PACK_NAMES
const FRANCE = "builtin-fr"
/** A core built-in id the mock never serves. */
const STAND_IN = "builtin-cn"

/** A pack band as shipped: a renamed channel goes back to its pack name and loses the alias added with it. */
function packBandOf(seed: (typeof BAND_SEEDS)[number]): Band {
	const band = toBand({ ...seed, hidden: false })
	if (!seed.channels?.some(c => c.renamed)) return band
	return {
		...band,
		channels: band.channels.map(c =>
			seed.channels?.find(s => s.id === c.id)?.renamed
				? { ...c, aliases: [] }
				: c,
		),
	}
}

const BUILTIN: readonly BandPlanPack[] = (
	Object.keys(PACK_NAMES) as BuiltinMockPack[]
).map(id => ({
	id,
	kind: "builtin",
	name: PACK_NAMES[id],
	region: "EU",
	provenance: { kind: "builtin" },
	bands: BAND_SEEDS.filter(s => s.from === id).map(packBandOf),
}))

const DEFAULT_STACK: readonly PlanStackEntry[] = [
	{ packId: "builtin-fr", enabled: true },
	{ packId: "builtin-eu", enabled: true },
]

const ORDER = new Map(BAND_EDIT_FIELDS.map((f, i) => [f, i]))
const editedFieldsOf = (set: BandEditFields) =>
	(Object.keys(set) as (keyof BandEditFields)[]).sort(
		(a, b) => (ORDER.get(a) ?? 0) - (ORDER.get(b) ?? 0),
	)

function applyEdit(band: Band, set: BandEditFields | undefined): Band {
	if (!set) return band
	const out: Record<string, unknown> = { ...band }
	for (const [key, value] of Object.entries(set))
		if (key !== "hidden" && value !== undefined) out[key] = value
	return out as unknown as Band
}

export function registerBandPlansMock(
	app: FastifyInstance,
	options: MockBandPlansOptions,
): MockBandPlans {
	const now = options.now ?? Date.now
	const seededAt = new Date(now() - 5 * 86_400_000).toISOString()
	const intlId = `imported-${sha256(INTERNATIONAL_CSV).slice(0, 12)}`
	const intlPreview = previewOf(
		"gqrx-csv",
		"International.csv",
		Buffer.from(INTERNATIONAL_CSV),
		[],
		INTERNATIONAL_URL,
	)
	const state: State = {
		storeId: randomUUID(),
		revision: 1,
		stack: [...DEFAULT_STACK, { packId: intlId, enabled: false }],
		imported: [
			{
				id: intlId,
				kind: "imported",
				name: "International",
				region: null,
				provenance: {
					kind: "imported",
					trust: "community-unverified",
					format: "gqrx-csv",
					sourceName: "International.csv",
					author: "Arrin-KN1E",
					licence: "CC0",
					importedAt: seededAt,
					sha256: intlPreview.sha256,
					sourceUrl: INTERNATIONAL_URL,
				},
				bands: intlPreview.bands,
			},
		],
		operatorBands: BAND_SEEDS.filter(s => s.from === "operator").map(toBand),
		edits: BAND_SEEDS.flatMap(seed => {
			const set: BandEditFields = {}
			if (seed.hidden) set.hidden = true
			if (seed.channels?.some(c => c.renamed))
				set.channels = [...toBand(seed).channels]
			return Object.keys(set).length && seed.from !== "operator"
				? [{ packId: seed.from, bandId: seed.id, set, updatedAt: seededAt }]
				: []
		}),
		presets: [
			{
				kind: "operator",
				id: randomUUID(),
				name: "Harbour channels",
				job: {
					...presetJob([]),
					mode: "sweep",
					ranges: [
						{
							startHz: 156_500_000,
							endHz: 157_450_000,
							rasters: [{ spacingHz: 25_000, firstChannelHz: 156_500_000 }],
							obwHz: [],
							protocols: ["analog-fm"],
						},
					],
					sensitivity: "high",
				},
				createdAt: seededAt,
				updatedAt: seededAt,
			},
		],
	}

	const token = () => ({ storeId: state.storeId, revision: state.revision })
	const store = () => ({ state: "available" as const, ...token() })
	const stack = () => state.stack ?? [...DEFAULT_STACK]
	const packs = (): BandPlanPack[] => [...BUILTIN, ...state.imported]
	const packOf = (id: string) => packs().find(p => p.id === id)
	const editOf = (packId: string, bandId: string) =>
		state.edits.find(e => e.packId === packId && e.bandId === bandId)

	const view = (): BandPlanStackView => ({
		schemaVersion: 1,
		store: store(),
		context: { region: "EU", effectiveCountry: "FR" },
		capabilities: {
			writable: true,
			importFormats: [...BANDPLAN_IMPORT_FORMATS],
			urlImportHosts: [...BANDPLAN_URL_IMPORT_HOSTS],
		},
		stack: {
			source: state.stack ? "operator" : "default",
			entries: stack().map(e => {
				const p = packOf(e.packId)
				return {
					...e,
					kind: p?.kind ?? "imported",
					name: p?.name ?? e.packId,
				}
			}),
		},
		packs: packs().map(p => ({
			id: p.id,
			kind: p.kind,
			name: p.name,
			region: p.region,
			provenance: p.provenance,
			bandCount: p.bands.length,
			editCount: state.edits.filter(e => e.packId === p.id).length,
		})),
		operatorBands: structuredClone(state.operatorBands),
		edits: structuredClone(state.edits),
		orphanedEdits: state.edits
			.filter(e => !packOf(e.packId)?.bands.some(b => b.id === e.bandId))
			.map(e => ({ packId: e.packId, bandId: e.bandId })),
		limits: BANDPLANS_LIMITS,
	})

	/** src/core/bandplans/resolve.ts: the operator layer, then enabled stack entries; higher layers win. */
	const resolved = (): ResolvedBandPlanView => {
		const layers: {
			packId: string
			bands: Band[]
			pack: BandPlanPack | null
		}[] = [{ packId: "operator", bands: state.operatorBands, pack: null }]
		for (const e of stack()) {
			const p = packOf(e.packId)
			if (e.enabled && p)
				layers.push({ packId: p.id, bands: [...p.bands], pack: p })
		}
		let cover: Interval[] = []
		const bands: ResolvedBand[] = []
		const shadowed: string[] = []
		const hidden: string[] = []
		layers.forEach((layer, index) => {
			const visible: Interval[] = []
			for (const original of layer.bands) {
				const key = `${layer.packId}/${original.id}`
				const edit = layer.pack ? editOf(layer.packId, original.id) : undefined
				if (edit?.set.hidden) {
					hidden.push(key)
					continue
				}
				const band = applyEdit(original, edit?.set)
				const segments = subtract(band.startHz, band.endHz, cover)
				if (segments.length === 0) shadowed.push(key)
				else
					bands.push({
						key,
						packId: layer.packId,
						bandId: band.id,
						layer: index,
						band,
						segments,
						editedFields: edit ? editedFieldsOf(edit.set) : [],
						issues:
							band.parentId !== null &&
							!layer.bands.some(b => b.id === band.parentId)
								? ["dangling-parent"]
								: [],
						provenance: band.provenance,
						packProvenance: layer.pack?.provenance ?? { kind: "operator" },
					})
				visible.push({ startHz: band.startHz, endHz: band.endHz })
			}
			cover = merge([...cover, ...visible])
		})
		bands.sort((a, b) => {
			const d = (a.segments[0]?.startHz ?? 0) - (b.segments[0]?.startHz ?? 0)
			if (d !== 0) return d
			if (a.layer !== b.layer) return a.layer - b.layer
			return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
		})
		return {
			store: store(),
			context: { region: "EU", effectiveCountry: "FR" },
			bands,
			shadowed: shadowed.sort(),
			hidden: hidden.sort(),
		}
	}

	/** src/core/bandplans/presets.ts: one built-in per scanner band plan, then the combinations, then yours. */
	const builtinPresets = (): ScanPreset[] => {
		const ids = new Set(SCANNER_BANDPLANS.map(p => p.id))
		return [
			...SCANNER_BANDPLANS.map(
				(p): ScanPreset => ({
					kind: "builtin",
					id: `builtin-${p.id}`,
					name: p.name,
					region: "EU",
					job: presetJob([p.id]),
				}),
			),
			...PRESET_COMBINATIONS.flatMap(c => {
				const planIds = c.planIds.filter(id => ids.has(id))
				return planIds.length < 2
					? []
					: [
							{
								kind: "builtin" as const,
								id: c.id,
								name: c.name,
								region: "EU" as const,
								job: presetJob(planIds),
							},
						]
			}),
		]
	}
	const allPresets = (): ScanPreset[] => [
		...builtinPresets(),
		...structuredClone(state.presets),
	]
	const presetIssues = (p: ScanPreset) =>
		p.job.bandplans
			.filter(id => !SCANNER_BANDPLANS.some(b => b.id === id))
			.map(bandplanId => ({ code: "unknown-bandplan" as const, bandplanId }))
	const presetsView = (): ScanPresetListView => ({
		store: store(),
		context: { region: "EU", effectiveCountry: "FR" },
		presets: allPresets().map(preset => {
			const issues = presetIssues(preset)
			return { preset, applicable: issues.length === 0, issues }
		}),
	})

	const commit = (createdId: string | null = null): BandPlanWriteDto => {
		state.revision += 1
		options.onCommit(token())
		return { view: view(), createdId }
	}

	const decode = (base64: string) => Buffer.from(base64, "base64")

	const apply = (m: BandPlanMutation): BandPlanWriteDto => {
		if (
			m.expected.storeId !== state.storeId ||
			m.expected.revision !== state.revision
		)
			throw new BandPlansFailure("BANDPLANS_CONFLICT", token())
		switch (m.type) {
			case "set-stack": {
				if (m.entries.some(e => !packOf(e.packId)))
					throw new BandPlansFailure("BANDPLANS_NOT_FOUND")
				state.stack = m.entries.map(e => ({ ...e }))
				return commit()
			}
			case "reset-stack":
				state.stack = null
				return commit()
			case "patch-band-edit": {
				if (!packOf(m.packId)?.bands.some(b => b.id === m.bandId))
					throw new BandPlansFailure("BANDPLANS_NOT_FOUND")
				const prev = editOf(m.packId, m.bandId)
				const set: Record<string, unknown> = { ...(prev?.set ?? {}) }
				for (const key of m.reset) delete set[key]
				Object.assign(set, m.set ?? {})
				state.edits = state.edits.filter(e => e !== prev)
				if (Object.keys(set).length)
					state.edits.push({
						packId: m.packId,
						bandId: m.bandId,
						set: set as BandEditFields,
						updatedAt: new Date(now()).toISOString(),
					})
				return commit()
			}
			case "reset-band-edits":
				state.edits = state.edits.filter(
					e => !(e.packId === m.packId && e.bandId === m.bandId),
				)
				return commit()
			case "reset-pack-edits":
				state.edits = state.edits.filter(e => e.packId !== m.packId)
				return commit()
			case "delete-pack": {
				if (!state.imported.some(p => p.id === m.packId))
					throw new BandPlansFailure("BANDPLANS_NOT_FOUND")
				state.imported = state.imported.filter(p => p.id !== m.packId)
				if (state.stack)
					state.stack = state.stack.filter(e => e.packId !== m.packId)
				state.edits = state.edits.filter(e => e.packId !== m.packId)
				return commit()
			}
			case "create-operator-band": {
				if (state.operatorBands.length >= BANDPLANS_LIMITS.operatorBands)
					throw new BandPlansFailure("BANDPLANS_QUOTA")
				let id = slugOf(m.band.name)
				for (let n = 2; state.operatorBands.some(b => b.id === id); n++)
					id = `${slugOf(m.band.name)}-${n}`
				state.operatorBands.push({
					...m.band,
					id,
					scan: null,
					provenance: { kind: "operator" },
				})
				return commit(id)
			}
			case "replace-operator-band": {
				const i = state.operatorBands.findIndex(b => b.id === m.bandId)
				if (i < 0) throw new BandPlansFailure("BANDPLANS_NOT_FOUND")
				state.operatorBands[i] = {
					...m.band,
					id: m.bandId,
					scan: null,
					provenance: { kind: "operator" },
				}
				return commit()
			}
			case "delete-operator-band":
				if (!state.operatorBands.some(b => b.id === m.bandId))
					throw new BandPlansFailure("BANDPLANS_NOT_FOUND")
				state.operatorBands = state.operatorBands.filter(b => b.id !== m.bandId)
				return commit()
			case "commit-import": {
				const bytes = decode(m.contentBase64)
				const sourceUrl = m.sourceUrl ?? null
				const preview = previewOf(
					m.format,
					m.fileName,
					bytes,
					m.groupOverrides,
					sourceUrl,
				)
				if (preview.previewDigest !== m.previewDigest)
					throw new BandPlansFailure("BANDPLANS_IMPORT_MISMATCH")
				const replaced = m.replacesPackId
					? state.imported.find(p => p.id === m.replacesPackId)
					: undefined
				if (m.replacesPackId && !replaced)
					throw new BandPlansFailure("BANDPLANS_NOT_FOUND")
				if (
					!replaced &&
					state.imported.length >= BANDPLANS_LIMITS.importedPacks
				)
					throw new BandPlansFailure("BANDPLANS_QUOTA")
				const id = replaced?.id ?? `imported-${preview.sha256.slice(0, 12)}`
				const provenance: ImportedProvenance = {
					kind: "imported",
					trust: "community-unverified",
					format: m.format,
					sourceName: m.fileName,
					author: m.author ?? preview.meta.author,
					licence: m.licence,
					importedAt: new Date(now()).toISOString(),
					sha256: preview.sha256,
					...(sourceUrl ? { sourceUrl } : {}),
					...(m.groupOverrides.length
						? { groupOverrides: m.groupOverrides }
						: {}),
				}
				const pack: BandPlanPack = {
					id,
					kind: "imported",
					name:
						m.name ?? preview.meta.name ?? m.fileName.replace(/\.[a-z]+$/i, ""),
					region: null,
					provenance,
					bands: preview.bands.map(b =>
						m.keepColourHints ? b : { ...b, colourHint: null },
					),
				}
				state.imported = [...state.imported.filter(p => p.id !== id), pack]
				if (m.addToStack) {
					const entries = stack().filter(e => e.packId !== id)
					const at = stack().findIndex(e => e.packId === id)
					const entry = { packId: id, enabled: true }
					if (at >= 0 && replaced) entries.splice(at, 0, entry)
					else entries.push(entry)
					state.stack = entries
				}
				return commit(id)
			}
			case "create-preset": {
				if (state.presets.length >= BANDPLANS_LIMITS.presets)
					throw new BandPlansFailure("BANDPLANS_QUOTA")
				const at = new Date(now()).toISOString()
				const id = randomUUID()
				state.presets.push({
					kind: "operator",
					id,
					name: m.preset.name,
					job: m.preset.job,
					createdAt: at,
					updatedAt: at,
				})
				return commit(id)
			}
			case "replace-preset": {
				const i = state.presets.findIndex(p => p.id === m.presetId)
				const prev = state.presets[i]
				if (!prev) throw new BandPlansFailure("BANDPLANS_NOT_FOUND")
				state.presets[i] = {
					...prev,
					name: m.preset.name,
					job: m.preset.job,
					updatedAt: new Date(now()).toISOString(),
				}
				return commit()
			}
			case "delete-preset":
				if (!state.presets.some(p => p.id === m.presetId))
					throw new BandPlansFailure("BANDPLANS_NOT_FOUND")
				state.presets = state.presets.filter(p => p.id !== m.presetId)
				return commit()
			default:
				throw new BandPlansFailure("BANDPLANS_INVALID")
		}
	}

	const parse = (
		type: BandPlanMutation["type"],
		request: FastifyRequest,
		keys: readonly string[],
		ids: Readonly<Record<string, string>> = {},
	): BandPlanMutation => {
		const body: unknown = request.body ?? {}
		if (!isRecord(body)) throw new BandPlansFailure("BANDPLANS_INVALID")
		if (body["expected"] === undefined)
			throw new BandPlansFailure("BANDPLANS_PRECONDITION_REQUIRED")
		const input: Record<string, unknown> = { type, ...ids }
		for (const key of keys) if (Object.hasOwn(body, key)) input[key] = body[key]
		if (type === "patch-band-edit") {
			input["set"] ??= null
			input["reset"] ??= []
		}
		// The canvas's France pack has no core id (core ships one pack per region): it stands in for
		// a built-in id while the core schema checks the body, then gets its own id back.
		const swap = (from: string, to: string) => (v: unknown) =>
			JSON.parse(
				JSON.stringify(v).replaceAll(`"${from}"`, `"${to}"`),
			) as unknown
		const result = bandPlanMutationSchema.safeParse(
			swap(FRANCE, STAND_IN)(input),
		)
		if (!result.success) throw new BandPlansFailure("BANDPLANS_INVALID")
		return swap(STAND_IN, FRANCE)(result.data) as BandPlanMutation
	}

	const handle =
		(run: (request: FastifyRequest) => unknown, status: 200 | 201 = 200) =>
		async (request: FastifyRequest, reply: FastifyReply) => {
			try {
				const out = await run(request)
				return reply.code(status).send(out)
			} catch (error) {
				if (error instanceof BandPlansFailure) return sendFailure(reply, error)
				throw error
			}
		}
	const param = (request: FastifyRequest, key: string) =>
		String((request.params as Record<string, string>)[key] ?? "")

	app.get("/api/bandplans", async () => view())
	app.get("/api/bandplans/resolved", async () => resolved())
	app.get("/api/bandplans/presets", async () => presetsView())
	app.get(
		"/api/bandplans/presets/:presetId/job",
		handle(request => {
			const preset = allPresets().find(p => p.id === param(request, "presetId"))
			if (!preset) throw new BandPlansFailure("BANDPLANS_NOT_FOUND")
			return {
				presetId: preset.id,
				region: "EU",
				spec: presetToJobSpec(preset),
				issues: presetIssues(preset),
			}
		}),
	)
	app.get(
		"/api/bandplans/packs/:packId",
		handle(request => {
			const pack = packOf(param(request, "packId"))
			if (!pack) throw new BandPlansFailure("BANDPLANS_NOT_FOUND")
			return { store: store(), pack }
		}),
	)

	const COMMIT_KEYS = [
		"format",
		"fileName",
		"contentBase64",
		"groupOverrides",
		"expected",
		"previewDigest",
		"name",
		"author",
		"licence",
		"keepColourHints",
		"replacesPackId",
		"addToStack",
		"sourceUrl",
	]
	const routes: readonly [
		"PUT" | "PATCH" | "POST" | "DELETE",
		string,
		BandPlanMutation["type"],
		readonly string[],
		200 | 201,
		readonly string[],
	][] = [
		[
			"PUT",
			"/api/bandplans/stack",
			"set-stack",
			["expected", "entries"],
			200,
			[],
		],
		["DELETE", "/api/bandplans/stack", "reset-stack", ["expected"], 200, []],
		[
			"PATCH",
			"/api/bandplans/packs/:packId/bands/:bandId/edit",
			"patch-band-edit",
			["expected", "set", "reset"],
			200,
			["packId", "bandId"],
		],
		[
			"DELETE",
			"/api/bandplans/packs/:packId/bands/:bandId/edit",
			"reset-band-edits",
			["expected"],
			200,
			["packId", "bandId"],
		],
		[
			"DELETE",
			"/api/bandplans/packs/:packId/edits",
			"reset-pack-edits",
			["expected"],
			200,
			["packId"],
		],
		[
			"DELETE",
			"/api/bandplans/packs/:packId",
			"delete-pack",
			["expected"],
			200,
			["packId"],
		],
		[
			"POST",
			"/api/bandplans/operator-bands",
			"create-operator-band",
			["expected", "band"],
			201,
			[],
		],
		[
			"PUT",
			"/api/bandplans/operator-bands/:bandId",
			"replace-operator-band",
			["expected", "band"],
			200,
			["bandId"],
		],
		[
			"DELETE",
			"/api/bandplans/operator-bands/:bandId",
			"delete-operator-band",
			["expected"],
			200,
			["bandId"],
		],
		["POST", "/api/bandplans/imports", "commit-import", COMMIT_KEYS, 201, []],
		[
			"POST",
			"/api/bandplans/presets",
			"create-preset",
			["expected", "preset"],
			201,
			[],
		],
		[
			"PUT",
			"/api/bandplans/presets/:presetId",
			"replace-preset",
			["expected", "preset"],
			200,
			["presetId"],
		],
		[
			"DELETE",
			"/api/bandplans/presets/:presetId",
			"delete-preset",
			["expected"],
			200,
			["presetId"],
		],
	]
	for (const [method, url, type, keys, status, params] of routes)
		app.route({
			method,
			url,
			bodyLimit: BANDPLANS_LIMITS.importRequestBytes,
			handler: handle(request => {
				const ids: Record<string, string> = {}
				for (const p of params) ids[p] = param(request, p)
				return apply(parse(type, request, keys, ids))
			}, status),
		})

	app.post(
		"/api/bandplans/imports/preview",
		{ bodyLimit: BANDPLANS_LIMITS.importRequestBytes },
		handle(request => {
			const result = importPreviewRequestSchema.safeParse(request.body)
			if (!result.success) throw new BandPlansFailure("BANDPLANS_INVALID")
			const r = result.data
			const bytes = decode(r.contentBase64)
			if (bytes.length > BANDPLANS_LIMITS.importFileBytes)
				throw new BandPlansFailure("BANDPLANS_IMPORT_TOO_LARGE")
			return previewOf(r.format, r.fileName, bytes, r.groupOverrides, null)
		}),
	)

	const urlPreview = (
		url: string,
		format: BandPlanImportFormat,
		overrides: readonly ImportGroupOverride[],
		text: string,
	): ImportUrlPreview => {
		const bytes = Buffer.from(text)
		const name = decodeURIComponent(url.split("/").pop() ?? "plan")
		return {
			...previewOf(format, name, bytes, overrides, url),
			sourceUrl: url,
			contentBase64: bytes.toString("base64"),
		}
	}
	app.post(
		"/api/bandplans/imports/preview-url",
		handle(request => {
			const result = importUrlPreviewRequestSchema.safeParse(request.body)
			if (!result.success) throw new BandPlansFailure("BANDPLANS_INVALID")
			const { url, format, groupOverrides } = result.data
			if (!BANDPLAN_URL_IMPORT_HOSTS.includes(new URL(url).host))
				throw new BandPlansFailure("BANDPLANS_URL_REFUSED")
			if (format !== "gqrx-csv")
				throw new BandPlansFailure("BANDPLANS_IMPORT_INVALID")
			return urlPreview(url, format, groupOverrides, INTERNATIONAL_CSV)
		}),
	)
	app.post(
		"/api/bandplans/packs/:packId/check-update",
		handle((request): BandPlanUpdateCheck => {
			const pack = state.imported.find(p => p.id === param(request, "packId"))
			if (!pack || pack.provenance.kind !== "imported")
				throw new BandPlansFailure("BANDPLANS_NOT_FOUND")
			const prov = pack.provenance
			if (!prov.sourceUrl)
				throw new BandPlansFailure("BANDPLANS_URL_IMPORT_DISABLED")
			const fetched = urlPreview(
				prov.sourceUrl,
				prov.format,
				prov.groupOverrides ?? [],
				INTERNATIONAL_CSV_V2,
			)
			const upToDate = fetched.sha256 === prov.sha256
			const pick = (b: Band) => ({
				id: b.id,
				name: b.name,
				startHz: b.startHz,
				endHz: b.endHz,
			})
			const old = new Map(pack.bands.map(b => [b.id, b]))
			const fresh = new Map(fetched.bands.map(b => [b.id, b]))
			const fieldsOf = (a: Band, b: Band) =>
				(["name", "startHz", "endHz", "group"] as const).filter(
					k => a[k] !== b[k],
				)
			return {
				packId: pack.id,
				sourceUrl: prov.sourceUrl,
				checkedAt: new Date(now()).toISOString(),
				currentSha256: prov.sha256,
				fetchedSha256: fetched.sha256,
				upToDate,
				added: upToDate
					? []
					: fetched.bands.filter(b => !old.has(b.id)).map(pick),
				removed: upToDate
					? []
					: pack.bands.filter(b => !fresh.has(b.id)).map(pick),
				changed: upToDate
					? []
					: fetched.bands.flatMap(b => {
							const a = old.get(b.id)
							const fields = a ? fieldsOf(a, b) : []
							return fields.length ? [{ ...pick(b), fields }] : []
						}),
				preview: upToDate ? null : fetched,
			}
		}),
	)

	return { view, resolved, token }
}
