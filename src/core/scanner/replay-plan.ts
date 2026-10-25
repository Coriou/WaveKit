/**
 * WG11 req 6.4 / 1.7 and WG12 req 4.4, 4.6, 5.5, 5.6 (pure): the replay trials of one IQ
 * capture. The discovery's known protocol first (`known: true`). When that protocol is
 * analog-fm or analog-am and its prior is not 0, it is the one analog trial (nfm or am) with
 * `known: true`; a missing prior still plans it, an explicit 0 does not. Otherwise one analog
 * trial when an analog prior above 0 selects one (a prior of 0 excludes that protocol; a missing
 * prior does not count). Never a second analog trial. Then the digital probe modes
 * `identifyScores` gives the captured track (bandplan priors, narrow raster per req 1.3),
 * deduplicated by mode key, at most IQ_REPLAY_MAX_TRIALS with the analog trial counted. Without
 * a track: the known protocol (the analog trial, when that protocol is analog), else the probe
 * modes of the protocols the capture's priors name above 0.
 * The analog protocol is `analog-am` when a shipped band plan at `capture.rfHz` lists it and its
 * prior is above 0, else `analog-fm` when its prior is above 0, else `analog-am` when its prior
 * is above 0, else none. Modulation follows the protocol (`am` or `nfm`). Never a protocol whose
 * prior is 0. `replayModeOf` keeps analog out of probe modes. Never `rtl433`, never an
 * ambient-only protocol as a probe.
 *
 * (a) the decoders a discovery's class and band call for beyond the probe modes
 * (`REPLAY_EXTRA_TRIALS`: rtl433 for ISM, acarsdec for ACARS, dumpvdl2 for VDL2, readsb at
 * 1090 MHz, ais-catcher for AIS, the LoRa decoder) are planned only behind a capability check: a
 * trial runs only when its decoder has a probe mode and a replay input path
 * (`REPLAY_INPUT_DECODERS`); otherwise it is reported in `skipped` and never run. (b) The
 * discovery's trial memory reorders the candidates before the dedup and the bound
 * (`orderTrialsByMemory`): remembered success, prior order, untried, failures with backoff.
 */
import { SCANNER_AMBIENT_PROTOCOLS } from "@wavekit/api-types"
import { bandplansFor } from "./bandplan/index.js"
import type { BandRegionCode } from "./bandplan/index.js"
import {
	IDENTIFY_ANALOG_PROTOCOLS,
	IDENTIFY_PROTOCOLS,
	identifyModeFor,
	identifyScores,
} from "./identify.js"
import { classOf, familyOf, inPagerRange } from "./classify/classifier.js"
import { orderTrialsByMemory } from "./trial-memory.js"
import {
	IQ_REPLAY_MAX_TRIALS,
	REPLAY_INPUT_DECODERS,
	type IqReplayPlanInput,
	type IqReplayPlanner,
	type IqReplayTrial,
} from "./iq-capture-contract.js"
import { probeModesFor, type ProbeMode } from "./probes/probe-pool.js"
import type { AnalogTrialMode } from "./scanner-redesign-contract.js"
import type { ScannerProtocol } from "./types.js"

/**
 * Every shipped region. The frozen plan input carries no region (Main will be told);
 * the lookup therefore searches every shipped plan.
 */
const BAND_REGIONS = [
	"EU",
	"US",
	"CA",
	"AU",
	"NZ",
	"JP",
	"CN",
] as const satisfies readonly BandRegionCode[]

function modeKey(mode: ProbeMode): string {
	return `${mode.decoderType}:${JSON.stringify(mode.options)}`
}

/** The replayable probe mode of a protocol, or null (no decoder, rtl433, ambient-only, analog, unknown). */
function replayModeOf(protocol: ScannerProtocol): ProbeMode | null {
	if (
		!IDENTIFY_PROTOCOLS.includes(protocol) ||
		SCANNER_AMBIENT_PROTOCOLS.includes(protocol) ||
		IDENTIFY_ANALOG_PROTOCOLS.includes(protocol)
	)
		return null
	const mode = identifyModeFor(protocol)
	if (!mode || mode.decoderType === "rtl433") return null
	return mode
}

function finitePrior(
	priors: Partial<Record<ScannerProtocol, number>>,
	protocol: ScannerProtocol,
): number | undefined {
	const value = priors[protocol]
	return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/** Prior above 0. An explicit 0 excludes the protocol; a missing prior is not above 0. */
function priorAboveZero(
	priors: Partial<Record<ScannerProtocol, number>>,
	protocol: ScannerProtocol,
): boolean {
	const value = finitePrior(priors, protocol)
	return value !== undefined && value > 0
}

/**
 * One analog trial, or none. `analog-am` when the band lists AM and its prior is above 0;
 * else `analog-fm` when its prior is above 0; else `analog-am` when its prior is above 0.
 * Never a protocol whose prior is 0.
 */
function chooseAnalogTrial(input: IqReplayPlanInput): IqReplayTrial | null {
	const am = priorAboveZero(input.priors, "analog-am")
	const fm = priorAboveZero(input.priors, "analog-fm")
	if (bandplanListsAm(input.capture.rfHz) && am) return analogTrial("am")
	if (fm) return analogTrial("nfm")
	if (am) return analogTrial("am")
	return null
}

/** True when any shipped band plan range covering `hz` lists `analog-am`. */
function bandplanListsAm(hz: number): boolean {
	if (!Number.isFinite(hz)) return false
	for (const region of BAND_REGIONS) {
		for (const plan of bandplansFor(region)) {
			for (const range of plan.ranges) {
				if (hz < range.startHz || hz > range.endHz) continue
				if (range.protocols?.includes("analog-am")) return true
			}
		}
	}
	return false
}

function analogTrial(
	analogMode: AnalogTrialMode,
	known = false,
): IqReplayTrial {
	const protocol = analogMode === "am" ? "analog-am" : "analog-fm"
	const mode: ProbeMode = {
		decoderType: "dsd-fme",
		protocol,
		covers: [protocol],
		options: { analogTrial: analogMode },
		holdMs: 0,
	}
	return {
		protocol,
		mode,
		known,
		kind: "analog",
		analogMode,
	}
}

/**
 * Dedup by mode key (first wins) and the IQ_REPLAY_MAX_TRIALS bound, in candidate order. Exported for the
 * bound test: the built-in probe modes give fewer distinct keys than the bound. The analog trial counts.
 */
export function boundReplayTrials(
	candidates: readonly IqReplayTrial[],
): IqReplayTrial[] {
	const out: IqReplayTrial[] = []
	const keys = new Set<string>()
	for (const c of candidates) {
		if (out.length >= IQ_REPLAY_MAX_TRIALS) break
		const key = modeKey(c.mode)
		if (keys.has(key)) continue
		keys.add(key)
		out.push(c)
	}
	return out
}

/** A trial the plan wanted but could not run (no probe mode or no replay input for its decoder). */
export interface SkippedReplayTrial {
	protocol: ScannerProtocol | "adsb"
	decoder: string
	reason: "no-probe-mode" | "no-replay-input"
}

/** 1090 MHz Mode S/ADS-B: the channel ±1 MHz (1 089 000 000 to 1 091 000 000 Hz inclusive). */
export const ADSB_REPLAY_LOW_HZ = 1_089_000_000
export const ADSB_REPLAY_HIGH_HZ = 1_091_000_000

/**
 * The decoders the class and band call for beyond the probe-mode table. `protocol` null = called
 * by frequency only (readsb at 1090 MHz has no scanner protocol).
 */
export const REPLAY_EXTRA_TRIALS: readonly {
	protocol: ScannerProtocol | "adsb"
	decoder: string
}[] = [
	{ protocol: "ism", decoder: "rtl433" },
	{ protocol: "acars", decoder: "acarsdec" },
	{ protocol: "vdl2", decoder: "dumpvdl2" },
	{ protocol: "ais", decoder: "ais-catcher" },
	{ protocol: "lora", decoder: "lora-meshtastic" },
	{ protocol: "adsb", decoder: "readsb" },
]

/** True when the band plan lists the protocol at the capture (prior at least 1). */
function listed(
	priors: Partial<Record<ScannerProtocol, number>>,
	protocol: ScannerProtocol,
): boolean {
	const value = finitePrior(priors, protocol)
	return value !== undefined && value >= 1
}

/** Whether the discovery's class, band or known protocol calls for this extra trial. */
function extraCalled(
	input: IqReplayPlanInput,
	protocol: ScannerProtocol | "adsb",
): boolean {
	if (protocol === "adsb") {
		const hz = input.capture.rfHz
		return (
			Number.isFinite(hz) &&
			hz >= ADSB_REPLAY_LOW_HZ &&
			hz <= ADSB_REPLAY_HIGH_HZ
		)
	}
	if (input.priors[protocol] === 0) return false
	if (input.knownProtocol === protocol) return true
	if (listed(input.priors, protocol)) return true
	return (
		protocol === "ism" &&
		input.track !== null &&
		classOf(input.track) === "ook-burst"
	)
}

/** The extra trial's probe mode when the decoder has one; null otherwise. */
function extraModeOf(
	protocol: ScannerProtocol | "adsb",
	decoder: string,
): ProbeMode | null {
	if (protocol === "adsb" || !IDENTIFY_PROTOCOLS.includes(protocol)) return null
	// ISM has no identify mode (identifyModeFor answers null); its probe mode is the ook-burst one.
	const mode =
		protocol === "ism"
			? (probeModesFor("ook-burst", ["ism"]).find(
					m => m.decoderType === decoder,
				) ?? null)
			: identifyModeFor(protocol)
	return mode && mode.decoderType === decoder ? mode : null
}

/**
 * The plan and the trials it skipped. `replayInput` is the capability set (default: the decoders
 * with a replay input path); a decoder outside it is never planned.
 */
export function planReplayTrialsDetailed(
	input: IqReplayPlanInput,
	replayInput: ReadonlySet<string> = REPLAY_INPUT_DECODERS,
): { trials: IqReplayTrial[]; skipped: SkippedReplayTrial[] } {
	const candidates: IqReplayTrial[] = []
	const skipped: SkippedReplayTrial[] = []
	const add = (protocol: ScannerProtocol, known: boolean): void => {
		const mode = replayModeOf(protocol)
		if (mode && replayInput.has(mode.decoderType))
			candidates.push({ protocol, mode, known })
	}
	// A prior of 0 removes a protocol (requirement 1.3), the known one included.
	// A known analog protocol is the one analog trial, placed first.
	let knownAnalog = false
	if (input.knownProtocol !== null && input.priors[input.knownProtocol] !== 0) {
		const knownProtocol = input.knownProtocol
		if (knownProtocol === "analog-am" || knownProtocol === "analog-fm") {
			candidates.push(
				analogTrial(knownProtocol === "analog-am" ? "am" : "nfm", true),
			)
			knownAnalog = true
		} else add(knownProtocol, true)
	}
	if (!knownAnalog) {
		const analog = chooseAnalogTrial(input)
		if (analog) candidates.push(analog)
	}
	if (input.track) {
		for (const h of identifyScores(input.track, {
			priors: input.priors,
			protocols: [],
			narrow: input.narrowRaster === true,
		}))
			add(h.protocol, false)
	} else if (input.knownProtocol === null) {
		const named = (
			Object.entries(input.priors) as [ScannerProtocol, number | undefined][]
		)
			.filter(([, prior]) => typeof prior === "number" && prior > 0)
			.sort(([a, pa], [b, pb]) => (pb ?? 0) - (pa ?? 0) || a.localeCompare(b))
		for (const [protocol] of named) add(protocol, false)
	}
	for (const extra of REPLAY_EXTRA_TRIALS) {
		if (!extraCalled(input, extra.protocol)) continue
		const mode = extraModeOf(extra.protocol, extra.decoder)
		if (mode === null) {
			skipped.push({ ...extra, reason: "no-probe-mode" })
			continue
		}
		if (!replayInput.has(mode.decoderType)) {
			skipped.push({ ...extra, reason: "no-replay-input" })
			continue
		}
		candidates.push({
			protocol: extra.protocol as ScannerProtocol,
			mode,
			known: input.knownProtocol === extra.protocol,
		})
	}
	// In a paging range the pager trials run right after the known trial, ahead of the (not
	// known) analog trial: an analog `heard` ends the later digital trials `not-needed`, which
	// would skip POCSAG/FLEX. Order: known, pager trials, analog, the rest (each stable).
	if (inPagerRange(input.priors)) {
		const rank = (c: IqReplayTrial): number =>
			c.known
				? 0
				: c.kind !== "analog" && familyOf(c.protocol) === "pager"
					? 1
					: c.kind === "analog"
						? 2
						: 3
		const ranked = candidates.map((c, i) => ({ c, i, r: rank(c) }))
		ranked.sort((x, y) => x.r - y.r || x.i - y.i)
		candidates.splice(0, candidates.length, ...ranked.map(x => x.c))
	}
	// One decoder run per mode key (the dedup below): the memory of any protocol planned on the
	// same run applies to every candidate of that run, so a backoff cannot be dodged by a sibling.
	const runCovers = new Map<string, Set<string>>()
	for (const c of candidates) {
		const k = modeKey(c.mode)
		const set = runCovers.get(k) ?? new Set<string>()
		set.add(c.protocol)
		for (const p of c.mode.covers) set.add(p)
		runCovers.set(k, set)
	}
	const ordered = orderTrialsByMemory(
		candidates.map(trial => ({
			trial,
			protocol: trial.protocol,
			decoder:
				trial.kind === "analog" ? "analog-demod" : trial.mode.decoderType,
			known: trial.known,
			covers: [...(runCovers.get(modeKey(trial.mode)) ?? [])],
		})),
		input.trialMemory,
		input.nowMs ?? input.capture.capturedAtMs,
	).map(x => x.trial)
	return { trials: boundReplayTrials(ordered), skipped }
}

export function planReplayTrials(input: IqReplayPlanInput): IqReplayTrial[] {
	return planReplayTrialsDetailed(input).trials
}

/** Type check: the planner satisfies the frozen contract's port. */
export const replayPlanner: IqReplayPlanner = planReplayTrials
