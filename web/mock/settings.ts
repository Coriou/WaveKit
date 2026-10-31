/**
 * Mock Settings routes (registered from one marked block in server.ts), answered as a protected
 * core answers them although the mock is otherwise a legacy core:
 *
 * - GET / PATCH /api/station (WG4): provenance per field (country pinned by YAML), the UI-layer
 *   revision as If-Match, core's validation order and error bodies, `changed`, `appliesOnRestart`
 *   (readsb when the location moves), `restartRequired` (country) and `coverageCleared`.
 *   `writable: true` as on a protected core (a legacy core mounts the GET only).
 * - GET /api/decoders/types with the core's option descriptors (./decoder-options.ts),
 *   GET /api/decoders/:id/settings and the WG8 merge patch PATCH /api/decoders/:id (a legacy core
 *   answers the view 404 and the PATCH 501), POST start / stop / restart, GET /api/decoders/:id/log.
 * - GET /api/storage (WG4 storage report) and GET /api/config/export (WG6, redacted YAML).
 */
import type { FastifyInstance, FastifyReply } from "fastify"
import {
	CONFIG_EXPORT_CONTENT_TYPE,
	CONFIG_EXPORT_FILE_NAME,
	CONFIG_EXPORT_REDACTED,
	CONFIG_EXPORT_ROUTE,
	STATION_FIELDS,
	STORAGE_AREA_CLASS,
	STORAGE_AREA_IDS,
} from "@wavekit/api-types"
import type {
	DecoderInfo,
	EfficiencyBudgetConflict,
	EfficiencyBudgetSettings,
	EfficiencyBudgetValue,
	DecoderMode,
	DecoderLogLine,
	DecoderOptionDescriptor,
	DecoderOptionIssue,
	DecoderOptionSetting,
	DecoderSettingSource,
	DecoderSettingValue,
	DecoderSettingsErrorBody,
	DecoderSettingsUpdateResult,
	DecoderSettingsView,
	DecoderTypeInfo,
	StationErrorBody,
	StationErrorCode,
	StationField,
	StationIdentity,
	StationProvenance,
	StationUpdateResult,
	StorageArea,
	StorageReport,
} from "@wavekit/api-types"
import { MOCK_DECODER_OPTIONS } from "./decoder-options.ts"

export const MOCK_VERSION = "1.0.0-mock"

export interface SettingsMockContext {
	/** Current decoder statuses (lifecycle applied). */
	decoders(): DecoderInfo[]
	broadcast(channel: string, type: string, data: unknown): void
	lifecycle: DecoderLifecycle
	now?: () => number
}

export interface SettingsMock {
	station(): StationIdentity
	/** Decoder settings view (tests). */
	decoderView(id: string): DecoderSettingsView | undefined
	/** True once the CPU budget was saved away from its default "auto". */
	budgetRaised(): boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.getPrototypeOf(value) === Object.prototype
	)
}

const sendJson = (reply: FastifyReply, status: number, body: unknown) =>
	reply.code(status).header("Cache-Control", "no-store").send(body)

const decoderNotFound = (id: string) => ({
	error: "NotFound",
	code: "DECODER_NOT_FOUND",
	message: `Decoder with id '${id}' not found`,
})

// ---- decoder lifecycle (start / stop / restart over the computed statuses)

export interface DecoderLifecycle {
	/** Applies operator starts and stops to the statuses built from the tuner position. */
	adjust(list: DecoderInfo[]): DecoderInfo[]
	setIntent(id: string, intent: "stopped" | "operator"): void
	restarted(id: string): void
	/** The settings-store mode (decoder enablement 2.5): applies at once; undefined is the default auto. */
	setMode(id: string, mode: DecoderMode | undefined): void
}

export function createDecoderLifecycle(
	now: () => number = Date.now,
): DecoderLifecycle {
	const intent = new Map<string, { kind: "stopped" | "operator"; at: number }>()
	const modes = new Map<string, DecoderMode>()
	return {
		adjust(list) {
			return list.map(base => {
				const mode = modes.get(base.id)
				const d: DecoderInfo = {
					...base,
					mode: mode ?? "auto",
					modeSource: mode ? "settings" : "default",
				}
				// Always is a band pin: a band pause does not apply.
				if (mode === "always" && d.suspended && !intent.has(d.id)) {
					const pinned: DecoderInfo = {
						...d,
						running: true,
						suspended: false,
						health: "running",
						pid: d.pid ?? 4300,
					}
					delete pinned.suspension
					return pinned
				}
				const set = intent.get(d.id)
				if (!set) return d
				// An explicit start or restart resets restartCount (core's DecoderLastError rule).
				const next: DecoderInfo = { ...d, restartCount: 0 }
				delete next.suspension
				delete next.transition
				delete next.lastError
				if (set.kind === "stopped") {
					delete next.pid
					delete next.startMode
					return {
						...next,
						running: false,
						desiredRunning: false,
						suspended: false,
						health: "idle",
						uptime: 0,
					}
				}
				return {
					...next,
					running: true,
					desiredRunning: true,
					suspended: false,
					health: "running",
					startMode: "operator",
					pid: d.pid ?? 4200,
					uptime: Math.round((now() - set.at) / 1000),
				}
			})
		},
		setIntent(id, kind) {
			intent.set(id, { kind, at: now() })
		},
		restarted(id) {
			intent.set(id, { kind: "operator", at: now() })
		},
		setMode(id, mode) {
			const was = modes.get(id) ?? "auto"
			if (mode === undefined) modes.delete(id)
			else modes.set(id, mode)
			const next = mode ?? "auto"
			if (next === "off") intent.set(id, { kind: "stopped", at: now() })
			else if (was === "off" || next !== was) intent.delete(id)
		},
	}
}

// ---- station

/** The mock's config layer: country from YAML (pinned); nothing from the environment. */
const STATION_CONFIG: Partial<Record<StationField, string | number>> = {
	country: "FR",
}
const STATION_ORIGIN: Partial<Record<StationField, StationProvenance>> = {
	country: "yaml",
}
const IF_MATCH_STATION = /^(?:"(\d{1,19})"|(\d{1,19}))$/
const IF_MATCH_DECODER = /^(?:(?:W\/)?"(\d{1,19})"|(\d{1,19}))$/

class StationFailure extends Error {
	readonly code: StationErrorCode
	readonly fields: StationField[] | undefined
	constructor(
		code: StationErrorCode,
		message: string,
		fields?: StationField[],
	) {
		super(message)
		this.code = code
		this.fields = fields
	}
}

const STATION_STATUS: Record<StationErrorCode, number> = {
	STATION_UPDATE_INVALID: 400,
	STATION_FIELD_PINNED: 409,
	STATION_REVISION_MISMATCH: 412,
	STATION_STORE_UNAVAILABLE: 503,
}
const STATUS_TEXT: Record<number, string> = {
	400: "Bad Request",
	409: "Conflict",
	412: "Precondition Failed",
	503: "Service Unavailable",
}

/** StationConfigSchema's per-field rules (src/config.ts). */
function stationValue(
	field: StationField,
	raw: unknown,
): string | number | null {
	switch (field) {
		case "name":
		case "callsign": {
			if (typeof raw !== "string") return null
			const text = raw.trim()
			const max = field === "name" ? 256 : 128
			return text.length >= 1 && text.length <= max ? text : null
		}
		case "lat":
		case "lon": {
			const limit = field === "lat" ? 90 : 180
			return typeof raw === "number" &&
				Number.isFinite(raw) &&
				Math.abs(raw) <= limit
				? raw + 0
				: null
		}
		case "altM":
			return typeof raw === "number" && Number.isFinite(raw) ? raw + 0 : null
		case "country":
			return typeof raw === "string" && /^[A-Z]{2}$/.test(raw) ? raw : null
	}
}

function distanceKm(
	a: { lat: number; lon: number },
	b: { lat: number; lon: number },
): number {
	const rad = Math.PI / 180
	const dLat = (b.lat - a.lat) * rad
	const dLon = (b.lon - a.lon) * rad
	const h =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2
	return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)))
}

// ---- decoder settings

/** Configured `options` of each mock decoder (the YAML layer under the overrides). */
const DECODER_CONFIG: Readonly<Record<string, Record<string, unknown>>> = {
	"dsd-fme": {
		mode: "auto",
		frequencies: [161_150_000, 163_087_500],
		output: "null",
	},
	"ais-catcher": {
		frequencies: [161_975_000, 162_025_000],
		outputFormat: "json",
	},
	"multimon-ng": {
		modes: ["POCSAG512", "POCSAG1200", "POCSAG2400", "FLEX"],
		frequencies: [160_450_000, 431_025_000],
	},
	direwolf: { frequency: 144_800_000, callsign: "F4XYZ-10" },
	"rtl433-433": { frequency: 433_920_000 },
	"rtl433-868": { frequencies: [868_300_000, 868_950_000] },
	acarsdec: { frequencies: [131_525_000, 131_725_000, 131_825_000] },
	dumpvdl2: {
		frequencies: [136_725_000, 136_775_000, 136_875_000, 136_975_000],
	},
	meshtastic: {
		region: "EU_868",
		preset: "LongFast",
		channelKey: "AQ==",
	},
	readsb: {
		deviceSerial: "00001090",
		gain: "auto",
		lat: 48.7051,
		lon: -3.975,
		outputFormat: "beast",
	},
}

interface Override {
	mode?: DecoderMode
	enabled?: boolean
	options: Record<string, DecoderSettingValue>
}

function descriptorsOf(type: string): readonly DecoderOptionDescriptor[] {
	return Object.hasOwn(MOCK_DECODER_OPTIONS, type)
		? (MOCK_DECODER_OPTIONS[type] ?? [])
		: []
}

function isSettingValue(value: unknown): value is DecoderSettingValue {
	return (
		typeof value === "boolean" ||
		typeof value === "number" ||
		typeof value === "string" ||
		(Array.isArray(value) &&
			(value.every(v => typeof v === "string") ||
				value.every(v => typeof v === "number")))
	)
}

function range(d: DecoderOptionDescriptor): string {
	if (d.min !== undefined && d.max !== undefined)
		return ` from ${String(d.min)} to ${String(d.max)}`
	if (d.min !== undefined) return ` of at least ${String(d.min)}`
	if (d.max !== undefined) return ` of at most ${String(d.max)}`
	return ""
}

/** Core's fixed rule text (src/decoders/settings/patch-policy.ts ruleText). */
function ruleText(d: DecoderOptionDescriptor): string {
	switch (d.type) {
		case "boolean":
			return "must be true or false"
		case "integer":
			return `must be an integer${range(d)}`
		case "number":
			return `must be a number${range(d)}`
		case "enum":
			return "must be one of the documented values"
		case "string-list":
			return "must be a list of documented values within the allowed length"
		case "number-list":
			return `must be a list of numbers${range(d)} within the allowed length`
		default:
			return "invalid value"
	}
}

function inRange(d: DecoderOptionDescriptor, n: unknown): boolean {
	return (
		typeof n === "number" &&
		Number.isFinite(n) &&
		(d.min === undefined || n >= d.min) &&
		(d.max === undefined || n <= d.max)
	)
}

/** Per-key check like core's preCheck + schema: undefined when valid. */
function checkValue(
	d: DecoderOptionDescriptor,
	value: unknown,
): DecoderOptionIssue | undefined {
	const issue = (index?: number): DecoderOptionIssue => ({
		path: index === undefined ? d.key : `${d.key}.${String(index)}`,
		code: "invalid-value",
		message: ruleText(d),
	})
	const members = d.enumValues ?? []
	switch (d.type) {
		case "boolean":
			return typeof value === "boolean" ? undefined : issue()
		case "integer":
			return Number.isSafeInteger(value) && inRange(d, value)
				? undefined
				: issue()
		case "number":
			return inRange(d, value) ? undefined : issue()
		case "enum":
			return typeof value === "string" && members.includes(value)
				? undefined
				: issue()
		case "string-list":
		case "number-list": {
			if (!Array.isArray(value) || value.length === 0 || value.length > 64)
				return issue()
			for (let i = 0; i < value.length; i++) {
				const item: unknown = value[i]
				const good =
					d.type === "string-list"
						? typeof item === "string" && members.includes(item)
						: inRange(d, item)
				if (!good) return issue(i)
			}
			return undefined
		}
		default:
			return issue()
	}
}

const sameValue = (a: unknown, b: unknown) =>
	JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

// ---- storage and export

const MIB = 1024 * 1024
const GIB = 1024 * MIB

function storageReport(now: number, startedAt: number): StorageReport {
	const sizes: Record<string, [bytes: number, files: number]> = {
		activity: [118 * MIB + 412_000, 3],
		"scanner-evidence": [412 * MIB, 1_284],
		"digital-voice-wav": [1.6 * GIB, 312],
		bandplans: [18_400, 2],
		"operator-data": [6_200, 1],
		access: [3_100, 2],
		"decoder-overrides": [640, 1],
		station: [310, 1],
		logs: [74 * MIB, 9],
	}
	const areas: StorageArea[] = STORAGE_AREA_IDS.map(id => {
		const [bytes, files] = sizes[id] ?? [0, 0]
		const area: StorageArea = {
			id,
			class: STORAGE_AREA_CLASS[id],
			bytes: Math.round(bytes),
			files,
			exists: true,
			partial: false,
			partialReason: null,
			cap: null,
			retention: null,
		}
		if (id === "activity") {
			area.cap = { bytes: 256 * MIB }
			area.retention = {
				policy: "fair-share",
				effective: "fair-share",
				maxRows: 250_000,
				maxDbBytes: 256 * MIB,
				maxAgeMs: 3 * 86_400_000,
				rows: 61_942,
				oldestReceivedAt: new Date(
					Math.max(startedAt - 3 * 86_400_000, now - 3 * 86_400_000),
				).toISOString(),
				shares: [
					{
						key: "decoder:ais-catcher",
						rows: 28_410,
						bytes: 41 * MIB,
						oldestReceivedAt: null,
					},
					{
						key: "decoder:readsb",
						rows: 19_220,
						bytes: 36 * MIB,
						oldestReceivedAt: null,
					},
					{
						key: "decoder:multimon-ng",
						rows: 9_031,
						bytes: 11 * MIB,
						oldestReceivedAt: null,
					},
					{
						key: "decoder:rtl433-433",
						rows: 5_281,
						bytes: 4 * MIB,
						oldestReceivedAt: null,
					},
				],
				sharesTruncated: false,
			}
		}
		if (id === "scanner-evidence") area.cap = { bytes: 2 * GIB }
		return area
	})
	return {
		generatedAt: new Date(now).toISOString(),
		cachedUntil: new Date(now + 30_000).toISOString(),
		filesystem: {
			totalBytes: 58 * GIB,
			freeBytes: 31.4 * GIB,
			availableBytes: 28.5 * GIB,
		},
		areas,
		kept: null,
		lowSpace: {
			policy: "scanner-evidence-stops-writing",
			minFreeBytes: GIB,
			state: "ok",
		},
	}
}

function exportYaml(
	decoders: readonly DecoderInfo[],
	station: StationIdentity,
	generatedAt: string,
): string {
	const r = `"${CONFIG_EXPORT_REDACTED}"`
	const lines = [
		`# WaveKit ${MOCK_VERSION} redacted configuration export ${generatedAt}: secrets, hosts, paths, names and the station position are replaced by "${CONFIG_EXPORT_REDACTED}"`,
		"sources:",
		"  - id: rtl-0",
		"    type: rtl_tcp",
		`    host: ${r}`,
		"    port: 1234",
		"decoders:",
	]
	for (const d of decoders) {
		lines.push(`  - id: ${d.id}`, `    type: ${d.type}`, "    enabled: true")
		if (d.sourceId !== undefined) lines.push(`    sourceId: ${d.sourceId}`)
		const options = DECODER_CONFIG[d.id] ?? {}
		const keys = Object.keys(options)
		if (keys.length === 0) continue
		lines.push("    options:")
		for (const key of keys) {
			const value = options[key]
			const kept =
				typeof value === "number" ||
				typeof value === "boolean" ||
				(Array.isArray(value) && value.every(v => typeof v === "number")) ||
				["mode", "region", "preset", "outputFormat", "modes"].includes(key)
			const secret =
				/(key|psk|secret|passw|token|cred|auth|cookie|cert|salt)/i.test(key)
			lines.push(`      ${key}: ${!secret && kept ? JSON.stringify(value) : r}`)
		}
	}
	lines.push(
		"station:",
		`  name: ${station.name.value === null ? "null" : r}`,
		`  lat: ${r}`,
		`  lon: ${r}`,
		`  country: ${station.country.value ?? "null"}`,
		"region: EU",
		"",
	)
	return lines.join("\n")
}

/** Synthetic decoder output, oldest first. */
function logLines(
	d: DecoderInfo,
	count: number,
	now: number,
): DecoderLogLine[] {
	const head: DecoderLogLine[] = [
		{ stream: "stderr", line: `${d.type} ${d.version ?? ""} starting`.trim() },
		{
			stream: "stderr",
			line: d.sourceId
				? `input: ${d.sourceId}, 2400000 S/s, decimated per channel`
				: `device: rtl-sdr serial ${d.deviceSerial ?? "?"}`,
		},
		{
			stream: "stderr",
			line: `tuned to ${(d.targetFrequenciesHz ?? []).map(hz => (hz / 1e6).toFixed(4)).join(", ")} MHz`,
		},
	]
	const body: DecoderLogLine[] = []
	for (let i = 0; i < 40; i++) {
		const at = new Date(now - (40 - i) * 30_000).toISOString().slice(11, 19)
		body.push(
			i % 7 === 6
				? {
						stream: "stderr",
						line: `${at} warning: weak signal, ${String(3 + (i % 5))} CRC errors`,
					}
				: {
						stream: "stdout",
						line: `${at} stats: ${String(d.stats.eventsOut + i)} messages, ${String((i * 37) % 100)} % of time in sync`,
					},
		)
	}
	return [...head, ...body].slice(-count)
}

export function registerSettingsMock(
	app: FastifyInstance,
	ctx: SettingsMockContext,
): SettingsMock {
	const now = ctx.now ?? Date.now
	const startedAt = now()

	let cpuBudgetCores: EfficiencyBudgetValue = "auto"
	let budgetSource: NonNullable<EfficiencyBudgetSettings["source"]> = "default"
	const budgetView = (): EfficiencyBudgetSettings => ({
		source: budgetSource,
		cpuBudgetCores,
		resolved:
			cpuBudgetCores === "auto"
				? { mode: "auto", cpus: 8, cores: 4, label: "auto (8 CPUs → 4 cores)" }
				: { mode: "configured", cores: cpuBudgetCores, label: "configured" },
	})
	app.get("/api/decoders/efficiency/budget", async (_request, reply) =>
		sendJson(reply, 200, budgetView()),
	)
	app.put("/api/decoders/efficiency/budget", async (request, reply) => {
		const body = request.body
		const isBudget = (v: unknown): v is EfficiencyBudgetValue =>
			v === "auto" ||
			(typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 64)
		const value = isRecord(body) ? body["cpuBudgetCores"] : undefined
		const expected = isRecord(body) ? body["expected"] : undefined
		if (
			!isRecord(body) ||
			Object.keys(body).some(k => k !== "cpuBudgetCores" && k !== "expected") ||
			!isBudget(value) ||
			("expected" in body && !isBudget(expected))
		)
			return sendJson(reply, 400, { code: "EFFICIENCY_BUDGET_INVALID" })
		// like the core: with `expected`, save only while the stored value still equals it
		if (expected !== undefined && expected !== cpuBudgetCores)
			return sendJson(reply, 409, {
				code: "EFFICIENCY_BUDGET_CONFLICT",
				current: budgetView(),
			} satisfies EfficiencyBudgetConflict)
		cpuBudgetCores = value
		budgetSource = "saved"
		return sendJson(reply, 200, budgetView())
	})
	app.get("/api/decoders/efficiency", async () => {
		const budget = budgetView().resolved
		const sources = new Map<string, number>()
		for (const decoder of ctx.decoders()) {
			if (!decoder.running || decoder.suspended) continue
			const sourceId = decoder.sourceId ?? "mock-source"
			sources.set(sourceId, (sources.get(sourceId) ?? 0) + 0.25)
		}
		return {
			budgetCores: budget.cores,
			budget,
			cpuGuardPercent: 85,
			sources: [...sources].map(([sourceId, coresInUse]) => ({
				sourceId,
				coresInUse,
				cpu: { percent: null, limit: 85 },
				drops: "unknown",
				dropBytesPerSecond: null,
				admitted: [],
				blocked: [],
			})),
		}
	})

	// --- station state: the persisted UI layer
	let stationRevision = 2
	const ui: Partial<Record<StationField, string | number>> = {
		name: "Roscoff harbour",
		lat: 48.7051,
		lon: -3.975,
		altM: 18,
	}
	const stationValueOf = (field: StationField) => {
		const configured = STATION_CONFIG[field]
		if (configured !== undefined)
			return { value: configured, provenance: STATION_ORIGIN[field] ?? "yaml" }
		const value = ui[field]
		if (value !== undefined) {
			if (
				(field === "lat" || field === "lon") &&
				(ui.lat === undefined || ui.lon === undefined)
			)
				return { value: null, provenance: "default" as const }
			return { value, provenance: "ui" as const }
		}
		return { value: null, provenance: "default" as const }
	}
	const str = (field: StationField) => {
		const v = stationValueOf(field)
		return {
			value: typeof v.value === "string" ? v.value : null,
			provenance: v.provenance,
		}
	}
	const num = (field: StationField) => {
		const v = stationValueOf(field)
		return {
			value: typeof v.value === "number" ? v.value : null,
			provenance: v.provenance,
		}
	}
	const station = (): StationIdentity => {
		const country = str("country")
		return {
			name: str("name"),
			lat: num("lat"),
			lon: num("lon"),
			altM: num("altM"),
			callsign: str("callsign"),
			country,
			effectiveCountry: country.value,
			region: "EU",
			revision: stationRevision,
			// A protected core reports true; a legacy one mounts no PATCH (see README).
			writable: true,
		}
	}
	const pinned = new Set<StationField>(
		STATION_FIELDS.filter(f => STATION_CONFIG[f] !== undefined),
	)
	if (pinned.has("lat") || pinned.has("lon")) {
		pinned.add("lat")
		pinned.add("lon")
	}

	const stationError = (reply: FastifyReply, failure: StationFailure) => {
		const status = STATION_STATUS[failure.code]
		const body: StationErrorBody = {
			error: STATUS_TEXT[status] ?? "Error",
			code: failure.code,
			message: failure.message,
			...(failure.fields ? { fields: failure.fields } : {}),
		}
		return sendJson(reply, status, body)
	}

	app.get("/api/station", async (_request, reply) =>
		sendJson(reply, 200, station()),
	)
	app.patch("/api/station", async (request, reply) => {
		try {
			let ifMatch: number | undefined
			const header = request.headers["if-match"]
			if (header !== undefined) {
				const m =
					typeof header === "string"
						? IF_MATCH_STATION.exec(header.trim())
						: null
				const digits = m?.[1] ?? m?.[2]
				if (digits === undefined)
					throw new StationFailure(
						"STATION_UPDATE_INVALID",
						"If-Match must be a revision",
					)
				ifMatch = Number(digits)
			}
			const body: unknown = request.body
			if (!isRecord(body))
				throw new StationFailure(
					"STATION_UPDATE_INVALID",
					"Body must be a JSON object",
				)
			const keys = Object.keys(body).filter(k => body[k] !== undefined)
			const unknown = keys.filter(
				k => !(STATION_FIELDS as readonly string[]).includes(k),
			)
			if (unknown.length > 0)
				throw new StationFailure(
					"STATION_UPDATE_INVALID",
					`Unknown station field(s): ${unknown.join(", ")}`,
				)
			if (keys.length === 0)
				throw new StationFailure(
					"STATION_UPDATE_INVALID",
					"The station update names no field",
				)
			const valid: Partial<Record<StationField, string | number | null>> = {}
			const bad: StationField[] = []
			for (const field of STATION_FIELDS) {
				if (!keys.includes(field)) continue
				const raw = body[field]
				if (raw === null) {
					valid[field] = null
					continue
				}
				const value = stationValue(field, raw)
				if (value === null) bad.push(field)
				else valid[field] = value
			}
			if (bad.length > 0)
				throw new StationFailure(
					"STATION_UPDATE_INVALID",
					`Invalid station field(s): ${bad.join(", ")}`,
					bad,
				)
			const pinnedHit = STATION_FIELDS.filter(
				f => keys.includes(f) && pinned.has(f),
			)
			if (pinnedHit.length > 0)
				throw new StationFailure(
					"STATION_FIELD_PINNED",
					`Pinned by YAML or environment: ${pinnedHit.join(", ")}`,
					pinnedHit,
				)
			const hasLat = "lat" in valid
			const hasLon = "lon" in valid
			if (
				hasLat !== hasLon ||
				(hasLat && (valid.lat === null) !== (valid.lon === null))
			)
				throw new StationFailure(
					"STATION_UPDATE_INVALID",
					"lat and lon must be set or cleared together",
					["lat", "lon"],
				)
			if (ifMatch !== undefined && ifMatch !== stationRevision)
				throw new StationFailure(
					"STATION_REVISION_MISMATCH",
					`Revision is ${String(stationRevision)}, not ${String(ifMatch)}`,
				)
			const before = station()
			for (const field of STATION_FIELDS) {
				if (!(field in valid)) continue
				const value = valid[field]
				if (value === null || value === undefined) delete ui[field]
				else ui[field] = value
			}
			stationRevision += 1
			const after = station()
			const changed = STATION_FIELDS.filter(
				f => before[f].value !== after[f].value,
			)
			const loc = (s: StationIdentity) =>
				s.lat.value !== null && s.lon.value !== null
					? { lat: s.lat.value, lon: s.lon.value }
					: null
			const a = loc(before)
			const b = loc(after)
			const moved =
				a === null || b === null ? a !== b : a.lat !== b.lat || a.lon !== b.lon
			const result: StationUpdateResult = {
				station: after,
				revision: stationRevision,
				changed,
				appliesOnRestart: moved ? ["readsb"] : [],
				restartRequired: changed.includes("country") ? ["country"] : [],
				coverageCleared:
					moved && a !== null && (b === null || distanceKm(a, b) > 1),
			}
			return sendJson(reply, 200, result)
		} catch (error) {
			if (error instanceof StationFailure) return stationError(reply, error)
			throw error
		}
	})

	// --- decoder types, settings, lifecycle and log
	let settingsRevision = 1
	const overrides = new Map<string, Override>([
		["ais-catcher", { options: { gain: 38.6, ppm: 1 } }],
	])
	const pending = new Set<string>()

	const types = (): DecoderTypeInfo[] => {
		const seen = new Map<string, DecoderTypeInfo>()
		for (const d of ctx.decoders())
			if (!seen.has(d.type) && d.caps)
				seen.set(d.type, {
					type: d.type,
					caps: d.caps,
					options: descriptorsOf(d.type).map(o => ({
						...o,
						...(o.enumValues ? { enumValues: [...o.enumValues] } : {}),
					})),
				})
		return [...seen.values()].sort((x, y) => (x.type < y.type ? -1 : 1))
	}

	const view = (id: string): DecoderSettingsView | undefined => {
		const d = ctx.decoders().find(x => x.id === id)
		if (!d) return undefined
		const config = DECODER_CONFIG[id] ?? {}
		const over = overrides.get(id)
		const options: DecoderOptionSetting[] = descriptorsOf(d.type).map(o => {
			const inOverride =
				over !== undefined && Object.hasOwn(over.options, o.key)
			const source: DecoderSettingSource = inOverride
				? "override"
				: Object.hasOwn(config, o.key)
					? "config"
					: "default"
			const present = source !== "default"
			const patchable = o.patchable === true
			const setting: DecoderOptionSetting = {
				key: o.key,
				source,
				patchable,
				secret: o.secret,
				present,
			}
			if (patchable && !o.secret) {
				const raw = inOverride ? over.options[o.key] : config[o.key]
				setting.value = isSettingValue(raw) ? structuredClone(raw) : null
			}
			return setting
		})
		const documented = new Set(descriptorsOf(d.type).map(o => o.key))
		return {
			mode: {
				value: over?.mode ?? (over?.enabled === false ? "off" : "auto"),
				source:
					over?.mode !== undefined || over?.enabled === false
						? "override"
						: "default",
			},
			decoderId: id,
			type: d.type,
			revision: settingsRevision,
			enabled: {
				value: over?.enabled ?? true,
				source: over?.enabled !== undefined ? "override" : "config",
			},
			options,
			undocumentedKeys: Object.keys(config).filter(k => !documented.has(k))
				.length,
			pendingRestart: pending.has(id),
		}
	}

	const settingsError = (
		reply: FastifyReply,
		status: number,
		body: DecoderSettingsErrorBody,
	) => sendJson(reply, status, body)
	const invalid = (
		reply: FastifyReply,
		message: string,
		issues?: DecoderOptionIssue[],
	) =>
		settingsError(reply, 400, {
			error: "Bad Request",
			code: "DECODER_OPTIONS_INVALID",
			message,
			...(issues ? { issues } : {}),
		})

	app.get("/api/decoders/types", async () => types())

	app.get<{ Params: { id: string } }>(
		"/api/decoders/:id/settings",
		async (request, reply) => {
			const v = view(request.params.id)
			return v
				? sendJson(reply, 200, v)
				: sendJson(reply, 404, decoderNotFound(request.params.id))
		},
	)

	app.patch<{ Params: { id: string } }>(
		"/api/decoders/:id",
		async (request, reply) => {
			const { id } = request.params
			const d = ctx.decoders().find(x => x.id === id)
			if (!d) return sendJson(reply, 404, decoderNotFound(id))
			let ifMatch: number | undefined
			const header = request.headers["if-match"]
			if (header !== undefined) {
				const m =
					typeof header === "string"
						? IF_MATCH_DECODER.exec(header.trim())
						: null
				const digits = m?.[1] ?? m?.[2]
				if (digits === undefined)
					return invalid(reply, "If-Match must be a revision")
				ifMatch = Number(digits)
			}
			const body: unknown = request.body
			if (
				!isRecord(body) ||
				Object.keys(body).some(
					k => k !== "mode" && k !== "enabled" && k !== "options",
				) ||
				(Object.hasOwn(body, "mode") &&
					body["mode"] !== null &&
					body["mode"] !== "auto" &&
					body["mode"] !== "always" &&
					body["mode"] !== "off") ||
				(Object.hasOwn(body, "enabled") &&
					body["enabled"] !== null &&
					typeof body["enabled"] !== "boolean") ||
				(Object.hasOwn(body, "options") && !isRecord(body["options"]))
			)
				return invalid(
					reply,
					"Body must be a JSON object with only mode (auto, always, off or null), enabled (boolean or null) and options (object)",
				)
			if (ifMatch !== undefined && ifMatch !== settingsRevision)
				return settingsError(reply, 412, {
					error: "Precondition Failed",
					code: "DECODER_SETTINGS_REVISION_MISMATCH",
					message: "Decoder settings revision does not match",
				})
			const options = (body["options"] ?? {}) as Record<string, unknown>
			if (Object.keys(body).length === 0)
				return invalid(reply, "Decoder options are invalid", [
					{
						path: "",
						code: "invalid-value",
						message: "body must set mode, enabled or options",
					},
				])
			const descriptors = new Map(descriptorsOf(d.type).map(o => [o.key, o]))
			const refused: string[] = []
			let unknownKeys = 0
			for (const key of Object.keys(options)) {
				const o = descriptors.get(key)
				if (o?.patchable === true && !o.secret) continue
				if (o) refused.push(key)
				else unknownKeys += 1
			}
			if (refused.length > 0 || unknownKeys > 0)
				return settingsError(reply, 400, {
					error: "Bad Request",
					code: "DECODER_OPTION_NOT_PATCHABLE",
					message: "Option not patchable",
					keys: refused,
					unknownKeys,
				})
			const issues: DecoderOptionIssue[] = []
			for (const [key, value] of Object.entries(options)) {
				const o = descriptors.get(key)
				if (value === null || !o) continue
				const issue = checkValue(o, value)
				if (issue) issues.push(issue)
			}
			if (issues.length > 0)
				return invalid(reply, "Decoder options are invalid", issues)

			const before = view(id)
			const previous = overrides.get(id) ?? { options: {} }
			const next: Override = { options: { ...previous.options } }
			let enabled = previous.enabled
			if (Object.hasOwn(body, "enabled"))
				enabled =
					body["enabled"] === null ? undefined : (body["enabled"] as boolean)
			if (enabled !== undefined) next.enabled = enabled
			let mode = previous.mode
			if (Object.hasOwn(body, "mode"))
				mode = body["mode"] === null ? undefined : (body["mode"] as DecoderMode)
			if (mode !== undefined) next.mode = mode
			for (const [key, value] of Object.entries(options)) {
				if (value === null) delete next.options[key]
				else next.options[key] = structuredClone(value) as DecoderSettingValue
			}
			if (
				Object.keys(next.options).length === 0 &&
				next.enabled === undefined &&
				next.mode === undefined
			)
				overrides.delete(id)
			else overrides.set(id, next)
			settingsRevision += 1
			const after = view(id)
			const changed: string[] = []
			if (before?.mode?.value !== after?.mode?.value) changed.push("mode")
			// A mode applies now (an off stops, leaving off starts); enabled stays boot-only.
			if (Object.hasOwn(body, "mode")) {
				ctx.lifecycle.setMode(id, next.mode)
				announce(id)
			}
			if (before?.enabled.value !== after?.enabled.value)
				changed.push("enabled")
			for (const o of descriptorsOf(d.type)) {
				if (!Object.hasOwn(options, o.key)) continue
				const was = before?.options.find(x => x.key === o.key)?.value
				const now2 = after?.options.find(x => x.key === o.key)?.value
				if (!sameValue(was, now2)) changed.push(o.key)
			}
			if (changed.some(k => k !== "enabled" && k !== "mode")) pending.add(id)
			const settings = view(id)
			if (!settings) return sendJson(reply, 404, decoderNotFound(id))
			const result: DecoderSettingsUpdateResult = {
				settings,
				revision: settingsRevision,
				changed,
				pendingRestart: settings.pendingRestart,
			}
			return sendJson(reply, 200, result)
		},
	)

	const conflict = (code: string, message: string) => ({
		error: "Conflict",
		code,
		message,
	})
	const status = (id: string) => ctx.decoders().find(x => x.id === id)
	const announce = (id: string) => {
		const d = status(id)
		if (d) ctx.broadcast("decoders", "decoder:status", d)
		return d
	}

	app.post<{ Params: { id: string } }>(
		"/api/decoders/:id/start",
		async (request, reply) => {
			const { id } = request.params
			const d = status(id)
			if (!d) return reply.code(404).send(decoderNotFound(id))
			if (d.running && (request.body === undefined || request.body === null))
				return reply
					.code(409)
					.send(
						conflict(
							"DECODER_ALREADY_RUNNING",
							`Decoder '${id}' is already running`,
						),
					)
			ctx.lifecycle.setIntent(id, "operator")
			pending.delete(id)
			return {
				message: `Decoder '${id}' started successfully`,
				decoder: announce(id),
			}
		},
	)
	app.post<{ Params: { id: string } }>(
		"/api/decoders/:id/stop",
		async (request, reply) => {
			const { id } = request.params
			const d = status(id)
			if (!d) return reply.code(404).send(decoderNotFound(id))
			if (!d.running && d.desiredRunning !== true)
				return reply
					.code(409)
					.send(
						conflict("DECODER_NOT_RUNNING", `Decoder '${id}' is not running`),
					)
			ctx.lifecycle.setIntent(id, "stopped")
			return {
				message: `Decoder '${id}' stopped successfully`,
				decoder: announce(id),
			}
		},
	)
	app.post<{ Params: { id: string } }>(
		"/api/decoders/:id/restart",
		async (request, reply) => {
			const { id } = request.params
			if (!status(id)) return reply.code(404).send(decoderNotFound(id))
			ctx.lifecycle.restarted(id)
			pending.delete(id)
			return {
				message: `Decoder '${id}' restarted successfully`,
				decoder: announce(id),
			}
		},
	)

	app.get<{ Params: { id: string }; Querystring: { lines?: number } }>(
		"/api/decoders/:id/log",
		{
			schema: {
				querystring: {
					type: "object",
					properties: {
						lines: { type: "integer", minimum: 1, maximum: 500, default: 200 },
					},
					additionalProperties: false,
				},
			},
		},
		async (request, reply) => {
			const d = status(request.params.id)
			if (!d) return reply.code(404).send(decoderNotFound(request.params.id))
			return {
				decoderId: d.id,
				lines: logLines(d, request.query.lines ?? 200, now()),
			}
		},
	)

	// --- storage report and configuration export
	let report: StorageReport | null = null
	app.get("/api/storage", async (_request, reply) => {
		const t = now()
		if (!report || Date.parse(report.cachedUntil) <= t)
			report = storageReport(t, startedAt)
		return sendJson(reply, 200, report)
	})
	app.get(CONFIG_EXPORT_ROUTE, async (_request, reply) =>
		reply
			.code(200)
			.header("Cache-Control", "no-store")
			.header(
				"Content-Disposition",
				`attachment; filename="${CONFIG_EXPORT_FILE_NAME}"`,
			)
			.type(CONFIG_EXPORT_CONTENT_TYPE)
			.send(
				exportYaml(ctx.decoders(), station(), new Date(now()).toISOString()),
			),
	)

	return {
		station,
		decoderView: view,
		budgetRaised: () => cpuBudgetCores !== "auto",
	}
}
