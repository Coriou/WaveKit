import type { Logger } from "../../utils/logger.js"

export const BURST_ABSORBER_DEFAULT_S = 2
export const BURST_ABSORBER_MAX_S = 10
/** Instrumentation first (requirement 2.3): disabled until the live record accepts it. */
export const BURST_ABSORBER_DEFAULT_ENABLED = false
export const ABSORBER_RELEASE_BYTES = 65_536
export const ABSORBER_LAGGARD_MS = 500 // provisional
export const LINK_GAP_MS = 80 // provisional
export const HOST_LOOP_DELAY_MS = 50
export const CATCHUP_WINDOW_MS = 500
/** Allow one maximum-capacity backlog to catch up at twice nominal rate. */
export const LINK_RECOVERY_WAIT_MS = BURST_ABSORBER_MAX_S * 1000
export const LINK_QUALITY_WINDOW_MS = 600_000
export const LINK_QUALITY_SLOT_MS = 10_000
export const LINK_DROPPING_HOLD_MS = 60_000
export const LOOP_METER_RESOLUTION_MS = 10
export const ABSORBER_COUNTER_PREFIX = "@absorber"
export const GAP_BUCKETS = 48 // geometric, ratio 1.25 from 1 ms
export const CHUNK_SIZE_BUCKETS = 16 // log2 bytes
export const CATCHUP_BUCKETS = 16 // log2 from CATCHUP_BUCKET_BASE_BYTES
export const CATCHUP_BUCKET_BASE_BYTES = 1_024
export const LOOP_DELAY_RING = 300 // 10 min of 2 s efficiency intervals
export type SourceTransport = "loopback" | "network"
export function frameBytesFor(format: string): 2 | 4 | null {
	return format === "U8_IQ" ? 2 : format === "S16_IQ" ? 4 : null
}
export function resolveAbsorberSeconds(
	configured: number | undefined,
	transport: SourceTransport,
): number {
	return (
		configured ??
		(transport === "network" && BURST_ABSORBER_DEFAULT_ENABLED
			? BURST_ABSORBER_DEFAULT_S
			: 0)
	)
}
export interface AbsorberFanoutPort {
	distribute(chunk: Buffer): void
	congestedBranchIds(out: Set<string>): void
	activeBranchIds(out: Set<string>): void
	on(
		event: "drain" | "branch-added" | "branch-removed" | "backpressure",
		fn: (id: string) => void,
	): void
	off(
		event: "drain" | "branch-added" | "branch-removed" | "backpressure",
		fn: (id: string) => void,
	): void
}
export interface IngestObserver {
	observeChunk(bytes: number, mono: number): void
	noteHolding(mono: number): void
}
export interface IngestInterval {
	maxGapMs: number
	catchupBytes: number
	chunks: number
}
export interface IngestWindowStats {
	worstStallMs: number | null
	gapP99Ms: number | null
	burstSeconds: number
	catchupBytes: number
	chunks: number
}
export interface IngestHistograms {
	gapBucketUpperMs: readonly number[]
	gapCounts: readonly number[]
	chunkSizeBucketUpperBytes: readonly number[]
	chunkSizeCounts: readonly number[]
	catchupBucketUpperBytes: readonly number[]
	catchupCounts: readonly number[]
}
export interface RecoveryEvidence {
	/** Retained episode outcome only; use rolling-rate evidence for current delivery. */
	retired?: boolean
	sequence: number
	completedSequence: number
	failedSequence: number
	maxGapMs: number
	shortfall: boolean | null
}
export interface IngestRecorder extends IngestObserver {
	/** Recovery balance since the arrival before the latest gap; null while catching up. */
	recovery(nowMono: number): RecoveryEvidence | null
	configure(sampleRateHz: number, frameBytes: number): void
	resetArrival(): void
	interval(fromMono: number, toMono: number): IngestInterval | null
	window(nowMono: number): IngestWindowStats
	/** Read-only; allocates per call (reporting path only, never per chunk). */
	histograms(nowMono: number): IngestHistograms
}
export interface AbsorberCounters {
	capacityBytes: number
	heldBytes: number
	absorbedBytesTotal: number
	overflowBytesTotal: number
	overflowChunksTotal: number
	flushedBytesTotal: number
	window: {
		peakHeldBytes: number
		absorbedBytes: number
		overflowBytes: number
		flushedBytes: number
		peakHeldMs: number
		maxLaggardExcludeMs: number | null
	}
}
export interface BurstAbsorber {
	configure(capacityBytes: number): void
	ingest(chunk: Buffer): void
	flush(reason: "disconnect" | "rate" | "removed"): void
	counters(): AbsorberCounters
	dispose(): void
}
export interface BurstAbsorberDeps {
	fanout: AbsorberFanoutPort
	recorder: IngestObserver | null
	monoNow: () => number
	frameBytes: number
	log: Logger
}
export interface LoopDelayInterval {
	maxMs: number
	p99Ms: number
}
export interface LoopDelayReport {
	last: LoopDelayInterval | null
	maxMs10m: number | null
	p99MaxMs10m: number | null
	intervals10m: number
}
export interface EventLoopMeter {
	/** The monitor's read: returns and resets the native histogram (the only reset). */
	takeInterval(): LoopDelayInterval | null
	/** Reporting read: never resets; answers from the ring of taken intervals. */
	report(nowMono: number): LoopDelayReport
	dispose(): void
}
export interface SdrHostLinkFacts {
	interfaceKind: "ethernet" | "wireless" | "other" | null
	signalDbm: number | null
	undervoltageNow: boolean | null
	throttled: boolean | null
}
export interface LinkBurstHandles {
	transport: SourceTransport
	capacitySeconds: number
	recorder: IngestRecorder | null
	absorber: BurstAbsorber | null
}
export interface LinkBurstFactories {
	createRecorder(sourceId: string): IngestRecorder
	createAbsorber(sourceId: string, deps: BurstAbsorberDeps): BurstAbsorber
	monoNow: () => number
}
