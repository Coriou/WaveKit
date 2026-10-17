/**
 * The core's spectrum limits from GET /api/spectrum: the most bins a client may ask for
 * (`limits.bins.max`, WG8: min(host bins cap, scanner.ws.spectrumSummaryBins)) and the cap behind it.
 * Settings › FFT size offers sizes up to `binsMax`; the plot asks for at most that.
 */
import {
	SPECTRUM_BINS_CAP_SETTINGS,
	type SpectrumBinsCapView,
} from "@wavekit/api-types"
import type { ApiClient } from "./api-client.ts"
import { errorMessage } from "./api-client.ts"
import { Store } from "./store.ts"

export interface SpectrumLimitsState {
	/** Largest `bins` this core serves; null until loaded (or when the core has no spectrum service). */
	binsMax: number | null
	/** How the host cap was chosen (WG8 cores only). */
	binsCap: SpectrumBinsCapView | null
	error: string | null
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v)

const CAP_SOURCES = ["config", "measured", "fallback"] as const

/** The limits of a GET /api/spectrum answer; null when it has none. */
export function parseSpectrumLimits(
	body: unknown,
): Omit<SpectrumLimitsState, "error"> | null {
	const limits = isRecord(body) ? body["limits"] : undefined
	const bins = isRecord(limits) ? limits["bins"] : undefined
	const max = isRecord(bins) ? bins["max"] : undefined
	if (typeof max !== "number" || !Number.isFinite(max) || max < 1) return null
	const cap = isRecord(limits) ? limits["binsCap"] : undefined
	let binsCap: SpectrumBinsCapView | null = null
	if (
		isRecord(cap) &&
		typeof cap["cap"] === "number" &&
		(SPECTRUM_BINS_CAP_SETTINGS as readonly unknown[]).includes(
			cap["setting"],
		) &&
		(CAP_SOURCES as readonly unknown[]).includes(cap["source"])
	)
		binsCap = {
			setting: cap["setting"] as SpectrumBinsCapView["setting"],
			cap: cap["cap"],
			source: cap["source"] as SpectrumBinsCapView["source"],
		}
	return { binsMax: Math.floor(max), binsCap }
}

export class SpectrumLimitsStore extends Store<SpectrumLimitsState> {
	private readonly api: ApiClient
	private inflight: Promise<void> | null = null

	constructor(api: ApiClient) {
		super({ binsMax: null, binsCap: null, error: null })
		this.api = api
	}

	/** GET /api/spectrum. Never rejects: a failure lands in `error` and keeps the last limits. */
	load(): Promise<void> {
		this.inflight ??= this.fetch().finally(() => {
			this.inflight = null
		})
		return this.inflight
	}

	private async fetch(): Promise<void> {
		try {
			const parsed = parseSpectrumLimits(
				await this.api.get<unknown>("/api/spectrum"),
			)
			if (parsed) this.set({ ...parsed, error: null })
			else
				this.update(s => ({
					...s,
					error: "Unexpected answer from /api/spectrum",
				}))
		} catch (error) {
			this.update(s => ({ ...s, error: errorMessage(error) }))
		}
	}
}
