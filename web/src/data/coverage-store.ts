/**
 * Receiver coverage (WG3 requirement 7): GET /api/coverage, the farthest ADS-B and AIS position per
 * 1° bearing over 24 h from the station location. `available: false` with
 * `reason: "no-station-location"` when no location is configured. In memory only on the core and
 * not pushed: the Map refreshes it while it is open (every `refreshMs`).
 */
import { z } from "zod/v4"
import { COVERAGE_PROTOCOLS } from "@wavekit/api-types"
import type { CoverageResponse } from "@wavekit/api-types"

import type { ApiClient } from "./api-client.ts"
import { ApiError, errorMessage, validated } from "./api-client.ts"
import type { Listener, ReadableStore } from "./store.ts"
import { Store } from "./store.ts"

const PATH = "/api/coverage"

const sectorSchema = z.object({
	bearingDeg: z.number(),
	maxRangeM: z.number(),
	lat: z.number(),
	lon: z.number(),
	at: z.string(),
})

export const coverageSchema = z.object({
	available: z.boolean(),
	reason: z.literal("no-station-location").optional(),
	station: z.object({ lat: z.number(), lon: z.number() }).nullable(),
	windowHours: z.number(),
	bearingStepDeg: z.number(),
	protocols: z.array(
		z.object({
			protocol: z.enum(COVERAGE_PROTOCOLS as ["adsb", "ais"]),
			sectors: z.array(sectorSchema),
			maxRangeM: z.number().nullable(),
			accepted: z.number(),
		}),
	),
	timestamp: z.string(),
})
export type Coverage = z.infer<typeof coverageSchema>

// the schema accepts the DTO
export type CoverageCheck =
	CoverageResponse extends z.input<typeof coverageSchema> ? true : never

export interface CoverageState {
	/** `unavailable`: the core has no coverage route (404). */
	readonly status: "idle" | "loading" | "ready" | "unavailable" | "error"
	readonly coverage: Coverage | null
	readonly error: string | null
}

export class CoverageStore implements ReadableStore<CoverageState> {
	private readonly state = new Store<CoverageState>({
		status: "idle",
		coverage: null,
		error: null,
	})
	private readonly api: ApiClient
	private readonly refreshMs: number
	private attached = 0
	private timer: ReturnType<typeof setInterval> | null = null
	private inflight: Promise<void> | null = null

	constructor(api: ApiClient, options: { refreshMs?: number } = {}) {
		this.api = api
		this.refreshMs = options.refreshMs ?? 60_000
	}

	get(): CoverageState {
		return this.state.get()
	}

	subscribe = (listener: Listener<CoverageState>): (() => void) =>
		this.state.subscribe(listener)

	/** Loads now and every refreshMs while attached (reference counted). */
	attach(): () => void {
		this.attached += 1
		if (this.attached === 1) {
			void this.load()
			this.timer = setInterval(() => void this.load(), this.refreshMs)
		}
		let done = false
		return () => {
			if (done) return
			done = true
			this.attached -= 1
			if (this.attached > 0) return
			if (this.timer !== null) clearInterval(this.timer)
			this.timer = null
		}
	}

	/** Never rejects. */
	load(): Promise<void> {
		this.inflight ??= this.fetch().finally(() => {
			this.inflight = null
		})
		return this.inflight
	}

	private async fetch(): Promise<void> {
		if (this.state.get().coverage === null)
			this.state.update(s => ({ ...s, status: "loading" }))
		try {
			const body = await this.api.get<unknown>(PATH)
			const coverage = validated(coverageSchema, body, "GET", PATH)
			this.state.set({ status: "ready", coverage, error: null })
		} catch (error) {
			if (error instanceof ApiError && error.status === 404)
				this.state.set({ status: "unavailable", coverage: null, error: null })
			else
				this.state.update(s => ({
					...s,
					status: s.coverage ? s.status : "error",
					error: errorMessage(error),
				}))
		}
	}
}
