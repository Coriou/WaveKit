import type { BandRegion } from "@wavekit/api-types"
import { z } from "zod"
import { builtinBandplansFor } from "../../core/bandplans/builtin-supplement.js"
import type { ScannerProtocol } from "../../core/scanner/types.js"
import { ACTIVITY_MAX_CANDIDATES } from "./activity-contract.js"
import { ACTIVITY_DWELL_MS, ACTIVITY_MOVE_WINDOW_MS } from "./activity-plan.js"
import type { ActivityPolicy } from "./activity-plan.js"
import { DECODER_PROTOCOLS } from "./contract.js"

/** 256 = one quarter of a 1,024-candidate query; oldest insertion dropped first. */
export const DSD_MAX_DEMOTIONS = ACTIVITY_MAX_CANDIDATES / 4

/**
 * Hold for a full rolling move window or one dwell per permitted move,
 * whichever is longer: max(60,000, dwellMs × max(1, maxMovesPerMinute)).
 * Defaults: max(60,000, 20,000 × 6) = 120 s, enough to try six other dwells
 * before a failed channel competes again. Zero moves still holds a full window.
 */
export function dsdNoSyncCooldownMs(policy: ActivityPolicy): number {
	return Math.max(
		ACTIVITY_MOVE_WINDOW_MS,
		policy.dwellMs * Math.max(1, policy.maxMovesPerMinute),
	)
}

/** A quiet run loses clean-sync protection at/past one cooldown from receipt. */
export function dsdSyncProtectionUntil(
	lastCleanMonoMs: number | null,
	now: number,
	policy: ActivityPolicy,
): number | null {
	if (
		lastCleanMonoMs === null ||
		!Number.isFinite(lastCleanMonoMs) ||
		!Number.isFinite(now) ||
		lastCleanMonoMs > now
	)
		return null
	const until = lastCleanMonoMs + dsdNoSyncCooldownMs(policy)
	return Number.isFinite(until) && now < until ? until : null
}

/** Only explicitly checked, CRC/FEC-clean parser lines renew protection. */
const SyncSchema = z.object({
	protocol: z.enum(["dmr", "p25", "nxdn", "ysf", "dpmr", "dstar"]),
	at: z.number().finite(),
	crcErr: z.literal(false),
	verified: z.literal(true),
	fecErrs: z.literal(0).optional(),
})
export function isDsdActivitySync(line: unknown): boolean {
	return SyncSchema.safeParse(line).success
}

export class DsdActivityDemotions {
	private readonly entries = new Map<string, number>()

	note(key: string, now: number, policy: ActivityPolicy): void {
		this.entries.delete(key)
		this.entries.set(key, now + dsdNoSyncCooldownMs(policy))
		while (this.entries.size > DSD_MAX_DEMOTIONS) {
			const oldest = this.entries.keys().next()
			if (!oldest.done) this.entries.delete(oldest.value)
		}
	}

	clear(key: string): void {
		this.entries.delete(key)
	}

	/** Active strictly before the deadline; at/past it the channel may compete again. */
	snapshot(now: number): { key: string; untilMonoMs: number }[] {
		const active: { key: string; untilMonoMs: number }[] = []
		for (const [key, untilMonoMs] of this.entries) {
			if (now >= untilMonoMs) this.entries.delete(key)
			else active.push({ key, untilMonoMs })
		}
		return active
	}
}

/** Band-plan protocols that make a range ISM/SRD or LoRa: never a dsd-fme activity slot. */
const DSD_NEVER_PROTOCOLS: readonly ScannerProtocol[] = ["ism", "lora"]

interface DsdSlotRanges {
	voice: readonly (readonly [number, number])[]
	never: readonly (readonly [number, number])[]
}
/** One entry per region at most (BAND_REGIONS), filled on first use. */
const slotRanges = new Map<BandRegion, DsdSlotRanges>()

function slotRangesFor(region: BandRegion): DsdSlotRanges {
	const hit = slotRanges.get(region)
	if (hit) return hit
	const voiceProtocols: readonly string[] = DECODER_PROTOCOLS["dsd-fme"] ?? []
	const voice: (readonly [number, number])[] = []
	const never: (readonly [number, number])[] = []
	for (const plan of builtinBandplansFor(region))
		for (const range of plan.ranges) {
			const protocols: readonly string[] = range.protocols ?? []
			const span = [range.startHz, range.endHz] as const
			if (
				protocols.some(p => DSD_NEVER_PROTOCOLS.includes(p as ScannerProtocol))
			)
				never.push(span)
			else if (protocols.some(p => voiceProtocols.includes(p))) voice.push(span)
		}
	const out = { voice, never }
	slotRanges.set(region, out)
	return out
}

/**
 * Whether a dsd-fme activity slot (a ranked secondary channel, scanner energy
 * centres included) may sit at `hz`: inside a range of the region's band plan
 * catalogue that lists a protocol dsd-fme decodes (land mobile, PMR446, dPMR446,
 * amateur 2 m / 70 cm) and inside no range listing ISM or LoRa (the 433 MHz
 * and 863-870 MHz ISM/SRD bands, where LoRa and telemetry bursts would
 * otherwise pull slots around). Unknown region or a malformed frequency: no
 * slot (the safe answer). The configured, band and VFO channels are not
 * activity slots and are not checked here.
 */
export function dsdActivitySlotAllowed(
	region: BandRegion | undefined,
	hz: number,
): boolean {
	if (region === undefined || !Number.isFinite(hz) || hz <= 0) return false
	let ranges: DsdSlotRanges
	try {
		ranges = slotRangesFor(region)
	} catch {
		return false
	}
	const inside = (r: readonly [number, number]) => hz >= r[0] && hz <= r[1]
	return ranges.voice.some(inside) && !ranges.never.some(inside)
}

/**
 * Challenge hysteresis: a ranked channel may displace a running dsd-fme
 * activity slot only after its energy was observed at least
 * DSD_CHALLENGE_MIN_OBSERVATIONS = 2 times (distinct energy timestamps, one
 * per placement pass) spanning at least DSD_CHALLENGE_MIN_SPAN_MS = 10 s
 * (ACTIVITY_DWELL_MS / 2 = 20 000 / 2) within DSD_CHALLENGE_MEMORY_MS. A
 * one-off burst shorter than 10 s therefore never moves a slot however many
 * passes see it: every energy timestamp it leaves lies inside its own
 * duration, so first and last differ by less than the span. A voice channel
 * qualifies with one transmission of 10 s or more, or two transmissions 10 s
 * apart. Together with the 20 s dwell and at most 6 moves a minute, a slot
 * moves at most once per 20 s and only towards a channel heard for 10 s.
 */
export const DSD_CHALLENGE_MIN_OBSERVATIONS = 2
export const DSD_CHALLENGE_MIN_SPAN_MS = ACTIVITY_DWELL_MS / 2
/**
 * Evidence is forgotten after 2 × 60 s = 120 s (two move windows, as long as
 * a channel stays hot after energy), so an old burst never pairs with a new one.
 */
export const DSD_CHALLENGE_MEMORY_MS = 2 * ACTIVITY_MOVE_WINDOW_MS
/**
 * Kept timestamps are thinned to one per DSD_CHALLENGE_THIN_MS = 5 s
 * (DSD_CHALLENGE_MIN_SPAN_MS / 2) plus the newest: a new timestamp within 5 s
 * of the one before the newest replaces the newest. Every kept timestamp is a
 * real observation, so thinning never confirms early; the oldest kept lies at
 * most 5 s after the oldest seen, so it can delay a confirmation by 5 s once
 * the first observation ages out. At most 120 000 / 5 000 + 2 = 26 per channel.
 */
export const DSD_CHALLENGE_THIN_MS = DSD_CHALLENGE_MIN_SPAN_MS / 2
export const DSD_CHALLENGE_MAX_OBSERVATIONS =
	DSD_CHALLENGE_MEMORY_MS / DSD_CHALLENGE_THIN_MS + 2
/** Channels tracked: one query's 1 024 candidates; oldest insertion dropped first. */
export const DSD_MAX_CHALLENGERS = ACTIVITY_MAX_CANDIDATES

/** The identity of one challenger channel of one (decoder, source) group. */
export function dsdChallengeKey(
	decoderId: string,
	sourceId: string,
	hz: number,
): string {
	return JSON.stringify([decoderId, sourceId, hz])
}

export class DsdChallengeEvidence {
	private readonly entries = new Map<string, number[]>()

	/**
	 * Records one energy timestamp of a channel, as a snapshot reports it
	 * (`lastEnergyMonoMs`). Ignored: not finite, in the future, older than the
	 * memory, or not newer than the last one recorded (the same energy seen by
	 * another pass is not a new observation).
	 */
	note(key: string, energyMonoMs: number | null, now: number): void {
		if (
			energyMonoMs === null ||
			!Number.isFinite(energyMonoMs) ||
			!Number.isFinite(now) ||
			energyMonoMs > now ||
			now - energyMonoMs >= DSD_CHALLENGE_MEMORY_MS
		)
			return
		const kept = (this.entries.get(key) ?? []).filter(
			t => now - t < DSD_CHALLENGE_MEMORY_MS,
		)
		if (kept.length && energyMonoMs <= kept[kept.length - 1]!) return
		if (
			kept.length >= 2 &&
			energyMonoMs - kept[kept.length - 2]! < DSD_CHALLENGE_THIN_MS
		)
			kept[kept.length - 1] = energyMonoMs
		else kept.push(energyMonoMs)
		while (kept.length > DSD_CHALLENGE_MAX_OBSERVATIONS) kept.shift()
		this.entries.delete(key)
		this.entries.set(key, kept)
		while (this.entries.size > DSD_MAX_CHALLENGERS) {
			const oldest = this.entries.keys().next()
			if (!oldest.done) this.entries.delete(oldest.value)
		}
	}

	/** Whether the channel's evidence within the memory meets both bounds. */
	confirmed(key: string, now: number): boolean {
		const kept = (this.entries.get(key) ?? []).filter(
			t => now - t < DSD_CHALLENGE_MEMORY_MS && t <= now,
		)
		return (
			kept.length >= DSD_CHALLENGE_MIN_OBSERVATIONS &&
			kept[kept.length - 1]! - kept[0]! >= DSD_CHALLENGE_MIN_SPAN_MS
		)
	}

	/** Keys confirmed now; expired evidence is dropped. */
	snapshot(now: number): string[] {
		const out: string[] = []
		for (const [key, kept] of this.entries) {
			if (!kept.some(t => now - t < DSD_CHALLENGE_MEMORY_MS))
				this.entries.delete(key)
			else if (this.confirmed(key, now)) out.push(key)
		}
		return out
	}
}
