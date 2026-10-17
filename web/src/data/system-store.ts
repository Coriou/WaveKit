/**
 * About and storage: version and uptime from GET /api/status (core's /health answers liveness
 * only), the WG4 storage report GET /api/storage, and the link of the redacted configuration
 * export (WG6; mounted by a protected core only).
 */
import { CONFIG_EXPORT_ROUTE } from "@wavekit/api-types"
import type { StorageReport } from "@wavekit/api-types"
import type { ApiClient } from "./api-client.ts"
import { ApiError, errorMessage } from "./api-client.ts"
import { Store } from "./store.ts"

export interface SystemState {
	version: string | null
	/** Core process uptime in seconds, as of the last load. */
	uptimeS: number | null
	/** Null until loaded, and when the core reports no storage (route not mounted). */
	storage: StorageReport | null
	loaded: boolean
	error: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isStorageReport(value: unknown): value is StorageReport {
	return (
		isRecord(value) &&
		typeof value["generatedAt"] === "string" &&
		Array.isArray(value["areas"]) &&
		isRecord(value["lowSpace"])
	)
}

export class SystemStore extends Store<SystemState> {
	private readonly api: ApiClient
	private inflight: Promise<void> | null = null

	constructor(api: ApiClient) {
		super({
			version: null,
			uptimeS: null,
			storage: null,
			loaded: false,
			error: null,
		})
		this.api = api
	}

	/** GET /api/status and GET /api/storage. Never rejects: a failure lands in `error`. */
	load(): Promise<void> {
		this.inflight ??= this.fetch().finally(() => {
			this.inflight = null
		})
		return this.inflight
	}

	/** Download link of the redacted configuration export (YAML). */
	configExportUrl(): string {
		return this.api.url(CONFIG_EXPORT_ROUTE)
	}

	private async fetch(): Promise<void> {
		const [status, storage] = await Promise.allSettled([
			this.api.get<unknown>("/api/status"),
			this.api.get<unknown>("/api/storage"),
		])
		const errors: string[] = []
		let version: string | null = null
		let uptimeS: number | null = null
		if (status.status === "fulfilled" && isRecord(status.value)) {
			const v = status.value["version"]
			const u = status.value["uptime"]
			version = typeof v === "string" ? v : null
			uptimeS = typeof u === "number" && Number.isFinite(u) ? u : null
		} else if (status.status === "rejected")
			errors.push(errorMessage(status.reason))
		const current = this.get()
		let report: StorageReport | null = current.storage
		if (storage.status === "fulfilled") {
			if (isStorageReport(storage.value)) report = storage.value
			else errors.push("Unexpected answer from /api/storage")
		} else if (
			storage.reason instanceof ApiError &&
			storage.reason.status === 404
		)
			report = null // no storage report on this core
		else errors.push(errorMessage(storage.reason))
		this.set({
			version: version ?? current.version,
			uptimeS: uptimeS ?? current.uptimeS,
			storage: report,
			loaded: true,
			error: errors.length > 0 ? errors.join("; ") : null,
		})
	}
}
