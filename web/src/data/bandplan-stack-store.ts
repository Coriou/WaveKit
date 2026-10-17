/**
 * The band plan stack for Settings › Band plans (GET /api/bandplans), the packs it shows bands of
 * (GET /api/bandplans/packs/:id) and every write the page makes. Writes carry the store's expected
 * token; a 409 conflict reloads the stack and fails with a sentence the page can show.
 */
import type {
	BandInput,
	BandPlanImportFormat,
	BandPlanPack,
	BandPlanPackView,
	BandPlanStackView,
	BandPlanUpdateCheck,
	BandPlanWriteDto,
	BandEditField,
	BandEditFields,
	ImportGroupOverride,
	ImportPreview,
	ImportUrlPreview,
	PlanStackEntry,
} from "@wavekit/api-types"
import type { ApiClient } from "./api-client.ts"
import { ApiError, errorMessage } from "./api-client.ts"
import type { EventsClient } from "./events-client.ts"
import { Store } from "./store.ts"

export interface BandplanStackState {
	view: BandPlanStackView | null
	/** Pack bands as shipped or imported, without edits, by pack id. */
	packs: Readonly<Record<string, BandPlanPack>>
	loaded: boolean
	error: string | null
	busy: boolean
}

export interface ImportFile {
	readonly format: BandPlanImportFormat
	readonly fileName: string
	readonly contentBase64: string
	readonly groupOverrides: readonly ImportGroupOverride[]
}

export interface ImportCommit {
	readonly preview: ImportPreview | ImportUrlPreview
	readonly file: ImportFile
	readonly name: string | null
	readonly keepColourHints: boolean
	readonly replacesPackId: string | null
}

/** A write's failure in words: conflicts, read-only access and core's own error message. */
export function bandplanWriteError(error: unknown): string {
	if (error instanceof ApiError) {
		if (error.code === "BANDPLANS_CONFLICT")
			return "Band plans changed somewhere else. Look again and retry."
		if (error.status === 401 || error.status === 403)
			return error.code === "BANDPLANS_URL_IMPORT_DISABLED"
				? "This WaveKit does not fetch plans by URL. Choose a file instead."
				: "Read-only access: sign in on this WaveKit to change band plans"
		if (error.status === 404 && error.code === null)
			return "This WaveKit keeps band plans read-only (open access mode)"
	}
	return errorMessage(error)
}

export class BandplanStackStore extends Store<BandplanStackState> {
	private readonly api: ApiClient
	private readonly cleanup: (() => void)[]
	private inflight: Promise<void> | null = null
	private readonly packLoads = new Map<string, Promise<void>>()
	/** Called after each write so the resolved plan and scan presets follow. */
	private readonly onWrite: () => void

	constructor(api: ApiClient, events: EventsClient, onWrite: () => void) {
		super({ view: null, packs: {}, loaded: false, error: null, busy: false })
		this.api = api
		this.onWrite = onWrite
		this.cleanup = [
			events.on("bandplans:changed", ({ storeId, revision }) => {
				const view = this.get().view
				if (!view) return
				const s = view.store
				if (
					s.state === "available" &&
					s.storeId === storeId &&
					s.revision >= revision
				)
					return
				void this.load()
			}),
		]
	}

	/** Never rejects: a failure lands in `error`. Concurrent calls share one request. */
	load(): Promise<void> {
		this.inflight ??= this.fetch().finally(() => {
			this.inflight = null
		})
		return this.inflight
	}

	private async fetch(): Promise<void> {
		try {
			const view = await this.api.get<BandPlanStackView>("/api/bandplans")
			this.setView(view)
		} catch (error) {
			this.update(s => ({ ...s, loaded: true, error: errorMessage(error) }))
		}
	}

	/** Takes a new stack view; packs whose band count or provenance changed are fetched again. */
	private setView(view: BandPlanStackView): void {
		const packs: Record<string, BandPlanPack> = {}
		for (const [id, pack] of Object.entries(this.get().packs)) {
			const summary = view.packs.find(p => p.id === id)
			if (
				summary &&
				summary.bandCount === pack.bands.length &&
				JSON.stringify(summary.provenance) === JSON.stringify(pack.provenance)
			)
				packs[id] = pack
		}
		this.update(s => ({ ...s, view, packs, loaded: true, error: null }))
		for (const entry of view.stack.entries) void this.loadPack(entry.packId)
	}

	loadPack(id: string): Promise<void> {
		if (this.get().packs[id]) return Promise.resolve()
		let p = this.packLoads.get(id)
		if (!p) {
			p = this.api
				.get<BandPlanPackView>(`/api/bandplans/packs/${encodeURIComponent(id)}`)
				.then(
					v =>
						this.update(s => ({ ...s, packs: { ...s.packs, [id]: v.pack } })),
					() => undefined,
				)
				.finally(() => this.packLoads.delete(id))
			this.packLoads.set(id, p)
		}
		return p
	}

	private expected() {
		const s = this.get().view?.store
		if (s?.state !== "available" || s.storeId === null)
			throw new ApiError({
				status: 409,
				code: "BANDPLANS_UNAVAILABLE",
				message: "Band-plan storage is unavailable.",
				body: null,
				method: "GET",
				path: "/api/bandplans",
			})
		return { storeId: s.storeId, revision: s.revision }
	}

	/** One write: rejects with an ApiError (bandplanWriteError says it in words). */
	private async write(
		method: "PUT" | "PATCH" | "POST" | "DELETE",
		path: string,
		body: Record<string, unknown> = {},
	): Promise<BandPlanWriteDto> {
		this.update(s => ({ ...s, busy: true }))
		try {
			const dto = await this.api.request<BandPlanWriteDto>(method, path, {
				expected: this.expected(),
				...body,
			})
			this.setView(dto.view)
			this.onWrite()
			return dto
		} catch (error) {
			if (error instanceof ApiError && error.code === "BANDPLANS_CONFLICT")
				void this.load()
			throw error
		} finally {
			this.update(s => ({ ...s, busy: false }))
		}
	}

	setStack(entries: readonly PlanStackEntry[]): Promise<BandPlanWriteDto> {
		return this.write("PUT", "/api/bandplans/stack", {
			entries: entries.map(({ packId, enabled }) => ({ packId, enabled })),
		})
	}

	/** Field-level edits of a pack band: `set` overrides, `reset` falls back to the pack. */
	patchBand(
		packId: string,
		bandId: string,
		set: BandEditFields | null,
		reset: readonly BandEditField[] = [],
	): Promise<BandPlanWriteDto> {
		return this.write("PATCH", `${bandPath(packId, bandId)}/edit`, {
			set,
			reset,
		})
	}

	resetBand(packId: string, bandId: string): Promise<BandPlanWriteDto> {
		return this.write("DELETE", `${bandPath(packId, bandId)}/edit`)
	}

	resetPack(packId: string): Promise<BandPlanWriteDto> {
		return this.write(
			"DELETE",
			`/api/bandplans/packs/${encodeURIComponent(packId)}/edits`,
		)
	}

	deletePack(packId: string): Promise<BandPlanWriteDto> {
		return this.write(
			"DELETE",
			`/api/bandplans/packs/${encodeURIComponent(packId)}`,
		)
	}

	createBand(band: BandInput): Promise<BandPlanWriteDto> {
		return this.write("POST", "/api/bandplans/operator-bands", { band })
	}

	replaceBand(id: string, band: BandInput): Promise<BandPlanWriteDto> {
		return this.write(
			"PUT",
			`/api/bandplans/operator-bands/${encodeURIComponent(id)}`,
			{ band },
		)
	}

	deleteBand(id: string): Promise<BandPlanWriteDto> {
		return this.write(
			"DELETE",
			`/api/bandplans/operator-bands/${encodeURIComponent(id)}`,
		)
	}

	previewFile(file: ImportFile): Promise<ImportPreview> {
		return this.api.post<ImportPreview>("/api/bandplans/imports/preview", file)
	}

	previewUrl(
		url: string,
		format: BandPlanImportFormat,
		groupOverrides: readonly ImportGroupOverride[] = [],
	): Promise<ImportUrlPreview> {
		return this.api.post<ImportUrlPreview>(
			"/api/bandplans/imports/preview-url",
			{ url, format, groupOverrides },
		)
	}

	checkUpdate(packId: string): Promise<BandPlanUpdateCheck> {
		return this.api.post<BandPlanUpdateCheck>(
			`/api/bandplans/packs/${encodeURIComponent(packId)}/check-update`,
			{},
		)
	}

	commitImport(c: ImportCommit): Promise<BandPlanWriteDto> {
		const url = "sourceUrl" in c.preview ? c.preview.sourceUrl : null
		return this.write("POST", "/api/bandplans/imports", {
			...c.file,
			previewDigest: c.preview.previewDigest,
			name: c.name,
			author: null,
			licence: null,
			keepColourHints: c.keepColourHints,
			replacesPackId: c.replacesPackId,
			addToStack: true,
			...(url ? { sourceUrl: url } : {}),
		})
	}

	dispose(): void {
		for (const fn of this.cleanup.splice(0)) fn()
	}
}

const bandPath = (packId: string, bandId: string) =>
	`/api/bandplans/packs/${encodeURIComponent(packId)}/bands/${encodeURIComponent(bandId)}`
