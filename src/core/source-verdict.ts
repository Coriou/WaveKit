/**
 * What a source's state means, in one closed code (GET /api/sources `verdict`). The core says what
 * it sees itself; a claim about the receiver (`receiver-no-device`, `receiver-not-running`) needs
 * a fresh answer from its status API with a boolean fact, and samples flowing outrank any such
 * claim. Messages are fixed text: no value from the receiver reaches them.
 */
import type {
	SdrHostStatus,
	SourceDeviceFacts,
	SourceVerdict,
	SourceVerdictCode,
} from "@wavekit/api-types"
import type { SourceStatus } from "./source-manager.js"

/**
 * Receiver facts older than this assert nothing. One poll cycle takes at most 7 s (the default 3 s
 * interval plus the 2 s timeouts of its status and host requests), so 15 s covers two cycles and
 * a third just starting. A failed poll clears the facts at once; this bound catches a poller that
 * stopped or a longer configured interval, which then reads `stale` (safe, no device claim).
 */
export const SOURCE_FACTS_MAX_AGE_MS = 15_000

/** Facts at or under the bound, from a time that is not in the future. */
function freshAt(lastFetchedAt: string | null, now: number): boolean {
	if (lastFetchedAt === null) return false
	const at = Date.parse(lastFetchedAt)
	return Number.isFinite(at) && at <= now && now - at <= SOURCE_FACTS_MAX_AGE_MS
}

function deviceFactsOf(
	host: SdrHostStatus | undefined,
	now: number,
): SourceDeviceFacts {
	if (host === undefined) return "none"
	if (host.available !== true) return "unreachable"
	if (!freshAt(host.lastFetchedAt, now)) return "stale"
	const found = host.receiverFacts?.deviceFound
	if (found === true) return "present"
	if (found === false) return "absent"
	return "malformed"
}

/** The sentence for a no-samples source, by what the receiver can say about its device. */
const NO_SAMPLES_TEXT: Readonly<Record<SourceDeviceFacts, string>> = {
	present: "connected with no IQ; the receiver reports a device",
	// Only when rtl_tcp runs: absent and running disagree, so neither is claimed.
	absent: "connected with no IQ; the receiver's device state is inconsistent",
	malformed: "connected with no IQ; the receiver did not state a device state",
	stale:
		"connected with no IQ; the receiver's facts are stale, so its device state is unknown",
	unreachable:
		"connected with no IQ; the receiver's status API does not answer, so its device state is unknown",
	none: "connected with no IQ",
}

const TEXT: Readonly<Record<Exclude<SourceVerdictCode, "no-samples">, string>> =
	{
		ok: "samples are flowing",
		waiting: "connected; waiting for the first samples",
		"receiver-no-device": "receiver has no device; re-attach USB",
		"receiver-not-running":
			"receiver reports a device but its rtl_tcp is not running",
		backpressure: "the core is not keeping up with this source",
		disconnected: "not connected to the receiver",
		"feed-paused": "the receiver feed is paused",
		"feed-error": "resuming the receiver feed failed; resume again to retry",
		ended: "the recording has ended",
	}

/** One source's verdict. `host`: its poller status, undefined when none polls this source. */
export function sourceVerdict(
	status: Pick<SourceStatus, "activity" | "feed">,
	host: SdrHostStatus | undefined,
	now: number,
): SourceVerdict {
	const deviceFacts = deviceFactsOf(host, now)
	const done = (code: Exclude<SourceVerdictCode, "no-samples">) => ({
		code,
		message: TEXT[code],
		deviceFacts,
	})
	const activity = status.activity.state
	if (activity === "ended") return done("ended")
	const feed = status.feed?.state
	if (feed === "paused" || feed === "resuming") return done("feed-paused")
	if (feed === "error") return done("feed-error")
	if (activity === "streaming") return done("ok")
	if (activity === "paused") return done("backpressure")
	// A fresh, well-formed answer decides; `running` true with no device is a contradiction.
	const running = host?.receiverFacts?.rtlTcpRunning
	if (deviceFacts === "absent" && running !== true)
		return done("receiver-no-device")
	if (deviceFacts === "present" && running === false)
		return done("receiver-not-running")
	if (activity === "disconnected") return done("disconnected")
	if (activity === "waiting") return done("waiting")
	return {
		code: "no-samples",
		message: NO_SAMPLES_TEXT[deviceFacts],
		deviceFacts,
	}
}
