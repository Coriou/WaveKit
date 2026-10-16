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

/** Token for a read that threw or a container that is not one; never equal to a value tag. */
const THREW = ["x"]

/**
 * Type-tagged scalar: distinct values of distinct types never collide, and no valid value
 * collides with a malformed token. Non-primitive scalars are all equivalent to WG6 (every check
 * on these fields is a primitive comparison), so they share one tag.
 */
function tag(v: unknown): unknown[] {
	switch (typeof v) {
		case "string":
			return ["s", v]
		case "number":
			return ["n", Object.is(v, -0) ? "-0" : String(v)]
		case "boolean":
			return ["b", v]
		case "undefined":
			return ["u"]
		default:
			return v === null ? ["z"] : ["o"]
	}
}

function isFreq(v: unknown): v is number {
	return typeof v === "number" && Number.isFinite(v) && v >= 0
}

/** Same as WG6 `lengthOf`: array length read once, non-arrays have none. */
function lengthOf(v: unknown): number {
	if (!Array.isArray(v)) return 0
	const n: unknown = v.length
	return typeof n === "number" && Number.isFinite(n) && n > 0
		? Math.floor(n)
		: 0
}

/**
 * The band reads WG6 `coverageOf` performs for a view with this `sourceId` and `inputKind`, in
 * the same order and with the same shared targets-then-ranges budget. Nothing it skips is read.
 */
function bandReads(
	sourceId: unknown,
	inputKind: unknown,
	band: object,
): unknown[] {
	const b = band as Record<string, unknown>
	const verdict = b["verdict"]
	const basis = b["basis"]
	const targets = b["targetsHz"]
	const ranges = b["rangesHz"]
	const c = b["captureCenterHz"]
	const w = b["windowHalfWidthHz"]
	const out: unknown[] = [tag(verdict), tag(basis), tag(c), tag(w)]
	const nTargets = lengthOf(targets)
	out.push(nTargets)
	let budget = DECODED_ELSEWHERE_MAX_TARGETS
	const tarr = targets as readonly unknown[]
	if (sourceId !== null) {
		if (verdict !== "in-band" || !isFreq(c) || !isFreq(w)) return out
		const tCount = Math.min(nTargets, budget)
		for (let i = 0; i < tCount; i++) out.push(tag(tarr[i]))
		budget -= tCount
		const nRanges = lengthOf(ranges)
		out.push(nRanges)
		const rCount = Math.min(nRanges, budget)
		const rarr = ranges as readonly unknown[]
		for (let i = 0; i < rCount; i++) {
			const r: unknown = rarr[i]
			if (r === null || typeof r !== "object") {
				out.push(tag(r))
				continue
			}
			const o = r as Record<string, unknown>
			const minHz = o["minHz"]
			const maxHz = o["maxHz"]
			out.push(["r", tag(minHz), tag(maxHz)])
		}
		return out
	}
	if (inputKind !== "external") return out
	const count = Math.min(nTargets, budget)
	for (let i = 0; i < count; i++) out.push(tag(tarr[i]))
	return out
}

function viewTuple(view: unknown): unknown {
	if (view === null || typeof view !== "object") return tag(view)
	let fields: unknown[]
	let sourceId: unknown
	let inputKind: unknown
	let band: unknown
	try {
		// Same fields, same order, each read once, as WG6 `snapshotView`.
		const v = view as Record<string, unknown>
		const id = v["id"]
		const running = v["running"]
		const health = v["health"]
		const suspended = v["suspended"]
		const owner = v["owner"]
		sourceId = v["sourceId"]
		inputKind = v["inputKind"]
		band = v["band"]
		fields = [id, running, health, suspended, owner, sourceId, inputKind].map(
			tag,
		)
	} catch {
		return THREW
	}
	if (band === null || typeof band !== "object") return [...fields, tag(band)]
	try {
		return [...fields, ["band", ...bandReads(sourceId, inputKind, band)]]
	} catch {
		return [...fields, THREW]
	}
}

/**
 * Stable fingerprint of the coverage views over exactly what the WG6 trust rule
 * (`computeDecodedElsewhere`) reads, mirroring its read order and bounds: the first
 * DECODED_ELSEWHERE_MAX_DECODERS views by index (each indexed read caught on its own), their
 * id, running, health, suspended, owner, sourceId, inputKind and band, and of the band the
 * same targets-then-ranges prefix under one shared DECODED_ELSEWHERE_MAX_TARGETS budget.
 * Values are type-tagged so no valid value collides with a malformed or throwing token.
 * Equal fingerprints imply equal `computeDecodedElsewhere` output for any spec. View order
 * matters. Total: never throws.
 */
export function coverageFingerprint(
	views: readonly DecoderCoverageView[],
): string {
	try {
		const n = lengthOf(views)
		const k = Math.min(n, DECODED_ELSEWHERE_MAX_DECODERS)
		const out: unknown[] = [n]
		for (let i = 0; i < k; i++) {
			let view: unknown
			try {
				view = views[i]
			} catch {
				out.push(THREW)
				continue
			}
			out.push(viewTuple(view))
		}
		return JSON.stringify(out)
	} catch {
		return JSON.stringify(THREW)
	}
}
