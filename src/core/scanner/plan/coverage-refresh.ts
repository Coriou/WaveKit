/**
 * WG7 (web-gaps-7 requirement 7, design "Band-plan skips and decoded-elsewhere refresh"):
 * trailing-debounced, rate-limited refresh trigger for decoded-elsewhere ranges. Pure of
 * wall-clock and timers: both are injected.
 */
import {
	DECODED_ELSEWHERE_MAX_DECODERS,
	DECODED_ELSEWHERE_MAX_TARGETS,
	DECODED_ELSEWHERE_REFRESH_DEBOUNCE_MS,
	DECODED_ELSEWHERE_REFRESH_MIN_INTERVAL_MS,
} from "@wavekit/api-types"
import type { DecoderCoverageView } from "../types.js"

export interface CoverageRefreshOptions {
	debounceMs?: number
	minIntervalMs?: number
	now?: () => number
	setTimer?: (fn: () => void, ms: number) => unknown
	clearTimer?: (handle: unknown) => void
	fingerprint: () => string
	onRefresh: () => void
	onError?: (err: unknown) => void
}

export interface CoverageRefresh {
	notify(): void
	dispose(): void
}

function defaultSetTimer(fn: () => void, ms: number): unknown {
	const handle = setTimeout(fn, ms)
	handle.unref()
	return handle
}

function defaultClearTimer(handle: unknown): void {
	clearTimeout(handle as ReturnType<typeof setTimeout>)
}

/**
 * Semantics:
 * - `notify()` is O(1) and never throws. It (re)arms one trailing timer at
 *   max(now + debounceMs, lastFireAt + minIntervalMs).
 * - The rate limit applies to every fire (every fingerprint computation), changed or not, so
 *   the cost bound holds: fires are at least minIntervalMs apart. A failed fingerprint still
 *   counts as a fire.
 * - On fire the fingerprint is computed; a throw goes to `onError` and leaves the stored
 *   fingerprint alone (the next notify retries). A fingerprint different from the last
 *   refreshed one is stored and `onRefresh` runs (a throw goes to `onError`).
 * - The baseline is null until the first successful fire, so the first fire always refreshes.
 */
export function createCoverageRefresh(
	options: CoverageRefreshOptions,
): CoverageRefresh {
	const debounceMs = options.debounceMs ?? DECODED_ELSEWHERE_REFRESH_DEBOUNCE_MS
	const minIntervalMs =
		options.minIntervalMs ?? DECODED_ELSEWHERE_REFRESH_MIN_INTERVAL_MS
	const now = options.now ?? Date.now
	const setTimer = options.setTimer ?? defaultSetTimer
	const clearTimer = options.clearTimer ?? defaultClearTimer
	let handle: unknown = undefined
	let armed = false
	let disposed = false
	let lastFireAt = Number.NEGATIVE_INFINITY
	let last: string | null = null

	const reportError = (err: unknown): void => {
		try {
			options.onError?.(err)
		} catch {
			// an error sink must not break the trigger
		}
	}

	const fire = (): void => {
		armed = false
		handle = undefined
		if (disposed) return
		lastFireAt = now()
		let fp: string
		try {
			fp = options.fingerprint()
		} catch (err) {
			reportError(err)
			return
		}
		if (fp === last) return
		last = fp
		try {
			options.onRefresh()
		} catch (err) {
			reportError(err)
		}
	}

	return {
		notify(): void {
			if (disposed) return
			try {
				const t = now()
				const at = Math.max(t + debounceMs, lastFireAt + minIntervalMs)
				if (armed) clearTimer(handle)
				armed = false
				handle = setTimer(fire, Math.max(0, at - t))
				armed = true
			} catch (err) {
				reportError(err)
			}
		},
		dispose(): void {
			if (disposed) return
			disposed = true
			if (armed) {
				try {
					clearTimer(handle)
				} catch {
					// already gone
				}
			}
			armed = false
			handle = undefined
		},
	}
}

const BAD = "?"

function norm(v: unknown): unknown {
	if (typeof v === "number") return Number.isFinite(v) ? v : String(v)
	if (typeof v === "string" || typeof v === "boolean" || v === null) return v
	return BAD
}

function prefixOf(v: unknown, max: number): unknown[] {
	if (!Array.isArray(v)) return [BAD]
	const len: unknown = v.length
	const n = typeof len === "number" && Number.isFinite(len) ? len : 0
	const out: unknown[] = [n]
	const k = Math.min(n, max)
	const arr = v as readonly unknown[]
	for (let i = 0; i < k; i++) out.push(arr[i])
	return out
}

function bandTuple(band: unknown): unknown {
	if (band === null) return null
	if (typeof band !== "object") return BAD
	const b = band as Record<string, unknown>
	const targets = prefixOf(b["targetsHz"], DECODED_ELSEWHERE_MAX_TARGETS).map(
		norm,
	)
	const ranges = prefixOf(b["rangesHz"], DECODED_ELSEWHERE_MAX_TARGETS).map(
		(r, i) => {
			if (i === 0) return norm(r)
			if (r === null || typeof r !== "object") return BAD
			const o = r as Record<string, unknown>
			return [norm(o["minHz"]), norm(o["maxHz"])]
		},
	)
	return [
		norm(b["verdict"]),
		norm(b["basis"]),
		targets,
		ranges,
		norm(b["captureCenterHz"]),
		norm(b["windowHalfWidthHz"]),
	]
}

function viewTuple(view: unknown): unknown {
	try {
		if (view === null || typeof view !== "object") return BAD
		const v = view as Record<string, unknown>
		return [
			norm(v["id"]),
			norm(v["running"]),
			norm(v["health"]),
			norm(v["suspended"]),
			norm(v["owner"]),
			norm(v["sourceId"]),
			norm(v["inputKind"]),
			bandTuple(v["band"]),
		]
	} catch {
		return BAD
	}
}

/**
 * Stable fingerprint of the coverage views over exactly the fields the WG6 trust rule
 * (`computeDecodedElsewhere`) reads: id, running, health, suspended, owner, sourceId,
 * inputKind and band {verdict, basis, targetsHz, rangesHz{minHz,maxHz}, captureCenterHz,
 * windowHalfWidthHz}. View order matters. Only the first DECODED_ELSEWHERE_MAX_DECODERS views
 * and DECODED_ELSEWHERE_MAX_TARGETS targets/ranges are read (the rest cannot affect coverage,
 * their count is included). Total: malformed entries become a fixed token, never throws.
 */
export function coverageFingerprint(
	views: readonly DecoderCoverageView[],
): string {
	try {
		if (!Array.isArray(views)) return JSON.stringify([BAD])
		const len: unknown = views.length
		const n = typeof len === "number" && Number.isFinite(len) ? len : 0
		const k = Math.min(n, DECODED_ELSEWHERE_MAX_DECODERS)
		const out: unknown[] = [n]
		for (let i = 0; i < k; i++) out.push(viewTuple(views[i]))
		return JSON.stringify(out)
	} catch {
		return JSON.stringify([BAD])
	}
}
