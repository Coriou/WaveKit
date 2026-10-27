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
 * (`REPLAY_INPUT_DECODERS`: rtl433 reads the 48 kHz cf32 capture with `RTL433_REPLAY_MODE`); otherwise
 * it is reported in `skipped` and never run. (b) The
 * discovery's trial memory reorders the candidates before the dedup and the bound
 * (`orderTrialsByMemory`): remembered success, prior order, untried, failures with backoff.
 */
import { SCANNER_AMBIENT_PROTOCOLS } from "@wavekit/api-types"
import { builtinBandplansFor } from "../bandplans/builtin-supplement.js"
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
	IQ_CAPTURE_MAX_MS,
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
		for (const plan of builtinBandplansFor(region)) {
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

/**
 * The rtl433 replay trial: every built-in rtl_433 protocol on the capture as captured. Its hold
 * bounds a run that never exits: the longest capture (IQ_CAPTURE_MAX_MS, 4 s) read in real time;
 * rtl_433 reads a 4 s 48 kHz cf32 file (1.5 MB) far faster.
 */
const RTL433_REPLAY_COVERS: ScannerProtocol[] = ["ism"]
export const RTL433_REPLAY_MODE: Readonly<ProbeMode> = Object.freeze({
	decoderType: "rtl433",
	protocol: "ism",
	covers: RTL433_REPLAY_COVERS,
	options: {},
	holdMs: IQ_CAPTURE_MAX_MS,
})

/**
 * The ACARS replay trial: acarsdec on the capture's 25 kHz channel (AM). One CRC-clean block of
 * the replay is its decode (`interpretAcarsReplay`). Hold: the longest capture, 4 s.
 */
const ACARS_REPLAY_COVERS: ScannerProtocol[] = ["acars"]
export const ACARS_REPLAY_MODE: Readonly<ProbeMode> = Object.freeze({
	decoderType: "acarsdec",
	protocol: "acars",
	covers: ACARS_REPLAY_COVERS,
	options: {},
	holdMs: IQ_CAPTURE_MAX_MS,
})

/** The extra trial's probe mode when the decoder has one; null otherwise. */
function extraModeOf(
	protocol: ScannerProtocol | "adsb",
	decoder: string,
): ProbeMode | null {
	if (protocol === "adsb" || !IDENTIFY_PROTOCOLS.includes(protocol)) return null
	// ISM has no identify mode (identifyModeFor answers null) and no pre-channelizer probe mode
	// (ambient-only live); its replay mode is rtl433 on the capture.
	const mode =
		protocol === "ism"
			? (probeModesFor("ook-burst", ["ism"]).find(
					m => m.decoderType === decoder,
				) ??
				(decoder === RTL433_REPLAY_MODE.decoderType
					? {
							...RTL433_REPLAY_MODE,
							covers: [...RTL433_REPLAY_MODE.covers],
							options: {},
						}
					: null))
			: protocol === "acars" && decoder === ACARS_REPLAY_MODE.decoderType
				? {
						...ACARS_REPLAY_MODE,
						covers: [...ACARS_REPLAY_MODE.covers],
						options: {},
					}
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
	// DQ 1.4e: a capture whose track turned edge is never replayed; with no trial the queue
	// settles it and the capture is discarded.
	if (input.track?.flags.edge === true) return { trials: [], skipped: [] }
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
		const known = input.knownProtocol === extra.protocol
		const trial = { protocol: extra.protocol as ScannerProtocol, mode, known }
		// The known protocol's trial leads, as a known probe-mode trial does (no other trial is
		// known then: an extra's protocol has no probe mode of its own).
		if (known) candidates.unshift(trial)
		else candidates.push(trial)
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
	const nowMs = input.nowMs ?? input.capture.capturedAtMs
	const byMemory = (
		group: readonly IqReplayTrial[],
		opts: { keepBackoff?: boolean; allowEmpty?: boolean } = {},
	): IqReplayTrial[] =>
		orderTrialsByMemory(
			group.map(trial => ({
				trial,
				protocol: trial.protocol,
				decoder:
					trial.kind === "analog" ? "analog-demod" : trial.mode.decoderType,
				known: trial.known,
				covers: [...(runCovers.get(modeKey(trial.mode)) ?? [])],
			})),
			input.trialMemory,
			nowMs,
			opts,
		).map(x => x.trial)
	let ordered: IqReplayTrial[]
	if (inPagerRange(input.priors)) {
		// In a paging range the groups are fixed: the known digital and pager trials, then the
		// analog trial (known or not), then the rest. An analog `decoded`/`heard` ends the later
		// trials `not-needed`, so the pager trials always run before it, whatever the memory says.
		// Memory reorders only inside a group (a remembered POCSAG success runs before a known
		// DMR); the first group is never cut for backoff.
		const group = (c: IqReplayTrial): number =>
			c.kind === "analog"
				? 1
				: c.known || familyOf(c.protocol) === "pager"
					? 0
					: 2
		const of = (g: number): IqReplayTrial[] =>
			candidates.filter(c => group(c) === g)
		const groups = [
			byMemory(of(0), { keepBackoff: true }),
			byMemory(of(1), { allowEmpty: true }),
			byMemory(of(2), { allowEmpty: true }),
		]
		ordered = groups.flat()
		if (ordered.length === 0) ordered = byMemory(candidates)
	} else ordered = byMemory(candidates)
	// The replay queue runs `known` trials first (it partitions them): only a leading run of
	// known trials keeps the flag, so the queue executes exactly this order. A known trial the
	// memory or the paging groups moved behind another trial is planned as an ordinary one.
	let leading = true
	ordered = ordered.map(t => {
		if (!t.known) {
			leading = false
			return t
		}
		// identity kept apart from the queue flag: its misses still count (requirement 1.8)
		return leading ? t : { ...t, known: false, knownProtocol: true }
	})
	return { trials: boundReplayTrials(ordered), skipped }
}

export function planReplayTrials(input: IqReplayPlanInput): IqReplayTrial[] {
	return planReplayTrialsDetailed(input).trials
}

/** Type check: the planner satisfies the frozen contract's port. */
export const replayPlanner: IqReplayPlanner = planReplayTrials

/** Replay-only mode descriptors. The probe pool must admit these decoder types and
 * interpret their CRC-clean output before it can consume these descriptors. */
export const IQ_REPLAY_WIDEBAND_MODES = Object.freeze({
	vdl2: {
		decoderType: "dumpvdl2",
		protocol: "vdl2",
		covers: ["vdl2"],
		options: {},
		holdMs: IQ_CAPTURE_MAX_MS,
	},
	lora: {
		decoderType: "lora-meshtastic",
		protocol: "lora",
		covers: ["lora"],
		// 125 kHz × 2 samples/chip = 250 kHz; 250 kHz presets do not fit 192 kHz captures.
		options: { preset: "LongModerate", bandwidth: 125_000, oversampling: 2 },
		holdMs: IQ_CAPTURE_MAX_MS,
	},
} satisfies Record<
	"vdl2" | "lora",
	Omit<ProbeMode, "decoderType"> & {
		decoderType: "dumpvdl2" | "lora-meshtastic"
	}
>)
