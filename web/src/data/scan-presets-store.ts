/**
 * Scan presets (GET /api/bandplans/presets): the region's built-ins and the operator's own, shared by every client,
 * and the writes "Save as preset" makes (create, replace, delete). Writes carry the band-plan store's expected token;
 * a 409 conflict reloads the list and fails with a sentence the planner can show.
 */
import type {
	BandPlanWriteDto,
	ScanPresetInput,
	ScanPresetListView,
} from "@wavekit/api-types"
import type { ApiClient } from "./api-client.ts"
import { ApiError, errorMessage } from "./api-client.ts"
import type { EventsClient } from "./events-client.ts"
import { Store } from "./store.ts"

export interface ScanPresetsState {
	view: ScanPresetListView | null
	loaded: boolean
	error: string | null
	busy: boolean
}

/** A preset write's failure in words. */
export function presetWriteError(error: unknown): string {
	if (error instanceof ApiError) {
		if (error.code === "BANDPLANS_CONFLICT")
			return "Presets changed somewhere else. Look again and retry."
		if (error.code === "BANDPLANS_QUOTA")
			return "No room for another preset: delete one first"
		if (error.status === 401 || error.status === 403)
			return "Read-only access: sign in on this WaveKit to save presets"
		if (error.status === 404 && error.code === null)
			return "This WaveKit keeps presets read-only (open access mode)"
	}
	return errorMessage(error)
}

export class ScanPresetsStore extends Store<ScanPresetsState> {
	private readonly api: ApiClient
	private readonly cleanup: (() => void)[]
	private inflight: Promise<void> | null = null
	/** Called after each write: the band-plan store's token moved too. */
	private readonly onWrite: (dto: BandPlanWriteDto) => void

	constructor(
		api: ApiClient,
		events: EventsClient,
		onWrite: (dto: BandPlanWriteDto) => void,
	) {
		super({ view: null, loaded: false, error: null, busy: false })
		this.api = api
		this.onWrite = onWrite
		this.cleanup = [
			events.on("bandplans:changed", ({ storeId, revision }) => {
				const s = this.get().view?.store
				if (!s) return
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

	/** Loads once (the planner and the palette ask on open). */
	ensure(): Promise<void> {
		return this.get().loaded ? Promise.resolve() : this.load()
	}

	private async fetch(): Promise<void> {
		try {
			const view = await this.api.get<ScanPresetListView>(
				"/api/bandplans/presets",
			)
			this.update(s => ({ ...s, view, loaded: true, error: null }))
		} catch (error) {
			this.update(s => ({ ...s, loaded: true, error: errorMessage(error) }))
		}
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
				path: "/api/bandplans/presets",
			})
		return { storeId: s.storeId, revision: s.revision }
	}

	private async write(
		method: "PUT" | "POST" | "DELETE",
		path: string,
		body: Record<string, unknown> = {},
	): Promise<BandPlanWriteDto> {
		this.update(s => ({ ...s, busy: true }))
		try {
			const dto = await this.api.request<BandPlanWriteDto>(method, path, {
				expected: this.expected(),
				...body,
			})
			this.onWrite(dto)
			await this.load()
			return dto
		} catch (error) {
			if (error instanceof ApiError && error.code === "BANDPLANS_CONFLICT")
				void this.load()
			throw error
		} finally {
			this.update(s => ({ ...s, busy: false }))
		}
	}

	/** Resolves to the new preset's id. */
	async create(preset: ScanPresetInput): Promise<string | null> {
		const dto = await this.write("POST", "/api/bandplans/presets", { preset })
		return dto.createdId
	}

	async replace(id: string, preset: ScanPresetInput): Promise<void> {
		await this.write("PUT", presetPath(id), { preset })
	}

	async remove(id: string): Promise<void> {
		await this.write("DELETE", presetPath(id))
	}

	dispose(): void {
		for (const fn of this.cleanup.splice(0)) fn()
	}
}

const presetPath = (id: string) =>
	`/api/bandplans/presets/${encodeURIComponent(id)}`
