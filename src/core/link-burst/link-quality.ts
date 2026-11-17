import { z } from "zod"
import type {
	DropAttribution,
	LinkAdvisory,
	LinkBurstSummary,
	ResourceLinkAdvisory,
	SourceLinkQuality,
} from "@wavekit/api-types"
import { LINK_DROPPING_HOLD_MS, LINK_QUALITY_WINDOW_MS } from "./contract.js"
import type {
	LinkBurstHandles,
	LoopDelayReport,
	SdrHostLinkFacts,
} from "./contract.js"

export interface LinkQualityDeps {
	advisory?: (id: string) => LinkAdvisory | null
	reportAdvisory?: (id: string, advisory: LinkAdvisory) => void
	sources: () => readonly string[]
	handles: (id: string) => LinkBurstHandles | null
	attribution: (id: string) => {
		last: DropAttribution | null
		counts10m: Record<DropAttribution, number>
	} | null
	upstreamDropRate: (id: string) => number | null
	receiver: (id: string) => SdrHostLinkFacts | null
	loopDelay?: () => LoopDelayReport | null
	monoNow: () => number
	now: () => number
}
export interface LinkQuality {
	/**
	 * Classifies every network source, records its advisory state, and reports an alert once
	 * per change of `level` and `lossReason` (never for a recovery to `none`).
	 */
	recheckAdvisories(): void
	/** The state recorded by the last `recheckAdvisories`, one entry per network source. */
	advisories(): ResourceLinkAdvisory[]
	all(): SourceLinkQuality[]
	one(sourceId: string): SourceLinkQuality | null
	burst(sourceId: string): LinkBurstSummary | null
}
const number = z.number().finite()
const nullable = number.nullable().catch(null)
const zero = number.nonnegative().catch(0)
const attribution = z.enum(["none", "link", "host", "consumer", "unknown"])
const counts = z.object({
	none: zero,
	link: zero,
	host: zero,
	consumer: zero,
	unknown: zero,
})
const receiverSchema = z.object({
	interfaceKind: z
		.enum(["ethernet", "wireless", "other"])
		.nullable()
		.catch(null),
	signalDbm: nullable,
	undervoltageNow: z.boolean().nullable().catch(null),
	throttled: z.boolean().nullable().catch(null),
})
const loopSchema = z.object({
	last: z.object({ maxMs: number, p99Ms: number }).nullable(),
	maxMs10m: nullable,
	p99MaxMs10m: nullable,
	intervals10m: zero,
})
const histSchema = z.object({
	gapBucketUpperMs: z.array(number),
	gapCounts: z.array(number),
	chunkSizeBucketUpperBytes: z.array(number),
	chunkSizeCounts: z.array(number),
	catchupBucketUpperBytes: z.array(number),
	catchupCounts: z.array(number),
})
function read<T>(fn: () => T): T | null {
	try {
		return fn()
	} catch {
		return null
	}
}
function numeric(value: unknown): number {
	return zero.parse(value)
}
function optionalNumber(value: unknown): number | null {
	return nullable.parse(value)
}

interface AdvisoryState {
	key: string
	level: LinkAdvisory["level"]
	lossReason: LinkAdvisory["lossReason"]
	since: string
	/** ISO start of the dropping episode; null outside one. */
	episodeSince: string | null
	/** Monotonic time of the first non-dropping recheck since the episode last dropped. */
	clearSinceMono: number | null
	/** Monotonic time of the first of the consecutive rechecks that failed; null otherwise. */
	failSinceMono: number | null
}

/** A source with no advisory to classify: non-dropping, so a dropping episode's hold runs. */
const NOT_CLASSIFIED: Pick<LinkAdvisory, "level"> = { level: "none" }

export function createLinkQuality(deps: LinkQualityDeps): LinkQuality {
	const states = new Map<string, AdvisoryState>()
	const isoNow = (): string => {
		const wall = read(deps.now)
		const date = new Date(
			typeof wall === "number" && Number.isFinite(wall) ? wall : 0,
		)
		return Number.isNaN(date.getTime())
			? new Date(0).toISOString()
			: date.toISOString()
	}
	const record = (
		id: string,
		advisory: Pick<LinkAdvisory, "level" | "lossReason">,
	): boolean => {
		const key = `${advisory.level}|${advisory.lossReason ?? ""}`
		const previous = states.get(id)
		const changed = previous?.key !== key
		const iso = isoNow()
		const mono = read(deps.monoNow)
		let episodeSince = previous?.episodeSince ?? null
		let clearSinceMono = previous?.clearSinceMono ?? null
		if (advisory.level === "dropping") {
			episodeSince ??= iso
			clearSinceMono = null
		} else if (episodeSince !== null) {
			// The episode ends once the advisory has been non-dropping for the hold.
			if (typeof mono !== "number" || !Number.isFinite(mono)) {
				/* Keep the episode until time is readable again. */
			} else if (clearSinceMono === null) clearSinceMono = mono
			else if (mono - clearSinceMono >= LINK_DROPPING_HOLD_MS) {
				episodeSince = null
				clearSinceMono = null
			}
		}
		states.set(id, {
			key,
			level: advisory.level,
			lossReason: advisory.lossReason,
			since: changed || !previous ? iso : previous.since,
			episodeSince,
			clearSinceMono,
			failSinceMono: null,
		})
		return changed
	}
	/**
	 * A failed recheck keeps the last state; once rechecks have failed for
	 * `LINK_DROPPING_HOLD_MS` in a row, the source reads non-dropping, so a stale `dropping`
	 * cannot stick forever.
	 */
	const failed = (id: string, state: AdvisoryState): void => {
		const mono = read(deps.monoNow)
		if (typeof mono !== "number" || !Number.isFinite(mono)) return
		const failSinceMono = state.failSinceMono ?? mono
		// Once aged out, each failed recheck counts as non-dropping, so the episode hold runs.
		if (mono - failSinceMono >= LINK_DROPPING_HOLD_MS)
			record(id, NOT_CLASSIFIED)
		const current = states.get(id)
		if (current) current.failSinceMono = failSinceMono
	}
	function one(sourceId: string): SourceLinkQuality | null {
		const handles = read(() => deps.handles(sourceId))
		if (!handles) return null
		const mono = read(deps.monoNow) ?? 0
		const window = read(() => handles.recorder?.window(mono))
		const counters = read(() => handles.absorber?.counters())
		const attr = read(() => deps.attribution(sourceId))
		const receiver = receiverSchema.safeParse(
			read(() => deps.receiver(sourceId)),
		)
		const loop = loopSchema.safeParse(read(() => deps.loopDelay?.()))
		const hist = histSchema.safeParse(
			read(() => handles.recorder?.histograms(mono)),
		)
		return {
			sourceId,
			transport: handles.transport === "network" ? "network" : "loopback",
			at: isoNow(),
			absorber: {
				enabled: handles.absorber !== null,
				capacityBytes: numeric(counters?.capacityBytes),
				capacitySeconds: handles.absorber
					? numeric(handles.capacitySeconds)
					: 0,
				heldBytes: numeric(counters?.heldBytes),
				peakHeldBytes10m: numeric(counters?.window?.peakHeldBytes),
				peakHeldMs10m: numeric(counters?.window?.peakHeldMs),
				laggardExcludeMsMax10m: optionalNumber(
					counters?.window?.maxLaggardExcludeMs,
				),
				absorbedBytesTotal: numeric(counters?.absorbedBytesTotal),
				overflowBytesTotal: numeric(counters?.overflowBytesTotal),
				overflowChunksTotal: numeric(counters?.overflowChunksTotal),
				flushedBytesTotal: numeric(counters?.flushedBytesTotal),
				absorbedBytes10m: numeric(counters?.window?.absorbedBytes),
				overflowBytes10m: numeric(counters?.window?.overflowBytes),
				flushedBytes10m: numeric(counters?.window?.flushedBytes),
			},
			arrivals: {
				windowMs: LINK_QUALITY_WINDOW_MS,
				worstStallMs: optionalNumber(window?.worstStallMs),
				gapP99Ms: optionalNumber(window?.gapP99Ms),
				burstSeconds: numeric(window?.burstSeconds),
				catchupBytes10m: numeric(window?.catchupBytes),
				chunks10m: numeric(window?.chunks),
			},
			attribution: {
				last: attribution.nullable().catch(null).parse(attr?.last),
				counts10m: counts
					.catch({ none: 0, link: 0, host: 0, consumer: 0, unknown: 0 })
					.parse(attr?.counts10m ?? {}),
			},
			upstreamDropBytesPerSecond: optionalNumber(
				read(() => deps.upstreamDropRate(sourceId)),
			),
			receiver:
				receiver.success &&
				Object.values(receiver.data).some(value => value !== null)
					? receiver.data
					: null,
			loopDelay: loop.success ? loop.data : null,
			...(hist.success
				? { histograms: { windowMs: LINK_QUALITY_WINDOW_MS, ...hist.data } }
				: {}),
		}
	}
	return {
		one,
		recheckAdvisories() {
			const seen = new Set<string>()
			for (const id of read(deps.sources) ?? []) {
				try {
					if (deps.handles(id)?.transport !== "network") continue
					const advisory = deps.advisory?.(id)
					if (!advisory) {
						// Nothing to classify (no host or rate yet): a recorded source reads
						// non-dropping, so its episode ends only after the hold.
						if (states.has(id)) {
							seen.add(id)
							record(id, NOT_CLASSIFIED)
						}
						continue
					}
					seen.add(id)
					// A cause change re-reports once; a recovery is recorded, not alerted.
					if (record(id, advisory) && advisory.level !== "none")
						deps.reportAdvisory?.(id, advisory)
				} catch {
					/* Unavailable evidence keeps the last state, for at most the hold. */
					const state = states.get(id)
					if (state) {
						seen.add(id)
						failed(id, state)
					}
				}
			}
			for (const id of states.keys()) if (!seen.has(id)) states.delete(id)
		},
		advisories: () =>
			[...states].map(([sourceId, state]) => ({
				sourceId,
				level: state.level,
				...(state.lossReason === undefined
					? {}
					: { lossReason: state.lossReason }),
				since: state.since,
				...(state.episodeSince === null
					? {}
					: { episodeSince: state.episodeSince }),
			})),
		all: () =>
			(read(deps.sources) ?? []).flatMap(id => {
				const report = read(() => one(id))
				return report ? [report] : []
			}),
		burst: sourceId => {
			const handles = read(() => deps.handles(sourceId))
			if (!handles?.recorder || handles.transport !== "network") return null
			const report = one(sourceId)
			return report
				? {
						worstStallMs: report.arrivals.worstStallMs,
						overflowedBytes10m: report.absorber.overflowBytes10m,
						burstSeconds: report.arrivals.burstSeconds,
					}
				: null
		},
	}
}
