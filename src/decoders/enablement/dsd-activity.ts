import { z } from "zod"
import { ACTIVITY_MAX_CANDIDATES } from "./activity-contract.js"
import { ACTIVITY_MOVE_WINDOW_MS } from "./activity-plan.js"
import type { ActivityPolicy } from "./activity-plan.js"

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

/** Parser link events are sync evidence, including unverified hints (not identity proof). */
const SyncSchema = z.object({
	protocol: z.enum(["dmr", "p25", "nxdn", "ysf", "dpmr", "dstar"]),
	at: z.number().finite(),
	crcErr: z.boolean(),
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
