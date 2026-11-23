import type { BandRegion } from "@wavekit/api-types"
import { z } from "zod"
import { builtinBandplansFor } from "../../core/bandplans/builtin-supplement.js"
import type { ScannerProtocol } from "../../core/scanner/types.js"
import {
	ACTIVITY_DECODE_HOT_MS,
	ACTIVITY_DECODE_WARM_MS,
	ACTIVITY_WARM_HOLD_MS,
} from "../../core/scanner/channel-activity.js"
import {
	ACTIVITY_MAX_CANDIDATES,
	quantiseObservedCentre,
} from "./activity-contract.js"
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

/**
 * Digital hold: 2 × ACTIVITY_DECODE_HOT_MS = 2 × 900,000 = 1,800,000 ms
 * (30 min) after the last checked sync. A held channel ranks first and is
 * never a victim (except the discovery yield, activity-plan.ts).
 */
export const DSD_DIGITAL_HOLD_MS = 2 * ACTIVITY_DECODE_HOT_MS
/**
 * Digital memory: ACTIVITY_DECODE_WARM_MS = 21,600,000 ms (6 h) after the
 * last checked sync, the same memory as a scanner decode. Past the hold the
 * channel is digital but not held: it ranks with unknown channels.
 */
export const DSD_DIGITAL_MEMORY_MS = ACTIVITY_DECODE_WARM_MS
/** Cooldown doubling steps: cooldown(n) = base × 2^min(n − 1, 4); base 120 s gives 120..1,920 s. */
export const DSD_NOSYNC_MAX_DOUBLINGS = 4
/**
 * A channel the scanner classed analog FM is tried at most once per
 * cooldown(DSD_ANALOG_TRY_FAILURES) = cooldown(5) = 120 × 2^4 = 1,920 s, and a
 * slot group makes at most one such analog-to-analog move per 1,920 s:
 * 3,600 / 1,920 = 1.875 moves per hour per group.
 */
export const DSD_ANALOG_TRY_FAILURES = DSD_NOSYNC_MAX_DOUBLINGS + 1
/** A no-sync entry is forgotten (failures reset) at until + ACTIVITY_WARM_HOLD_MS (15 min). */
export const DSD_NOSYNC_FORGET_MS = ACTIVITY_WARM_HOLD_MS
/**
 * Try times (the last failed try per channel) are kept for
 * DSD_DIGITAL_MEMORY_MS = 6 h, apart from the no-sync entries, for the
 * analog try gap and the least-recently-tried order. 6 h / 1,920 s = 11.25
 * analog tries per group, so with up to 11 scanner-analog channels in a
 * group every one is tried before any is tried twice. Bounded to
 * DSD_MAX_TIERS = 256, oldest insertion dropped first.
 */
export const DSD_TRY_MEMORY_MS = DSD_DIGITAL_MEMORY_MS
/** Channel tiers kept: DSD_MAX_DEMOTIONS = 256 (≈ 256 × 120 B ≈ 30 KiB); nosync evicted first. */
export const DSD_MAX_TIERS = DSD_MAX_DEMOTIONS
/** Slot groups with an analog try time: the same 256 bound, oldest insertion dropped first. */
export const DSD_MAX_RETRY_GROUPS = DSD_MAX_DEMOTIONS

/** cooldown(n) = dsdNoSyncCooldownMs × 2^min(max(n, 1) − 1, 4). */
export function dsdNoSyncCooldownAfter(
	failures: number,
	policy: ActivityPolicy,
): number {
	const n = Number.isFinite(failures) ? Math.max(1, Math.floor(failures)) : 1
	return (
		dsdNoSyncCooldownMs(policy) * 2 ** Math.min(n - 1, DSD_NOSYNC_MAX_DOUBLINGS)
	)
}

/**
 * The RF identity of one dsd-fme channel of one (decoder, source) group: the
 * frequency on the 6,250 Hz raster (quantiseObservedCentre), not the
 * placement key, so it survives restarts, origin changes and retunes. Null
 * for a frequency that is not finite and positive (no tier is kept).
 */
export function dsdTierKey(
	decoderId: string,
	sourceId: string,
	hz: number,
): string | null {
	if (!Number.isFinite(hz) || hz <= 0) return null
	return dsdChallengeKey(decoderId, sourceId, quantiseObservedCentre(hz))
}

/** The key of one (decoder, source) slot group for its analog try time. */
export function dsdGroupKey(decoderId: string, sourceId: string): string {
	return JSON.stringify([decoderId, sourceId])
}

/** One manager tier entry, as the planner reads it. */
export interface DsdTierView {
	key: string
	tier: "digital" | "nosync"
	/** digital: last sync + 6 h; nosync: noted + cooldown(failures). */
	untilMonoMs: number
	failures: number
	lastSyncMonoMs?: number
	notedMonoMs?: number
}

interface TierEntry {
	tier: "digital" | "nosync"
	untilMonoMs: number
	failures: number
	lastSyncMonoMs: number | null
	notedMonoMs: number | null
	forgetMonoMs: number
}

/**
 * Per-channel dsd-fme tiers (manager-owned, on the manager's monotonic
 * clock). Transitions (user rules in docs/DECODER-GUIDE.md, Troubleshooting,
 * Decoder not starting, item 8):
 * - a checked sync: digital, last = now, until = now + 6 h, failures 0;
 * - a failed sync of a run (dwell passed, no sync since its start): a digital
 *   entry is unchanged; otherwise nosync, failures + 1, until = now +
 *   cooldown(failures). Escalation needs a re-try: a failure is noted once
 *   per run, so failures grow only when the channel runs again. While that
 *   run goes on without sync, each pass renews until = max(until, now +
 *   cooldown(failures)) (renewFailure): the cooldown counts from its end;
 * - digital at/past last + 6 h, nosync at/past its forget time: deleted.
 * Insertion order is renewed by delete-then-set on every write; past
 * DSD_MAX_TIERS the oldest nosync entry goes first, then the oldest digital.
 */
export class DsdChannelTiers {
	private readonly entries = new Map<string, TierEntry>()
	private readonly retries = new Map<string, number>()
	private readonly tries = new Map<string, number>()

	/**
	 * Writes one entry. Past DSD_MAX_TIERS, entries at/past their forget time
	 * are swept first; then the oldest other nosync entry goes, then the
	 * oldest other digital one. The entry just written is never its own
	 * victim, so at most DSD_MAX_TIERS entries remain and the newest survives.
	 */
	private set(key: string, entry: TierEntry, now: number): void {
		this.entries.delete(key)
		this.entries.set(key, entry)
		if (this.entries.size <= DSD_MAX_TIERS) return
		for (const [k, e] of [...this.entries])
			if (k !== key && now >= e.forgetMonoMs) this.entries.delete(k)
		while (this.entries.size > DSD_MAX_TIERS) {
			let victim: string | undefined
			let oldestDigital: string | undefined
			for (const [k, e] of this.entries) {
				if (k === key) continue
				if (e.tier === "nosync") {
					victim = k
					break
				}
				oldestDigital ??= k
			}
			victim ??= oldestDigital
			if (victim === undefined) break
			this.entries.delete(victim)
		}
	}

	/** Records a checked sync; true when the channel was not held before (a pass is due). */
	noteSync(key: string, now: number): boolean {
		if (!Number.isFinite(now)) return false
		const wasHeld = this.held(key, now)
		this.set(
			key,
			{
				tier: "digital",
				untilMonoMs: now + DSD_DIGITAL_MEMORY_MS,
				failures: 0,
				lastSyncMonoMs: now,
				notedMonoMs: null,
				forgetMonoMs: now + DSD_DIGITAL_MEMORY_MS,
			},
			now,
		)
		return !wasHeld
	}

	/** Records a failed sync of one run; a digital entry is unchanged. */
	noteFailure(key: string, now: number, policy: ActivityPolicy): void {
		if (!Number.isFinite(now)) return
		const old = this.live(key, now)
		if (old?.tier === "digital") return
		const failures = (old?.failures ?? 0) + 1
		const until = now + dsdNoSyncCooldownAfter(failures, policy)
		this.set(
			key,
			{
				tier: "nosync",
				untilMonoMs: until,
				failures,
				lastSyncMonoMs: null,
				notedMonoMs: now,
				forgetMonoMs: until + DSD_NOSYNC_FORGET_MS,
			},
			now,
		)
		this.noteTry(key, now)
	}

	/**
	 * A failed run that is still running: its cooldown and try time count
	 * from now (the try lasts the whole run), failures unchanged. Without it
	 * a long no-sync run would outlive its entry and retake a slot at once.
	 */
	renewFailure(key: string, now: number, policy: ActivityPolicy): void {
		if (!Number.isFinite(now)) return
		const e = this.live(key, now)
		if (e?.tier !== "nosync") return
		const until = Math.max(
			e.untilMonoMs,
			now + dsdNoSyncCooldownAfter(e.failures, policy),
		)
		this.set(
			key,
			{ ...e, untilMonoMs: until, forgetMonoMs: until + DSD_NOSYNC_FORGET_MS },
			now,
		)
		this.noteTry(key, now)
	}

	/**
	 * Writes a channel's try time (newest last). Past DSD_MAX_TIERS = 256 the
	 * oldest try goes, so at most 256 remain whichever write adds the key:
	 * a renewal can re-add a key whose try was trimmed while its entry lived.
	 */
	private noteTry(key: string, now: number): void {
		this.tries.delete(key)
		this.tries.set(key, now)
		while (this.tries.size > DSD_MAX_TIERS) {
			const oldest = this.tries.keys().next()
			if (oldest.done) break
			this.tries.delete(oldest.value)
		}
	}

	/** Whether the channel is digital with a sync within the 30 min hold. */
	held(key: string, now: number): boolean {
		const e = this.live(key, now)
		return (
			e?.tier === "digital" &&
			e.lastSyncMonoMs !== null &&
			now - e.lastSyncMonoMs < DSD_DIGITAL_HOLD_MS
		)
	}

	/** The last checked sync on a digital channel, null for none. */
	lastSync(key: string): number | null {
		const e = this.entries.get(key)
		return e?.tier === "digital" ? e.lastSyncMonoMs : null
	}

	/** Records an analog-to-analog try move of a slot group. */
	noteAnalogRetry(groupKey: string, now: number): void {
		if (!Number.isFinite(now)) return
		this.retries.delete(groupKey)
		this.retries.set(groupKey, now)
		while (this.retries.size > DSD_MAX_RETRY_GROUPS) {
			const oldest = this.retries.keys().next()
			if (oldest.done) break
			this.retries.delete(oldest.value)
		}
	}

	/** Drops every entry of a source removed for good. */
	dropSource(sourceId: string): void {
		const ofSource = (key: string) => {
			try {
				const parsed: unknown = JSON.parse(key)
				return Array.isArray(parsed) && parsed[1] === sourceId
			} catch {
				return false
			}
		}
		for (const key of [...this.entries.keys()])
			if (ofSource(key)) this.entries.delete(key)
		for (const key of [...this.retries.keys()])
			if (ofSource(key)) this.retries.delete(key)
		for (const key of [...this.tries.keys()])
			if (ofSource(key)) this.tries.delete(key)
	}

	private live(key: string, now: number): TierEntry | undefined {
		const e = this.entries.get(key)
		if (e && now >= e.forgetMonoMs) {
			this.entries.delete(key)
			return undefined
		}
		return e
	}

	/** Live entries (expired ones are swept) and the analog try time of each group. */
	snapshot(
		now: number,
		policy: ActivityPolicy,
	): {
		tiers: DsdTierView[]
		analogRetries: { groupKey: string; atMonoMs: number }[]
		tries: { key: string; atMonoMs: number }[]
	} {
		const tiers: DsdTierView[] = []
		for (const [key, e] of this.entries) {
			if (now >= e.forgetMonoMs) {
				this.entries.delete(key)
				continue
			}
			tiers.push({
				key,
				tier: e.tier,
				untilMonoMs: e.untilMonoMs,
				failures: e.failures,
				...(e.lastSyncMonoMs !== null
					? { lastSyncMonoMs: e.lastSyncMonoMs }
					: {}),
				...(e.notedMonoMs !== null ? { notedMonoMs: e.notedMonoMs } : {}),
			})
		}
		const gap = dsdNoSyncCooldownAfter(DSD_ANALOG_TRY_FAILURES, policy)
		const analogRetries: { groupKey: string; atMonoMs: number }[] = []
		for (const [groupKey, atMonoMs] of this.retries) {
			if (now - atMonoMs >= gap) this.retries.delete(groupKey)
			else analogRetries.push({ groupKey, atMonoMs })
		}
		const tries: { key: string; atMonoMs: number }[] = []
		for (const [key, atMonoMs] of this.tries) {
			if (now - atMonoMs >= DSD_TRY_MEMORY_MS) this.tries.delete(key)
			else tries.push({ key, atMonoMs })
		}
		return { tiers, analogRetries, tries }
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
 * amateur 2 m / 70 cm) and inside no range listing ISM or LoRa (in the EU the
 * 433 MHz and 863-870 MHz ISM/SRD bands, where LoRa and telemetry bursts would
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
