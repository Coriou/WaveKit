/**
 * The per-band gain table (GET/PUT /api/tuner-band-gain, src/api/routes/tuner.ts): a gain per
 * frequency range that scanner hops, dwells and jobs apply, and the operator's own retunes too when
 * `applyToMyTuning` is on. Validated with Zod at the boundary. One store per API client, shared by
 * Settings › Receiver › Per-band gain and the Receiver island's indicator.
 *
 * The editor works on a text draft (MHz and dB as typed); bandGainFromDraft turns it into the wire
 * settings (whole Hz, tenths of a dB) with the core's rules checked first, so most mistakes show
 * on their field instead of as the core's 400.
 */
import { z } from "zod/v4"
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
	BandGainSettingsView,
} from "@wavekit/api-types"
import type { ApiClient } from "./api-client.ts"
import { ApiError, errorMessage, validated } from "./api-client.ts"
import { failedWrite, WRITE_OK } from "./setting-write.ts"
import type { SettingWriteResult } from "./setting-write.ts"
import { Store } from "./store.ts"

export const BAND_GAIN_ROUTE = "/api/tuner-band-gain"

const int = z.number().int()
const entrySchema = z.object({
	minHz: int,
	maxHz: int,
	gain: z.union([z.literal("keep"), int]),
	label: z.string().optional(),
})
const viewSchema = z.object({
	settings: z.object({
		applyToMyTuning: z.boolean(),
		entries: z.array(entrySchema),
	}),
	provenance: z.enum(["config", "runtime"]),
	limits: z.object({
		maxEntries: int,
		minHz: int,
		maxHz: int,
		minGainTenthsDb: int,
		maxGainTenthsDb: int,
		labelMaxLength: int,
	}),
})

/** The limits a core without them would answer (packages/api-types). */
export const BAND_GAIN_LIMITS: BandGainSettingsView["limits"] = {
	maxEntries: BAND_GAIN_MAX_ENTRIES,
	minHz: BAND_GAIN_MIN_HZ,
	maxHz: BAND_GAIN_MAX_HZ,
	minGainTenthsDb: BAND_GAIN_MIN_TENTHS_DB,
	maxGainTenthsDb: BAND_GAIN_MAX_TENTHS_DB,
	labelMaxLength: BAND_GAIN_LABEL_MAX_LENGTH,
}

function toView(raw: z.infer<typeof viewSchema>): BandGainSettingsView {
	return {
		...raw,
		settings: {
			applyToMyTuning: raw.settings.applyToMyTuning,
			entries: raw.settings.entries.map(
				({ label, ...rest }): BandGainEntry =>
					label === undefined ? rest : { ...rest, label },
			),
		},
	}
}

export interface BandGainState {
	view: BandGainSettingsView | null
	/** The core has no band gain routes (404): an older core. */
	unavailable: boolean
	loaded: boolean
	error: string | null
	saving: boolean
}

export const EMPTY_BAND_GAIN: BandGainState = {
	view: null,
	unavailable: false,
	loaded: false,
	error: null,
	saving: false,
}

export class BandGainStore extends Store<BandGainState> {
	private inflight: { promise: Promise<void>; revision: number } | null = null
	/**
	 * Bumped when a PUT starts and again when it succeeds: a GET answers only if no write started
	 * or finished since the GET was sent, so a read that raced a write never overwrites the table
	 * the PUT answered.
	 */
	private revision = 0

	constructor(private readonly api: ApiClient) {
		super(EMPTY_BAND_GAIN)
	}

	/** GET; concurrent calls share one request (a write since starts a new one). Never rejects. */
	load(): Promise<void> {
		if (this.inflight?.revision === this.revision) return this.inflight.promise
		const entry = {
			revision: this.revision,
			promise: this.fetch().finally(() => {
				if (this.inflight === entry) this.inflight = null
			}),
		}
		this.inflight = entry
		return entry.promise
	}

	private async fetch(): Promise<void> {
		const revision = this.revision
		try {
			const view = toView(
				validated(
					viewSchema,
					await this.api.get<unknown>(BAND_GAIN_ROUTE),
					"GET",
					BAND_GAIN_ROUTE,
				),
			)
			if (revision === this.revision)
				this.update(s => ({
					...s,
					view,
					unavailable: false,
					loaded: true,
					error: null,
				}))
		} catch (error) {
			if (revision !== this.revision) return
			if (error instanceof ApiError && error.status === 404)
				this.update(s => ({
					...s,
					view: null,
					unavailable: true,
					loaded: true,
					error: null,
				}))
			else
				this.update(s => ({ ...s, loaded: true, error: errorMessage(error) }))
		}
	}

	/** PUT the whole table; the core's message on a refusal. Never rejects. */
	async save(settings: BandGainSettings): Promise<SettingWriteResult> {
		if (this.get().saving)
			return { ok: false, message: "The band gains are being saved" }
		this.revision++
		this.update(s => ({ ...s, saving: true }))
		try {
			const view = toView(
				validated(
					viewSchema,
					await this.api.put<unknown>(BAND_GAIN_ROUTE, settings),
					"PUT",
					BAND_GAIN_ROUTE,
				),
			)
			this.revision++
			this.update(s => ({
				...s,
				view,
				unavailable: false,
				loaded: true,
				error: null,
			}))
			return WRITE_OK
		} catch (error) {
			return failedWrite(error)
		} finally {
			this.update(s => ({ ...s, saving: false }))
		}
	}
}

const stores = new WeakMap<ApiClient, BandGainStore>()

/** The one band gain store of an API client (Settings and the Receiver island share it). */
export function bandGainStore(api: ApiClient): BandGainStore {
	let store = stores.get(api)
	if (!store) {
		store = new BandGainStore(api)
		stores.set(api, store)
	}
	return store
}

// ---- the editor's draft

/** One row as typed: MHz and dB as text, `keep` instead of a gain. */
export interface BandGainDraftRow {
	readonly key: string
	readonly minMHz: string
	readonly maxMHz: string
	readonly keep: boolean
	readonly gainDb: string
	readonly label: string
}

export interface BandGainDraft {
	readonly applyToMyTuning: boolean
	readonly rows: readonly BandGainDraftRow[]
}

export type BandGainField = "minMHz" | "maxMHz" | "gainDb" | "label"

export interface BandGainDraftErrors {
	/** By row key, then field. */
	readonly rows: Readonly<
		Record<string, Partial<Readonly<Record<BandGainField, string>>>>
	>
	readonly table: string | null
}

const mhzText = (hz: number): string => String(hz / 1e6)
const dbText = (tenths: number): string => (tenths / 10).toFixed(1)

let draftKey = 0
export const newDraftKey = (): string => `bg${++draftKey}`

export function draftOf(settings: BandGainSettings): BandGainDraft {
	return {
		applyToMyTuning: settings.applyToMyTuning,
		rows: settings.entries.map(e => ({
			key: newDraftKey(),
			minMHz: mhzText(e.minHz),
			maxMHz: mhzText(e.maxHz),
			keep: e.gain === "keep",
			gainDb: e.gain === "keep" ? "" : dbText(e.gain),
			label: e.label ?? "",
		})),
	}
}

/** "868.5", "868,5" or "868.5 MHz" to whole Hz; null when it is not a number. */
function parseMHz(text: string): number | null {
	const t = text
		.trim()
		.replace(/\s*mhz$/i, "")
		.replace(",", ".")
	if (!/^\d+(?:\.\d*)?$|^\.\d+$/.test(t)) return null
	return Math.round(Number(t) * 1e6)
}

/** "37.2" or "37.2 dB" to tenths of a dB; null when it is not a number. */
function parseDb(text: string): number | null {
	const t = text
		.trim()
		.replace(/\s*db$/i, "")
		.replace(",", ".")
	if (!/^\d+(?:\.\d*)?$|^\.\d+$/.test(t)) return null
	return Math.round(Number(t) * 10)
}

const rangeText = (row: BandGainDraftRow): string =>
	row.label.trim() || `${row.minMHz.trim()}–${row.maxMHz.trim()} MHz`

/**
 * The draft as the PUT body, or the errors by field: the core's rules (whole Hz in its range,
 * start below end, inclusive ranges that never overlap, a gain in its range or keep, a short
 * printable label, at most `maxEntries` rows).
 */
export function bandGainFromDraft(
	draft: BandGainDraft,
	limits: BandGainSettingsView["limits"] = BAND_GAIN_LIMITS,
): { settings: BandGainSettings } | { errors: BandGainDraftErrors } {
	const errors: Record<string, Partial<Record<BandGainField, string>>> = {}
	const fail = (key: string, field: BandGainField, message: string) => {
		const mine = (errors[key] ??= {})
		mine[field] ??= message
	}
	const minMHz = limits.minHz / 1e6
	const maxMHz = limits.maxHz / 1e6
	const entries: { key: string; entry: BandGainEntry }[] = []
	for (const row of draft.rows) {
		const min = parseMHz(row.minMHz)
		const max = parseMHz(row.maxMHz)
		for (const [field, hz] of [
			["minMHz", min],
			["maxMHz", max],
		] as const) {
			if (hz === null) fail(row.key, field, "Type MHz, for example 868")
			else if (hz < limits.minHz || hz > limits.maxHz)
				fail(row.key, field, `From ${minMHz} to ${maxMHz} MHz`)
		}
		if (min !== null && max !== null && min >= max)
			fail(row.key, "maxMHz", "The end must be above the start")
		let gain: BandGainEntry["gain"] = "keep"
		if (!row.keep) {
			const tenths = parseDb(row.gainDb)
			if (
				tenths === null ||
				tenths < limits.minGainTenthsDb ||
				tenths > limits.maxGainTenthsDb
			)
				fail(
					row.key,
					"gainDb",
					`A gain from ${limits.minGainTenthsDb / 10} to ${limits.maxGainTenthsDb / 10} dB, or Keep`,
				)
			else gain = tenths
		}
		const label = row.label.trim()
		if (label.length > limits.labelMaxLength)
			fail(row.key, "label", `At most ${limits.labelMaxLength} characters`)
		else if (label && !/^[\x20-\x7e]+$/.test(label))
			fail(row.key, "label", "Letters, digits and plain punctuation only")
		if (min !== null && max !== null)
			entries.push({
				key: row.key,
				entry: {
					minHz: min,
					maxHz: max,
					gain,
					...(label ? { label } : {}),
				},
			})
	}
	// ranges are inclusive: touching ends overlap
	for (let i = 0; i < entries.length; i++)
		for (let j = 0; j < i; j++) {
			const a = entries[i]
			const b = entries[j]
			if (!a || !b) continue
			if (a.entry.minHz <= b.entry.maxHz && b.entry.minHz <= a.entry.maxHz) {
				const other = draft.rows.find(r => r.key === b.key)
				fail(
					a.key,
					"minMHz",
					`Overlaps ${other ? rangeText(other) : "another band"}`,
				)
				break
			}
		}
	const table =
		draft.rows.length > limits.maxEntries
			? `At most ${limits.maxEntries} bands`
			: null
	if (Object.keys(errors).length > 0 || table !== null)
		return { errors: { rows: errors, table } }
	return {
		settings: {
			applyToMyTuning: draft.applyToMyTuning,
			entries: entries.map(e => e.entry),
		},
	}
}

/** The same table and switch (the draft against what the core holds). */
export function sameBandGain(
	a: BandGainSettings,
	b: BandGainSettings,
): boolean {
	return JSON.stringify(a) === JSON.stringify(b)
}
