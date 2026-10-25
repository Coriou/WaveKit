/**
 * Detection quality R4 (data is not voice): a closed analog transmission is
 * withheld from Activity when a paging or APRS decode from the same source, on
 * a channel basis with commanded or relay tuning, lands within 1 250 Hz and
 * 1 s of it. The decision waits DQ_DATA_HOLD_MS after close. Anything unknown
 * (no provenance, a full hold table, a wrapped ring) publishes as today.
 *
 * Core only. Envelopes come from a tap on the Activity publisher; the gate
 * never throws into the decoder path or the tracker.
 */
import type { DecodeEnvelope } from "../activity/types.js"

export const DQ_DATA_FREQ_HZ = 1_250
export const DQ_DATA_WINDOW_MS = 1_000
export const DQ_DATA_HOLD_MS = 1_000
export const DQ_DATA_HELD_MAX = 8
export const DQ_DATA_RING = 256
export const DQ_DATA_RATE_PER_S = 16
/** Bound on per-source rate buckets; stale buckets are swept past this. */
const RATE_SOURCES_MAX = 64

/** The fields of a closed transmission the gate reads (Activity payload or WS event). */
export interface DataDecodeClose {
	transmissionId?: string
	sourceId: string | null
	startedAt: string
	endedAt: string | null
	frequency: { hz: number } | null
}

export interface DataDecodeGateStats {
	/** Accepted receptions dropped by the per-source rate cap. */
	dropped: number
	/** Closes delivered at once because DQ_DATA_HELD_MAX were already held. */
	heldOverflow: number
}

export interface DataDecodeGate {
	/** Offered every Activity envelope; ignores anything that cannot match. Never throws. */
	noteEnvelope(env: DecodeEnvelope): void
	/** Delivers exactly once: `true` when a matching data decode was retained. Never throws. */
	hold(event: DataDecodeClose, deliver: (isData: boolean) => void): void
	/** Delivers every held close at once as not-data; later holds deliver at once. */
	stop(): void
	stats(): DataDecodeGateStats
}

export interface DataDecodeGateOptions {
	now?: () => number
	/** Schedules `fn` after `ms`; returns a cancel. Defaults to an unref'd setTimeout. */
	setTimer?: (fn: () => void, ms: number) => () => void
}

interface Reception {
	sourceId: string
	hz: number
	at: number
}

interface Held {
	key: string | null
	sourceId: string
	hz: number
	from: number
	to: number
	delivers: ((isData: boolean) => void)[]
	cancel: () => void
}

export function createDataDecodeGate(
	options: DataDecodeGateOptions = {},
): DataDecodeGate {
	const now = options.now ?? Date.now
	const setTimer = options.setTimer ?? defaultTimer
	const ring: (Reception | undefined)[] = new Array<Reception | undefined>(
		DQ_DATA_RING,
	)
	let next = 0
	const rate = new Map<string, { start: number; count: number }>()
	const held = new Set<Held>()
	let stopped = false
	let dropped = 0
	let heldOverflow = 0

	const admit = (sourceId: string, at: number): boolean => {
		let bucket = rate.get(sourceId)
		if (
			bucket === undefined ||
			at - bucket.start >= 1_000 ||
			at < bucket.start
		) {
			if (bucket === undefined && rate.size >= RATE_SOURCES_MAX) {
				for (const [id, b] of rate) if (at - b.start >= 1_000) rate.delete(id)
				if (rate.size >= RATE_SOURCES_MAX) {
					const oldest = rate.keys().next().value
					if (oldest !== undefined) rate.delete(oldest)
				}
			}
			bucket = { start: at, count: 0 }
			rate.set(sourceId, bucket)
		}
		if (bucket.count >= DQ_DATA_RATE_PER_S) return false
		bucket.count++
		return true
	}

	const matches = (h: Held): boolean => {
		for (const r of ring) {
			if (
				r !== undefined &&
				r.sourceId === h.sourceId &&
				Math.abs(r.hz - h.hz) <= DQ_DATA_FREQ_HZ &&
				r.at >= h.from &&
				r.at <= h.to
			)
				return true
		}
		// No retained match. A wrapped ring may have overwritten one: unknown, so the
		// close publishes as today (4.5) without a separate wrap check.
		return false
	}

	const settle = (h: Held, isData: boolean): void => {
		if (!held.delete(h)) return
		try {
			h.cancel()
		} catch {
			// A failing cancel does not block delivery.
		}
		for (const deliver of h.delivers) safeDeliver(deliver, isData)
	}

	return {
		noteEnvelope(env) {
			try {
				if (env.category !== "paging" && env.category !== "aprs") return
				const p = env.provenance as unknown
				if (typeof p !== "object" || p === null) return
				const { sourceId, frequency } = p as {
					sourceId?: unknown
					frequency?: unknown
				}
				if (typeof sourceId !== "string" || sourceId.length === 0) return
				if (typeof frequency !== "object" || frequency === null) return
				const f = frequency as {
					hz?: unknown
					basis?: unknown
					tuningTrust?: unknown
				}
				if (f.basis !== "channel") return
				if (f.tuningTrust !== "commanded" && f.tuningTrust !== "relay") return
				if (typeof f.hz !== "number" || !Number.isFinite(f.hz)) return
				if (typeof env.producedAt !== "string") return
				const at = Date.parse(env.producedAt)
				if (!Number.isFinite(at)) return
				if (!admit(sourceId, now())) {
					dropped++
					return
				}
				ring[next] = { sourceId, hz: f.hz, at }
				next = (next + 1) % DQ_DATA_RING
			} catch {
				// A hostile envelope is ignored.
			}
		},
		hold(event, deliver) {
			let h: Held | null = null
			try {
				if (stopped) return safeDeliver(deliver, false)
				const sourceId = event.sourceId
				const hz = event.frequency?.hz
				const from = Date.parse(event.startedAt)
				const to =
					event.endedAt === null ? Number.NaN : Date.parse(event.endedAt)
				if (
					typeof sourceId !== "string" ||
					sourceId.length === 0 ||
					typeof hz !== "number" ||
					!Number.isFinite(hz) ||
					!Number.isFinite(from) ||
					!Number.isFinite(to) ||
					to < from
				)
					return safeDeliver(deliver, false)
				const key =
					typeof event.transmissionId === "string" ? event.transmissionId : null
				if (key !== null) {
					for (const other of held) {
						if (other.key === key && other.sourceId === sourceId) {
							other.delivers.push(deliver)
							return
						}
					}
				}
				if (held.size >= DQ_DATA_HELD_MAX) {
					heldOverflow++
					return safeDeliver(deliver, false)
				}
				const entry: Held = {
					key,
					sourceId,
					hz,
					from: from - DQ_DATA_WINDOW_MS,
					to: to + DQ_DATA_WINDOW_MS,
					delivers: [deliver],
					cancel: () => undefined,
				}
				h = entry
				held.add(entry)
				entry.cancel = setTimer(() => {
					let isData = false
					try {
						isData = matches(entry)
					} catch {
						isData = false
					}
					settle(entry, isData)
				}, DQ_DATA_HOLD_MS)
			} catch {
				if (h !== null) settle(h, false)
				else safeDeliver(deliver, false)
			}
		},
		stop() {
			stopped = true
			for (const h of [...held]) settle(h, false)
		},
		stats() {
			return { dropped, heldOverflow }
		},
	}
}

function safeDeliver(
	deliver: (isData: boolean) => void,
	isData: boolean,
): void {
	try {
		deliver(isData)
	} catch {
		// A throwing consumer does not break the gate or other consumers.
	}
}

function defaultTimer(fn: () => void, ms: number): () => void {
	const handle = setTimeout(fn, ms)
	handle.unref()
	return () => {
		clearTimeout(handle)
	}
}
