// The mock core's link advisory (README "Link advisories"): one entry for the mock receiver in every
// `resources:snapshot` and in GET /api/resources, kept by the core's episode rule (episodeSince from the first
// `dropping`, kept until the advisory has been non-dropping for 60 s). Scenarios drive it through
// POST /__mock/link-advisory; it starts with nothing to report (no entry at all).
import type { ResourceLinkAdvisory, ResourceSnapshot } from "@wavekit/api-types"
import { z } from "zod"

/** Non-dropping time after which the core ends an episode (ms). */
export const EPISODE_END_MS = 60_000

export const linkControlSchema = z
	.object({
		/** The advisory's level, or `absent` to drop the entry from the snapshot. */
		level: z.enum(["none", "unproven", "dropping", "absent"]).optional(),
		lossReason: z
			.enum(["source", "core-busy", "unknown", "branch-congestion"])
			.optional(),
		/** End the episode now, as if 60 s had passed without dropping (refused while dropping). */
		endEpisode: z.literal(true).optional(),
	})
	.strict()
export type LinkControl = z.infer<typeof linkControlSchema>

export interface LinkAdvisoryMock {
	/** Applies a scenario step; returns the entry now (null when absent) or an error text. */
	control(c: LinkControl): { entry: ResourceLinkAdvisory | null } | string
	/** The entries for a snapshot taken now. */
	entries(): ResourceLinkAdvisory[]
	/** A resources snapshot the core's shape (no container or host figures on the mock). */
	snapshot(): ResourceSnapshot
}

export function createLinkAdvisoryMock(
	sourceId: string,
	now: () => number = Date.now,
): LinkAdvisoryMock {
	let present = false
	let level: ResourceLinkAdvisory["level"] = "none"
	let lossReason: ResourceLinkAdvisory["lossReason"]
	let since = now()
	let episodeSince: number | null = null
	/** When the advisory last stopped dropping (the 60 s episode tail runs from here). */
	let calmSince: number | null = null

	const expire = () => {
		if (
			episodeSince !== null &&
			level !== "dropping" &&
			calmSince !== null &&
			now() - calmSince >= EPISODE_END_MS
		)
			episodeSince = null
	}

	const entry = (): ResourceLinkAdvisory | null => {
		expire()
		if (!present) return null
		return {
			sourceId,
			level,
			...(lossReason !== undefined ? { lossReason } : {}),
			since: new Date(since).toISOString(),
			...(episodeSince !== null
				? { episodeSince: new Date(episodeSince).toISOString() }
				: {}),
		}
	}

	const entries = () => {
		const e = entry()
		return e ? [e] : []
	}

	return {
		control(c) {
			expire()
			if (c.level === "absent") {
				present = false
				level = "none"
				lossReason = undefined
				episodeSince = null
				calmSince = null
			} else if (c.level !== undefined) {
				const reason =
					c.level === "dropping"
						? (c.lossReason ?? "source")
						: c.lossReason === "branch-congestion"
							? c.lossReason
							: undefined
				if (!present || c.level !== level || reason !== lossReason)
					since = now()
				const wasDropping = present && level === "dropping"
				present = true
				level = c.level
				lossReason = reason
				if (level === "dropping") {
					episodeSince ??= now()
					calmSince = null
				} else if (wasDropping) calmSince = now()
			}
			if (c.endEpisode) {
				if (level === "dropping") return "endEpisode while dropping"
				episodeSince = null
			}
			return { entry: entry() }
		},
		entries,
		snapshot: () => ({
			timestamp: new Date(now()).toISOString(),
			container: {
				available: false,
				cpuUsagePercent: null,
				cpuThrottledPercent: null,
				memoryUsageBytes: null,
				memoryLimitBytes: null,
				memoryUsagePercent: null,
				oomKillCount: null,
				cgroupVersion: "unknown",
			},
			sdrHosts: [],
			sourceBackpressure: [],
			linkAdvisories: entries(),
		}),
	}
}
