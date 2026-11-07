/**
 * The identify answer in one closed code, derived from a final target and nothing else. An agent
 * or a voice assistant repeats it, so it never claims more than the trials showed: anything not
 * recognised, and any plausible trial that did not run, is `could-not-test`.
 */
import {
	SCANNER_TRIAL_OUTCOMES,
	type ScannerIdentifyEventData,
	type ScannerIdentifyTrial,
	type ScannerIdentifyVerdict,
	type ScannerIdentifyVerdictWhy,
	type ScannerProtocol,
	type ScannerTrialOutcome,
} from "@wavekit/api-types"

/** Why the job stopped before its target finished, when something stopped it. */
export type IdentifyStopCause = "source-lost" | "cancelled"

export interface IdentifyVerdictInput {
	state: ScannerIdentifyEventData["state"]
	trials: readonly ScannerIdentifyTrial[]
	result: ScannerIdentifyEventData["result"]
	/** The request's explicit protocols; empty: every plausible one. */
	requested: readonly ScannerProtocol[]
	/** A protocol a live trial heard without confirming it (a sync, or one checked decode). */
	heard: ScannerProtocol | null
	stopped: IdentifyStopCause | null
}

const KNOWN_OUTCOMES: ReadonlySet<ScannerTrialOutcome> = new Set(
	SCANNER_TRIAL_OUTCOMES,
)

/** Decoders that listen for themselves: their `timeout` means output without a confirmed identity. */
const PROBE_TRANSPORTS: ReadonlySet<ScannerIdentifyTrial["transport"]> =
	new Set(["offset", "channel", "replay"])

const REASON_WHY: Readonly<
	Record<NonNullable<ScannerIdentifyTrial["reason"]>, ScannerIdentifyVerdictWhy>
> = {
	"no-decoder": "unsupported-protocol",
	"needs-channelizer": "unsupported-protocol",
	"no-ambient-decoder": "unsupported-protocol",
	"adsb-window": "unsupported-protocol",
	"unsupported-format": "unsupported-format",
	"decoder-unavailable": "decoders-unavailable",
	"no-live-audio": "no-live-audio",
}

/** The most useful single reason when several trials could not run. */
const WHY_ORDER: readonly ScannerIdentifyVerdictWhy[] = [
	"decoders-unavailable",
	"budget",
	"interrupted",
	"unsupported-format",
	"no-live-audio",
	"unsupported-protocol",
	"unknown",
]

const ANALOG: ReadonlySet<ScannerProtocol> = new Set(["analog-fm", "analog-am"])

/** Why this trial did not test its protocol, or null when it did or need not. */
function untestedWhy(
	t: ScannerIdentifyTrial,
): ScannerIdentifyVerdictWhy | null {
	switch (t.outcome) {
		// Reached only without a confirmed identity (a tone on an untrusted frequency): claims nothing either way.
		case "decoded":
			return "unknown"
		case "heard":
		case "no-sync":
		case "crc-errors":
		case "timeout":
		case "data-like":
		case "carrier-only":
		case "not-needed":
			return null
		case "skipped-budget":
			return "budget"
		case "cancelled":
			return "interrupted"
		case "unsupported":
			return (t.reason && REASON_WHY[t.reason]) ?? "unknown"
		case "pending":
		case "running":
			return "unknown"
	}
}

function couldNotTest(
	why: ScannerIdentifyVerdictWhy,
	requested: readonly ScannerProtocol[],
): ScannerIdentifyVerdict {
	const protocol = requested.length === 1 ? requested[0] : undefined
	return {
		code: "could-not-test",
		why,
		...(protocol !== undefined ? { protocol } : {}),
	}
}

function mapVerdict(v: IdentifyVerdictInput): ScannerIdentifyVerdict {
	const { result: r, requested } = v
	const sole = requested.length === 1 ? requested[0] : undefined
	const withSole = <T extends ScannerIdentifyVerdict>(x: T): T =>
		sole !== undefined ? { ...x, protocol: sole } : x
	if (
		!r ||
		!["identified", "candidate", "unidentified"].includes(v.state) ||
		!v.trials.every(t => KNOWN_OUTCOMES.has(t.outcome))
	)
		return couldNotTest("unknown", requested)
	if (r.artefact) return couldNotTest("artefact", requested)
	// A confirmed identity: an accepted decode, a decode anchor, or a standard tone on a trusted frequency.
	const tone =
		r.analog !== undefined &&
		(r.analog.ctcssHz !== null || r.analog.dcs !== null)
	if (
		v.state === "identified" &&
		r.protocol !== undefined &&
		(r.identity !== undefined || r.alreadyDecoded !== undefined || tone)
	)
		return { code: "decoded", protocol: r.protocol }
	// An identity capped below decoded, a lone sync, or one checked decode. Never `decoded`.
	const capped =
		r.identity !== undefined &&
		r.protocol !== undefined &&
		!ANALOG.has(r.protocol)
			? r.protocol
			: undefined
	const lone = v.trials.find(
		t => t.outcome === "timeout" && PROBE_TRANSPORTS.has(t.transport),
	)
	const heard = capped ?? v.heard ?? lone?.protocol
	if (heard !== undefined)
		return { code: "heard-digital-unconfirmed", protocol: heard }
	if (v.stopped) return couldNotTest(v.stopped, requested)
	if (r.ended === "window-moved") return couldNotTest("window-moved", requested)
	if (r.ended === "no-signal") return withSole({ code: "nothing" })
	if (r.decodersUnavailable && r.decodersUnavailable.length > 0)
		return couldNotTest("decoders-unavailable", requested)
	// A plan exists only for a resolved track, so an empty one on the spectrum measurement saw no signal.
	if (v.trials.length === 0)
		return r.measurements.source === "spectrum"
			? withSole({ code: "nothing" })
			: couldNotTest("unsupported-protocol", requested)
	// An explicit request is answered for what it named. Otherwise every plausible trial counts, except the analog
	// trials that have no probe decoder at all: they say nothing about a digital signal.
	const inScope = v.trials.filter(t =>
		requested.length > 0
			? requested.includes(t.protocol)
			: !(t.outcome === "unsupported" && ANALOG.has(t.protocol)),
	)
	if (requested.some(p => !v.trials.some(t => t.protocol === p)))
		return couldNotTest("unknown", requested)
	const whys = new Set(
		inScope.map(untestedWhy).filter(x => x !== null),
	) as ReadonlySet<ScannerIdentifyVerdictWhy>
	const why = WHY_ORDER.find(x => whys.has(x))
	if (why !== undefined) return couldNotTest(why, requested)
	if (inScope.some(t => t.outcome !== "not-needed"))
		return withSole({ code: "undecodable" })
	return couldNotTest("unknown", requested)
}

/** Never throws: a failure while mapping is the safe answer. */
export function identifyTargetVerdict(
	v: IdentifyVerdictInput,
): ScannerIdentifyVerdict {
	try {
		return mapVerdict(v)
	} catch {
		return { code: "could-not-test", why: "unknown" }
	}
}
