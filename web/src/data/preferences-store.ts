/**
 * Operator preferences (core operator data, protected mode only): the effective values with their
 * provenance (core default or operator override), and `patch-preferences` writes (`set` one key,
 * or `reset` it to core's default) with the store's revision token.
 *
 * Shares the operator-data read with SavedFrequenciesStore: that store fetches GET
 * /api/operator-data and follows the `operator-data` channel; this one derives its state from
 * each answer it accepts and hands its own write answers back to it, so the token stays one.
 */
import { preferenceKeySchema, preferencesSchema } from "@wavekit/api-types"
import type {
	ExpectedToken,
	OperatorDataWriteDto,
	PreferenceKey,
	Preferences,
} from "@wavekit/api-types"
import type { ApiClient } from "./api-client.ts"
import { ApiError, errorMessage } from "./api-client.ts"
import type {
	OperatorDataDto,
	SavedFrequenciesState,
	SavedFrequenciesStore,
} from "./saved-frequencies-store.ts"
import { failedWrite, WRITE_OK, writeError } from "./setting-write.ts"
import type { SettingWriteResult } from "./setting-write.ts"
import type { Listener, ReadableStore } from "./store.ts"
import { Store } from "./store.ts"

export type PreferenceSource = "default" | "operator"

/**
 * Core's defaults (src/operator-data/domain.ts PREFERENCE_DEFAULTS). The read DTO does not carry
 * them; values core reports with provenance `default` replace these as they arrive.
 */
export const PREFERENCE_DEFAULTS: Readonly<Preferences> = Object.freeze({
	units: "nautical",
	timeFormat: "local-24h",
	waterfallPalette: "phosphor",
	showSavedFrequencyLabels: true,
})

export const PREFERENCE_KEYS: readonly PreferenceKey[] =
	preferenceKeySchema.options

export interface PreferencesState {
	/** Effective values (operator override, else default). */
	values: Readonly<Preferences>
	/** Core's default of each key. */
	defaults: Readonly<Preferences>
	provenance: Readonly<Record<PreferenceKey, PreferenceSource>>
	/** Operator data on this core: null until the first answer, false on a legacy core. */
	available: boolean | null
	loaded: boolean
	error: string | null
}

const UNAVAILABLE_TEXT = "Preferences are not available on this WaveKit."

function provenanceOf(
	overrides: Partial<Preferences>,
): Record<PreferenceKey, PreferenceSource> {
	const out = {} as Record<PreferenceKey, PreferenceSource>
	for (const key of PREFERENCE_KEYS)
		out[key] = Object.hasOwn(overrides, key) ? "operator" : "default"
	return out
}

function codeOf(error: unknown): string | null {
	return error instanceof ApiError ? error.code : null
}

export class PreferencesStore implements ReadableStore<PreferencesState> {
	private readonly api: ApiClient
	private readonly saved: SavedFrequenciesStore
	private readonly state: Store<PreferencesState>
	private readonly cleanup: (() => void)[]
	private knownDefaults: Preferences = { ...PREFERENCE_DEFAULTS }
	private queue: Promise<unknown> = Promise.resolve()

	constructor(api: ApiClient, saved: SavedFrequenciesStore) {
		this.api = api
		this.saved = saved
		this.state = new Store<PreferencesState>({
			values: PREFERENCE_DEFAULTS,
			defaults: PREFERENCE_DEFAULTS,
			provenance: provenanceOf({}),
			available: null,
			loaded: false,
			error: null,
		})
		const first = saved.operatorData()
		if (first) this.accept(first)
		this.follow(saved.get())
		this.cleanup = [
			saved.onOperatorData(dto => this.accept(dto)),
			saved.subscribe(s => this.follow(s)),
		]
	}

	get(): PreferencesState {
		return this.state.get()
	}

	subscribe = (listener: Listener<PreferencesState>): (() => void) =>
		this.state.subscribe(listener)

	get values(): Readonly<Preferences> {
		return this.get().values
	}

	get defaults(): Readonly<Preferences> {
		return this.get().defaults
	}

	get available(): boolean | null {
		return this.get().available
	}

	/** Loads operator data through the shared read. Never rejects. */
	load(): Promise<void> {
		return this.saved.load()
	}

	/** Overrides one preference. Resolves (never rejects). */
	set<K extends PreferenceKey>(
		key: K,
		value: Preferences[K],
	): Promise<SettingWriteResult> {
		const check = preferencesSchema.shape[key].safeParse(value)
		if (!check.success)
			return Promise.resolve(
				writeError("Invalid preference value", {
					[key]: check.error.issues[0]?.message ?? "Invalid value",
				}),
			)
		return this.write(key, token =>
			this.api.patchPreferences(token, { set: { [key]: value } }),
		)
	}

	/** Returns one preference to core's default. Resolves (never rejects). */
	reset(key: PreferenceKey): Promise<SettingWriteResult> {
		if (this.get().provenance[key] === "default" && this.get().loaded)
			return Promise.resolve(WRITE_OK)
		return this.write(key, token =>
			this.api.patchPreferences(token, { reset: [key] }),
		)
	}

	dispose(): void {
		for (const fn of this.cleanup.splice(0)) fn()
	}

	// ---- internals

	private accept(dto: OperatorDataDto): void {
		const overrides = dto.snapshot.preferenceOverrides
		if ("preferences" in dto) {
			const learned = { ...this.knownDefaults }
			for (const key of PREFERENCE_KEYS)
				if (dto.preferences.provenance[key] === "default")
					Object.assign(learned, { [key]: dto.preferences.values[key] })
			this.knownDefaults = learned
		}
		const defaults = { ...this.knownDefaults }
		const values: Preferences = { ...defaults, ...overrides }
		this.state.set({
			values,
			defaults,
			provenance: provenanceOf(overrides),
			available: true,
			loaded: true,
			error: null,
		})
	}

	private follow(saved: SavedFrequenciesState): void {
		const s = this.get()
		if (saved.status === "unavailable" && s.available !== false)
			this.state.set({ ...s, available: false, loaded: true, error: null })
		else if (saved.status === "error" && !s.loaded)
			this.state.set({ ...s, loaded: true, error: saved.error })
	}

	/** One write at a time; a conflict reloads the shared snapshot and retries once. */
	private write(
		key: PreferenceKey,
		send: (token: ExpectedToken) => Promise<OperatorDataWriteDto>,
	): Promise<SettingWriteResult> {
		const task = this.queue.then(async (): Promise<SettingWriteResult> => {
			if (!this.saved.get().token) await this.saved.load()
			for (let attempt = 0; ; attempt++) {
				const token = this.saved.get().token
				if (!token) return writeError(UNAVAILABLE_TEXT)
				try {
					const dto = await send(token)
					if (!this.saved.absorb(dto)) this.accept(dto)
					return WRITE_OK
				} catch (error) {
					const code = codeOf(error)
					if (code === "OPERATOR_DATA_CONFLICT" && attempt === 0) {
						await this.saved.load()
						continue
					}
					if (code === "OPERATOR_DATA_INVALID")
						return writeError(errorMessage(error), {
							[key]: "Core refused this value.",
						})
					if (
						error instanceof ApiError &&
						(error.status === 404 || code === "OPERATOR_DATA_UNAVAILABLE")
					)
						return writeError(UNAVAILABLE_TEXT)
					return failedWrite(error)
				}
			}
		})
		this.queue = task.catch(() => undefined)
		return task
	}
}
