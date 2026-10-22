import { z } from "zod"
import type {
	DropAttribution,
	LinkBurstSummary,
	SourceLinkQuality,
} from "@wavekit/api-types"
import { LINK_QUALITY_WINDOW_MS } from "./contract.js"
import type {
	LinkBurstHandles,
	LoopDelayReport,
	SdrHostLinkFacts,
} from "./contract.js"

export interface LinkQualityDeps {
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

export function createLinkQuality(deps: LinkQualityDeps): LinkQuality {
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
		const wall = read(deps.now)
		const date = new Date(
			typeof wall === "number" && Number.isFinite(wall) ? wall : 0,
		)
		return {
			sourceId,
			transport: handles.transport === "network" ? "network" : "loopback",
			at: Number.isNaN(date.getTime())
				? new Date(0).toISOString()
				: date.toISOString(),
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
