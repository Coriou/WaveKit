import type { PagingRasterRange } from "./paging-plan.js"
import type {
	DecoderReachKind,
	DropAttribution,
	DecoderMode,
	DecoderModeSource,
	DecoderStartMode,
	DecoderSuspensionReasonCode,
	DecoderPlacementView,
	DecoderEfficiencyView,
	DecoderEfficiencyDetail,
} from "@wavekit/api-types"
import type { DecoderBandRequirements } from "../band-resolver.js"

/**
 * Requirement 5.4: automatic channelizer composition is accepted per host
 * architecture. The capacity record of 2026-10-21
 * (docs/engineering/CAPACITY-2026-10-21-DECODER-ENABLEMENT.md) accepts x86-64;
 * arm64 stays unaccepted until a Pi 4-class host is measured.
 */
export function channelizerAutoAccepted(arch: string): boolean {
	return arch === "x64"
}
export const DECODER_MAX_BANDPLAN_CHANNELS = 4
/**
 * 3.18: most paging raster channels one pager decoder places per source.
 * A 1.024 Msps capture has a usable window of 1.024 MHz x 0.8 = 819.2 kHz:
 * at most floor(819.2 / 6.25) + 1 = 132 raster points, fewer once each
 * channel's 6 kHz half-passband plus 2.5 kHz transition must fit inside
 * (floor((819.2 - 17) / 6.25) + 1 = 129). 33 holds the whole French UHF
 * paging band (466.025-466.230 MHz at 6.25 kHz) and 412.5 kHz of a 12.5 kHz
 * band; nearest the capture centre first. Each channel is one channelizer
 * output plus one multimon-ng pipeline at 48 kHz (see paging-plan.ts and the
 * amendment for the measured cost); the efficiency gate admits what fits.
 */
export const MULTIMON_PAGING_MAX_CHANNELS = 33
export const VFO_SETTLE_MS = 1_000
export const EFFICIENCY_SAMPLE_MS = 2_000
// 3 × 2000 ms = 6000 ms: tolerates one missed tick plus jitter.
export const EFFICIENCY_STALE_MS = 3 * EFFICIENCY_SAMPLE_MS
export const EFFICIENCY_DROP_WINDOW_MS = 10_000
export const EFFICIENCY_CLEAR_MS = 60_000
export const EFFICIENCY_PROBATION_MS = 30_000
export const EFFICIENCY_RETRY_MS = 300_000
export const EFFICIENCY_RETRY_MAX_MS = 1_800_000
export const EFFICIENCY_BUDGET_X64 = 1.5
export const EFFICIENCY_BUDGET_ARM64 = 0.75
export const EFFICIENCY_CPU_GUARD_PERCENT = 90
export const CHANNELIZER_IDLE_STOP_MS = 60_000
export const CHANNEL_MARGINAL_CORES = 0.11
export const CHANNELIZER_BASE_CORES_2048K = 0.22
export const CHANNELIZER_BASE_CORES_2400K = 0.26
export const DECODER_COST_UNKNOWN_CORES = 0.6
/** A decoder's raw fanout branch buffers more for this long after it activates. */
export const DECODER_BRANCH_STARTUP_MS = 5_000
/** Startup buffer: this many seconds of the source's byte rate (at least the normal mark). */
export const DECODER_BRANCH_STARTUP_BUFFER_S = 1.5

/** A8: how src/index.ts composes the channelizer. "enabled": today's opt-in (immediate retire);
 *  "auto": constructed lazily with the idle linger; null: nothing constructed, setChannelizer(null). */
export type ChannelizerComposition = "enabled" | "auto" | null
export function channelizerComposition(
	cfg: { enabled: boolean; auto?: boolean | undefined },
	accepted: boolean,
): ChannelizerComposition {
	return cfg.enabled
		? "enabled"
		: cfg.auto !== false && accepted
			? "auto"
			: null
}
export const CATALOGUE_TYPES = [
	"readsb",
	"ais-catcher",
	"acarsdec",
	"dumpvdl2",
	"rtl433",
	"direwolf",
	"multimon-ng",
	"dsd-fme",
	"lora-meshtastic",
] as const
export type CatalogueType = (typeof CATALOGUE_TYPES)[number]
export const CHANNEL_CAPABLE_TYPES: readonly CatalogueType[] = [
	"ais-catcher",
	"acarsdec",
	"dumpvdl2",
	"rtl433",
	"direwolf",
	"multimon-ng",
	"dsd-fme",
]
export const DECODER_PROTOCOLS: Readonly<
	Partial<Record<CatalogueType, readonly string[]>>
> = {
	"dsd-fme": [
		"dmr",
		"p25p1",
		"p25p2",
		"ysf",
		"dstar",
		"nxdn48",
		"nxdn96",
		"dpmr",
	],
	"multimon-ng": ["pocsag", "flex"],
}
export type DecoderReach = DecoderReachKind
export interface DecoderCost {
	cores: number
	basis: "measurement" | "estimate"
}
export const DECODER_COSTS: Readonly<Record<CatalogueType, DecoderCost>> = {
	readsb: { cores: 0.25, basis: "estimate" },
	"ais-catcher": { cores: 0.1, basis: "measurement" },
	acarsdec: { cores: 0.05, basis: "estimate" },
	dumpvdl2: { cores: 0.15, basis: "estimate" },
	rtl433: { cores: 0.1, basis: "estimate" },
	direwolf: { cores: 0.05, basis: "estimate" },
	"multimon-ng": { cores: 0.03, basis: "estimate" },
	"dsd-fme": { cores: 0.045, basis: "estimate" },
	"lora-meshtastic": { cores: 0.6, basis: "estimate" },
}
// readsb 0.25 e, ais-catcher 0.10 m, acarsdec 0.05 e, dumpvdl2 0.15 e, rtl433 0.10 e, direwolf 0.05 e,
// multimon-ng 0.03 e, dsd-fme 0.045 e, lora-meshtastic 0.60 e (decoder share; channel reach adds CHANNEL_MARGINAL_CORES)
export function placementCostCores(type: string, reach: DecoderReach): number {
	const cost = Object.hasOwn(DECODER_COSTS, type)
		? DECODER_COSTS[type as CatalogueType].cores
		: DECODER_COST_UNKNOWN_CORES
	return cost + (reach === "channel" ? CHANNEL_MARGINAL_CORES : 0)
}
export function channelizerBaseCores(sampleRateHz: number): number {
	return sampleRateHz <= 2_048_000
		? CHANNELIZER_BASE_CORES_2048K
		: CHANNELIZER_BASE_CORES_2400K
}
export function defaultCpuBudgetCores(arch: string, cpuCount: number): number {
	return arch === "arm64" && cpuCount <= 4
		? EFFICIENCY_BUDGET_ARM64
		: EFFICIENCY_BUDGET_X64
}
export interface CatalogueEntry {
	type: CatalogueType
	options: Readonly<Record<string, unknown>>
}
export interface ResolvedMode {
	mode: DecoderMode
	source: DecoderModeSource
}
export interface PlannerDecoder {
	id: string
	type: string
	origin: "config" | "catalogue"
	order: number // YAML index, then YAML length + catalogue index
	mode: DecoderMode
	startMode: DecoderStartMode
	configuredSourceId: string | null
	band: DecoderBandRequirements | undefined // undefined: unknown, never band-suspended
	configuredChannelsHz: readonly number[]
	/** False when an explicit frequency option prevents configured VFO following. */
	followVfo?: boolean
	reach: DecoderReach
	channelBandwidthHz: number
	channelTransitionHz: number
	protocols: readonly string[]
	channelPlacements: boolean // catalogue: true; YAML: useChannelizer === true (A1)
	unavailable: boolean
	ownDevice: boolean
	centreSlotHz: { minHz: number; maxHz: number } | null
	centrePassbandHz: number | null // lora only
	/**
	 * Requirement 3.17: alternative centre slots (the catalogue LoRa decoder in
	 * a multi-slot region); each is tried as a centre-reach candidate and the
	 * chosen one's options go to the adapter. Absent: `centreSlotHz` alone.
	 */
	centreSlots?: readonly PlannerCentreSlot[]
	/** False when global or per-decoder band suspension is off (3.13): band policy skipped. */
	bandSuspension?: boolean
	/** Half-width of the window the band assessment uses (narrower frontends); absent: usable window. */
	bandHalfWidthHz?: number
	/** rtl_433 (3.16): the widest channel output rate it wants; absent 1 MHz. */
	channelTargetRateHz?: number
	/**
	 * 3.18: the paging raster of the effective region (pager decoder only).
	 * Present and non-empty: without configured channels the decoder takes
	 * every raster channel of the band inside the usable window.
	 */
	pagingRaster?: readonly PagingRasterRange[]
}
export interface PlannerCentreSlot {
	slotHz: { minHz: number; maxHz: number }
	options: Readonly<Record<string, unknown>>
}
/** rtl_433 channel bounds (design 2026-10-25): narrowest accepted and target rate. */
export const RTL433_CHANNEL_MIN_RATE_HZ = 250_000
export const RTL433_CHANNEL_TARGET_RATE_HZ = 1_000_000
/**
 * Widest capture rtl_433 reads whole (window reach): 2.4 Msps, the highest
 * rate an RTL-SDR streams without drops and well inside rtl_433's own
 * 3.2 Msps limit. Its CPU is linear in the rate: 2.6% of one core measured at
 * 1.024 Msps, so about 6% at 2.4 Msps. Faster captures use a channel.
 */
export const RTL433_WINDOW_MAX_RATE_HZ = 2_400_000
export interface PlannerSource {
	id: string
	centreHz: number | null
	sampleRateHz: number | null
	usableFraction: number
	dedicatedScanner: boolean
	held: boolean
	reservedBy: string | null
	channelizerAvailable: boolean
	order: number
}
export interface PlannerVfo {
	sourceId: string
	frequencyHz: number
}
export type BandplanChannelLookup = (
	window: { sourceId: string; minHz: number; maxHz: number },
	protocols: readonly string[],
) => readonly number[]
/** True when hz lies in an enabled scanner-plan range listing one of the protocols (3.5). */
export type BandplanRangeLookup = (
	sourceId: string,
	hz: number,
	protocols: readonly string[],
) => boolean
export interface PlannerInput {
	decoders: readonly PlannerDecoder[]
	sources: readonly PlannerSource[]
	vfo: PlannerVfo | null
	bandplanChannels: BandplanChannelLookup
	/** Absent, throwing or not true: the VFO is not in a matching range. */
	bandplanRangeContains?: BandplanRangeLookup
	maxBandplanChannels: number
}
export interface WantedPlacement {
	key: string
	decoderId: string
	sourceId: string
	channelHz: number | null
	reach: DecoderReach
	origin: DecoderPlacementView["origin"]
	primary: boolean
	costCores: number
	sampleRateHz: number
	/**
	 * Adapter options of this placement, applied over the decoder's own
	 * (rtl_433 `targetSampleRate`, LoRa `region` and `frequency`). A change
	 * restarts the placement; absent means none.
	 */
	options?: Readonly<Record<string, unknown>>
	/**
	 * 3.18: an automatically generated secondary paging channel. It goes
	 * through the efficiency gate and probation even for a YAML decoder.
	 */
	gated?: true
}
/** Stable comparison key of placement options (absent and empty are equal). */
export function placementOptionsKey(
	options: Readonly<Record<string, unknown>> | undefined,
): string {
	if (!options) return ""
	const keys = Object.keys(options).sort()
	return keys.length === 0
		? ""
		: JSON.stringify(keys.map(key => [key, options[key]]))
}
export interface PlacementPlan {
	wanted: readonly WantedPlacement[] // admission order (4.2, 3.7)
	unplaced: ReadonlyMap<string, DecoderSuspensionReasonCode> // decoderId → reason when it has no placement
}
export type PlacementPlanner = (input: PlannerInput) => PlacementPlan
export function placementKey(
	decoderId: string,
	sourceId: string,
	reach: DecoderReach,
	channelHz: number | null,
): string {
	return `${decoderId}#${reach === "channel" ? channelHz : reach}@${sourceId}`
}
export interface SourceDropSample {
	attribution?: DropAttribution
	droppedBytesDelta: number | null
	droppedChunksDelta: number | null
} // null: unreadable
export interface EfficiencySample {
	atMs: number
	cpuPercent: number | null
	sources: ReadonlyMap<string, SourceDropSample>
}
export interface EfficiencyInputs {
	budgetCores: number
	cpuGuardPercent: number
}
export interface RunningPlacement {
	mode?: DecoderMode
	startMode?: DecoderStartMode
	key: string
	sourceId: string
	reach: DecoderReach
	costCores: number
	sampleRateHz: number
	admittedAtMs: number
}
export type AdmissionDecision =
	| { admit: true }
	| { admit: false; detail: DecoderEfficiencyDetail; retryAtMs: number }
export interface ProbationVerdict {
	key: string
	detail: "drops" | "cpu" | "late-drops"
}
export interface EfficiencyGate {
	record(sample: EfficiencySample): void
	admit(
		newcomer: WantedPlacement,
		running: readonly RunningPlacement[],
		now: number,
	): AdmissionDecision
	probation(
		running: readonly RunningPlacement[],
		now: number,
	): readonly ProbationVerdict[]
	noteSuspended(key: string, detail: DecoderEfficiencyDetail, now: number): void
	forget(key: string): void
	view(
		running: readonly RunningPlacement[],
		blocked: readonly {
			placement: WantedPlacement
			decision: AdmissionDecision
		}[],
		now: number,
	): DecoderEfficiencyView
}

export const LATE_SHED_WINDOWS = 3
export const LATE_SHED_HITS = 2
export const LATE_SHED_COOLDOWN_MS = 30_000
export interface LateDropWindow {
	startMono: number
	endMono: number
	condemning: boolean
	/** Positive drops occurred in the window, but only in samples attributed `link` or `unknown`. */
	linkOrUnknownDrops: boolean
}
