// The Scanner drawer's own view state (search chips, sort, tab, filters) and Watch here, which reads and
// writes the core's per-source passive setting (GET/PATCH /api/scanner/settings `passive.<sourceId>`).
// The drawer state is kept for the session (closing the drawer keeps the search), never persisted.
import type { ScannerSettingsView } from "@wavekit/api-types"

import type {
	ApiClient,
	DiscoverySort,
	ScannerStore,
} from "../../../data/index.ts"
import { errorMessage, isApiError, Store } from "../../../data/index.ts"
import type { ScanToken } from "./search.ts"
import { addToken } from "./search.ts"

export type DrawerTab = "scan" | "all"

export interface DrawerViewState {
	tokens: readonly ScanToken[]
	sort: DiscoverySort
	/** While a sweep runs: its hit log ("This scan") or every discovery. */
	tab: DrawerTab
	newOnly: boolean
	showIgnored: boolean
	/** WG12: list discoveries with no proof too (`evidence=all`); proven ones only by default. */
	showWeak: boolean
}

export const drawerView = new Store<DrawerViewState>({
	tokens: [],
	sort: "lastSeen",
	tab: "scan",
	newOnly: false,
	showIgnored: false,
	showWeak: false,
})

export function addSearchToken(t: ScanToken): void {
	drawerView.update(s => ({ ...s, tokens: addToken(s.tokens, t) }))
}

export function removeSearchToken(index: number): void {
	drawerView.update(s => ({
		...s,
		tokens: s.tokens.filter((_, i) => i !== index),
	}))
}

export function clearSearch(): void {
	drawerView.update(s => (s.tokens.length === 0 ? s : { ...s, tokens: [] }))
}

export function setSort(sort: DiscoverySort): void {
	drawerView.update(s => (s.sort === sort ? s : { ...s, sort }))
}

export function setTab(tab: DrawerTab): void {
	drawerView.update(s => (s.tab === tab ? s : { ...s, tab }))
}

export function toggleNewOnly(): void {
	drawerView.update(s => ({ ...s, newOnly: !s.newOnly }))
}

export function toggleWeak(): void {
	drawerView.update(s => ({ ...s, showWeak: !s.showWeak }))
}

export function toggleIgnored(): void {
	drawerView.update(s => ({ ...s, showIgnored: !s.showIgnored }))
}

// ---- Watch here

export interface WatchState {
	settings: ScannerSettingsView | null
	/** GET /api/scanner/settings failed (older core, no access): Watch here is shown read-only. */
	settingsError: string | null
	/** A toggle is in flight (the switch shows the wanted state). */
	pending: boolean | null
	error: string | null
}

/** Whether Watch here can be switched and what it is, for one source. */
export interface WatchView {
	on: boolean
	/** The switch can change it. */
	canToggle: boolean
	/** Why it cannot (tooltip), or null. */
	why: string | null
}

/**
 * Watch here for `sourceId`: the settings' effective passiveBySource when loaded (the switch writes
 * it), else what the engine reports. The per-source switch only works while the global passive
 * setting is on (core: passiveBySource = passive.enabled && override).
 */
export function watchView(
	sourceId: string | null,
	watch: WatchState,
	engine:
		| { passive: { enabled: boolean; disabledReason?: string } }
		| undefined,
	readOnly: boolean,
): WatchView {
	const settings = watch.settings
	const effective =
		sourceId !== null && settings
			? settings.passiveBySource[sourceId] === true
			: engine?.passive.enabled === true
	const on = watch.pending ?? effective
	if (sourceId === null)
		return { on: false, canToggle: false, why: "No tuner source" }
	if (readOnly) return { on, canToggle: false, why: "View only" }
	if (!settings)
		return {
			on,
			canToggle: false,
			why: watch.settingsError
				? `Scanner settings unavailable: ${watch.settingsError}`
				: "Loading",
		}
	if (!settings.effective.passive.enabled)
		return {
			on: false,
			canToggle: false,
			why: "Watching is turned off in the scanner config (scanner.passive.enabled)",
		}
	return { on, canToggle: watch.pending === null, why: null }
}

export class WatchController extends Store<WatchState> {
	private readonly api: ApiClient
	private readonly scanner: ScannerStore
	private loading: Promise<void> | null = null

	constructor(api: ApiClient, scanner: ScannerStore) {
		super({ settings: null, settingsError: null, pending: null, error: null })
		this.api = api
		this.scanner = scanner
	}

	/** GET /api/scanner/settings. Never rejects. */
	load(): Promise<void> {
		this.loading ??= this.api
			.get<ScannerSettingsView>("/api/scanner/settings")
			.then(
				settings => this.update(s => ({ ...s, settings, settingsError: null })),
				(error: unknown) =>
					this.update(s => ({
						...s,
						settingsError:
							isApiError(error) && error.status === 404
								? "not on this core"
								: errorMessage(error),
					})),
			)
			.finally(() => {
				this.loading = null
			})
		return this.loading
	}

	/** PATCH `passive.<sourceId>`; refreshes the scanner status and jobs after. Never rejects. */
	async setWatching(sourceId: string, on: boolean): Promise<void> {
		this.update(s => ({ ...s, pending: on, error: null }))
		try {
			const settings = await this.api.patch<ScannerSettingsView>(
				"/api/scanner/settings",
				{ passive: { [sourceId]: on } },
			)
			this.update(s => ({ ...s, settings, pending: null }))
			void this.scanner.loadStatus()
			void this.scanner.loadJobs()
		} catch (error) {
			this.update(s => ({ ...s, pending: null, error: errorMessage(error) }))
		}
	}
}

const controllers = new WeakMap<ScannerStore, WatchController>()

/** One Watch here controller per scanner store (the drawer remounts; the state stays). */
export function watchController(
	api: ApiClient,
	scanner: ScannerStore,
): WatchController {
	let c = controllers.get(scanner)
	if (!c) {
		c = new WatchController(api, scanner)
		controllers.set(scanner, c)
	}
	return c
}
