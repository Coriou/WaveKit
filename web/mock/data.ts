/**
 * Mock data for the web app, taken from the canvas boards (docs/web/canvas): the signals of
 * Spectrum.dc.html (SIG), the shared band plan (wk-bandplan v1), the detected names of
 * Immersive.dc.html and the card details of Tuned.dc.html. Frequencies in Hz.
 *
 * Runs under `node --experimental-strip-types`: type-only imports, no enums.
 */
import type {
	ActivityCategory,
	Band,
	Bandplan,
	BandChannel,
	BandProvenance,
	DecoderInfo,
	DiscoveryMetadata,
	DisplayGroup,
	Identity,
	JsonValue,
	LiveAudioConfig,
	PlanProvenance,
	ResolvedBand,
	ResolvedBandPlanView,
	SavedFrequencyInput,
	ScannerClass,
	ScannerConfidence,
	ScannerProtocol,
} from "@wavekit/api-types"

export const MOCK_SOURCE_ID = "rtl-0"
/** The opt-in second receiver (WAVEKIT_MOCK_SECOND_SOURCE=1): listed with its tuner and feed, nothing else. */
export const MOCK_SECOND_SOURCE_ID = "rtl-1"
/** Tuned.dc.html: the receiver sits at 161.500 MHz, 2.4 MS/s. */
export const DEFAULT_CENTER_HZ = 161_500_000
export const SAMPLE_RATE_HZ = 2_400_000
/** Core band check: capture half width times the usable fraction 0.8. */
export const USABLE_FRACTION = 0.8
export const NOISE_FLOOR_DBFS = -110

// --- Signals ---

export type SignalKind =
	| "wfm"
	| "am"
	| "burst"
	| "voice"
	| "steady"
	| "tdma"
	| "ais"
	| "pulse"

export interface MockSignal {
	hz: number
	bwHz: number
	/** Peak level in dBFS. */
	powerDbfs: number
	kind: SignalKind
	/** Keyed for `on` seconds every `per` seconds, offset by `ph`; always on without `per`. */
	on?: number
	per?: number
	ph?: number
	/** Immersive.dc.html DETECTED name, for the 18 signal types the boards name. */
	name?: string
	/** Tuned.dc.html card line (protocol detail). */
	sub?: string
	modulation: LiveAudioConfig["modulation"]
}

/** Canvas `p` is a display level; the mock floor is −110 dBFS, so peaks sit 8 dB lower. */
const P = (p: number) => p - 8

function sig(
	mhz: number,
	bwHz: number,
	p: number,
	kind: SignalKind,
	more: Partial<MockSignal> = {},
): MockSignal {
	const modulation: LiveAudioConfig["modulation"] =
		kind === "wfm" ? "wfm" : kind === "am" ? "am" : "nfm"
	return {
		hz: Math.round(mhz * 1e6),
		bwHz,
		powerDbfs: P(p),
		kind,
		modulation,
		...more,
	}
}

export const MOCK_SIGNALS: readonly MockSignal[] = [
	// FM broadcast
	sig(88.6, 180e3, -60, "wfm"),
	sig(93.5, 180e3, -50, "wfm", {
		name: "FM broadcast",
		sub: "Broadcast · stereo pilot",
	}),
	sig(96.2, 180e3, -63, "wfm"),
	sig(99.8, 180e3, -54, "wfm"),
	sig(104.3, 180e3, -61, "wfm"),
	// Airband voice and ATIS
	sig(118.1, 6e3, -66, "am", {
		on: 4,
		per: 14,
		ph: 2,
		name: "Airband tower",
		sub: "AM · 8.33 kHz",
	}),
	sig(119.7, 6e3, -74, "am", { on: 3, per: 19, ph: 6 }),
	sig(124.55, 6e3, -78, "am", { on: 5, per: 23, ph: 11 }),
	sig(127.3, 6e3, -80, "am"),
	// ACARS and VDL2
	sig(131.525, 5e3, -77, "burst", { on: 0.35, per: 13, ph: 4 }),
	sig(131.725, 5e3, -64, "burst", {
		on: 0.4,
		per: 6,
		ph: 1,
		name: "ACARS",
		sub: "VHF · 2400 baud",
	}),
	sig(131.825, 5e3, -79, "burst", { on: 0.3, per: 17, ph: 9 }),
	sig(136.725, 16e3, -78, "burst", { on: 0.25, per: 9, ph: 3 }),
	sig(136.775, 16e3, -75, "burst", { on: 0.25, per: 11, ph: 7 }),
	sig(136.875, 16e3, -73, "burst", { on: 0.25, per: 7, ph: 2 }),
	sig(136.975, 16e3, -66, "burst", {
		on: 0.3,
		per: 4,
		ph: 0,
		name: "VDL2",
		sub: "Mode 2 · CPDLC",
	}),
	// 2 m amateur
	sig(144.8, 12e3, -63, "burst", {
		on: 0.7,
		per: 9,
		ph: 1,
		name: "APRS",
		sub: "AX.25 · 1200 baud",
	}),
	sig(145.5, 11e3, -72, "voice", { on: 3, per: 40, ph: 12 }),
	sig(145.6375, 11e3, -68, "voice", {
		on: 6,
		per: 30,
		ph: 18,
		sub: "NFM · CTCSS 123.0 Hz",
	}),
	// Marine VHF, paging, land mobile
	sig(156.6, 11e3, -71, "voice", { on: 3, per: 12, ph: 7 }),
	sig(156.8, 11e3, -62, "voice", {
		on: 4,
		per: 15,
		ph: 3,
		name: "Marine ch 16",
		sub: "NFM · distress and calling",
	}),
	sig(160.45, 12.5e3, -60, "burst", {
		on: 1.4,
		per: 7,
		ph: 0.5,
		name: "POCSAG pager",
		sub: "1200 baud",
	}),
	sig(160.625, 11e3, -65, "voice", {
		on: 5,
		per: 11,
		ph: 2,
		name: "NFM voice",
		sub: "Analog voice · CTCSS 88.5 Hz",
	}),
	sig(160.9, 2.5e3, -84, "steady"),
	sig(161.15, 9e3, -57, "tdma", {
		on: 9,
		per: 13,
		ph: 0,
		name: "DMR · TG 2081",
		sub: "Tier II · slot 1 · CC 1",
	}),
	sig(161.425, 11e3, -76, "voice", {
		on: 3,
		per: 9,
		ph: 5,
		sub: "Analog voice · DCS 023N",
	}),
	sig(161.975, 20e3, -61, "ais", {
		on: 0.12,
		per: 0.6,
		ph: 0,
		name: "AIS channel A",
		sub: "Channel A · GMSK 9600",
	}),
	sig(162.025, 20e3, -63, "ais", {
		on: 0.12,
		per: 0.7,
		ph: 0.3,
		name: "AIS channel B",
		sub: "Channel B · GMSK 9600",
	}),
	sig(162.4, 14e3, -70, "steady"),
	sig(163.0875, 11e3, -66, "voice", {
		on: 5,
		per: 17,
		ph: 4,
		name: "P25 · TG 1201",
		sub: "Phase 1 · NAC 293",
	}),
	// UHF
	sig(433.075, 11e3, -79, "voice", { on: 2, per: 25, ph: 8 }),
	sig(433.92, 60e3, -58, "burst", {
		on: 0.3,
		per: 5,
		ph: 2,
		name: "ISM sensors",
		sub: "rtl_433 · 3 devices",
	}),
	// band inspection UX: a bookmarked cluster of short bursts within 5 kHz (band-fixtures.ts "bookmark")
	sig(434.7015, 1.5e3, -64, "burst", { on: 0.4, per: 3, ph: 0 }),
	sig(434.7035, 1.5e3, -61, "burst", { on: 0.5, per: 4, ph: 1 }),
	sig(434.7055, 1.5e3, -66, "burst", { on: 0.3, per: 2, ph: 0.5 }),
	sig(434.7075, 1.5e3, -63, "burst", { on: 0.6, per: 5, ph: 2 }),
	sig(434.7095, 1.5e3, -68, "burst", { on: 0.4, per: 3.5, ph: 1.5 }),
	sig(446.00625, 11e3, -60, "voice", {
		on: 6,
		per: 20,
		ph: 0,
		name: "PMR446 ch 1",
		sub: "Channel 1 · CTCSS 77.0 Hz",
	}),
	sig(446.03125, 11e3, -71, "voice", { on: 4, per: 27, ph: 9 }),
	sig(446.09375, 11e3, -77, "voice", { on: 2, per: 33, ph: 15 }),
	// DMR on a frequency no decoder follows (Ben's 446.926, 2026-10-18): Identify names it, on its own while listening
	sig(446.925, 9e3, -58, "tdma", { on: 5, per: 9, ph: 2 }),
	sig(466.025, 12.5e3, -62, "burst", { on: 1.2, per: 10, ph: 3 }),
	// SRD 868
	sig(868.1, 125e3, -80, "burst", { on: 0.2, per: 8, ph: 5 }),
	sig(868.3, 50e3, -70, "burst", {
		on: 0.15,
		per: 6,
		ph: 1,
		name: "ISM 868 sensors",
		sub: "rtl_433 · 2 devices",
	}),
	sig(868.95, 60e3, -72, "burst", {
		on: 0.1,
		per: 9,
		ph: 4,
		name: "wM-Bus meters",
		sub: "Mode T1 · rtl_433",
	}),
	sig(869.525, 250e3, -75, "burst", {
		on: 0.4,
		per: 11,
		ph: 3,
		name: "Meshtastic",
		sub: "LoRa · LongFast",
	}),
	// ADS-B / Mode S (decoded on its own dongle)
	sig(1090, 2e6, -62, "pulse", { name: "ADS-B", sub: "Mode S · 1090 MHz" }),
]

/** True when the signal is keyed at time `tSec` (seconds, any epoch). */
export function signalActive(signal: MockSignal, tSec: number): boolean {
	if (signal.per === undefined || signal.on === undefined) return true
	const phase =
		(((tSec + (signal.ph ?? 0)) % signal.per) + signal.per) % signal.per
	return phase < signal.on
}

/** The signal whose occupied band contains `hz` (half the bandwidth plus 1 kHz), nearest first. */
export function signalAt(hz: number): MockSignal | null {
	let best: MockSignal | null = null
	let bestDistance = Infinity
	for (const signal of MOCK_SIGNALS) {
		const distance = Math.abs(signal.hz - hz)
		if (distance <= signal.bwHz / 2 + 1000 && distance < bestDistance) {
			best = signal
			bestDistance = distance
		}
	}
	return best
}

// --- Identify plans (Tuned.dc.html PLANS / planFor) ---

export interface IdentifyPlan {
	state: "identified" | "candidate" | "unidentified"
	class: ScannerClass
	protocol?: ScannerProtocol
	/** Trials in order, each with its final outcome. */
	trials: {
		protocol: ScannerProtocol
		decoder: "dsd-fme" | "multimon-ng" | "direwolf" | "rtl433" | null
		mode: string | null
		outcome: "decoded" | "no-sync" | "crc-errors" | "timeout" | "unsupported"
	}[]
	identity?: {
		kind: "dmr-cc" | "p25-nac" | "pocsag-capcode" | "aprs-call" | "ism-model"
		value: string
	}
	metadata?: {
		talkgroups?: string[]
		sources?: string[]
		slots?: number[]
		callsigns?: string[]
		capcodes?: string[]
		ismModels?: string[]
		ctcssHz?: number
	}
}

const DIGITAL_NO_SYNC: IdentifyPlan["trials"] = [
	{ protocol: "dmr", decoder: "dsd-fme", mode: "auto", outcome: "no-sync" },
	{ protocol: "p25p1", decoder: "dsd-fme", mode: "auto", outcome: "no-sync" },
	{
		protocol: "nxdn48",
		decoder: "dsd-fme",
		mode: "nxdn48",
		outcome: "no-sync",
	},
]

export const IDENTIFY_PLANS: Readonly<Record<number, IdentifyPlan>> = {
	161150000: {
		state: "identified",
		class: "tdma-ms",
		protocol: "dmr",
		trials: [
			{
				protocol: "pocsag",
				decoder: "multimon-ng",
				mode: "multimon-ng",
				outcome: "no-sync",
			},
			{
				protocol: "p25p1",
				decoder: "dsd-fme",
				mode: "auto",
				outcome: "crc-errors",
			},
			{ protocol: "dmr", decoder: "dsd-fme", mode: "auto", outcome: "decoded" },
		],
		identity: { kind: "dmr-cc", value: "1" },
		metadata: { talkgroups: ["2081", "9"], sources: ["2081045"], slots: [1] },
	},
	163087500: {
		state: "identified",
		class: "fsk4-12k5",
		protocol: "p25p1",
		trials: [
			{ protocol: "dmr", decoder: "dsd-fme", mode: "auto", outcome: "no-sync" },
			{
				protocol: "p25p1",
				decoder: "dsd-fme",
				mode: "auto",
				outcome: "decoded",
			},
		],
		identity: { kind: "p25-nac", value: "293" },
		metadata: { talkgroups: ["1201"], sources: ["4410022"] },
	},
	446925000: {
		state: "identified",
		class: "tdma-ms",
		protocol: "dmr",
		trials: [
			{ protocol: "dmr", decoder: "dsd-fme", mode: "auto", outcome: "decoded" },
		],
		identity: { kind: "dmr-cc", value: "0" },
	},
	160450000: {
		state: "identified",
		class: "fsk2-wide",
		protocol: "pocsag",
		trials: [
			{
				protocol: "pocsag",
				decoder: "multimon-ng",
				mode: "multimon-ng",
				outcome: "decoded",
			},
		],
		identity: { kind: "pocsag-capcode", value: "1234567" },
		metadata: { capcodes: ["1234567", "1234570"] },
	},
	144800000: {
		state: "identified",
		class: "afsk-fm",
		protocol: "aprs",
		trials: [
			{
				protocol: "aprs",
				decoder: "direwolf",
				mode: "direwolf",
				outcome: "decoded",
			},
		],
		identity: { kind: "aprs-call", value: "F4ABC-9" },
		metadata: { callsigns: ["F4ABC-9", "F6XYZ-13"] },
	},
	433920000: {
		state: "identified",
		class: "ook-burst",
		protocol: "ism",
		trials: [
			{
				protocol: "ism",
				decoder: "rtl433",
				mode: "rtl433",
				outcome: "decoded",
			},
		],
		identity: { kind: "ism-model", value: "Acurite-Tower" },
		metadata: { ismModels: ["Acurite-Tower", "Toyota", "Generic-Remote"] },
	},
	868300000: {
		state: "identified",
		class: "fsk2-wide",
		protocol: "ism",
		trials: [
			{
				protocol: "ism",
				decoder: "rtl433",
				mode: "rtl433",
				outcome: "decoded",
			},
		],
		identity: { kind: "ism-model", value: "LaCrosse-TX29IT" },
		metadata: { ismModels: ["LaCrosse-TX29IT", "Fineoffset-WH51"] },
	},
	868950000: {
		state: "identified",
		class: "fsk2-wide",
		protocol: "ism",
		trials: [
			{
				protocol: "ism",
				decoder: "rtl433",
				mode: "rtl433",
				outcome: "decoded",
			},
		],
		identity: { kind: "ism-model", value: "Wireless-MBus" },
		metadata: { ismModels: ["Wireless-MBus"] },
	},
	466025000: {
		state: "candidate",
		class: "fsk2-wide",
		protocol: "flex",
		trials: [
			{
				protocol: "pocsag",
				decoder: "multimon-ng",
				mode: "multimon-ng",
				outcome: "no-sync",
			},
			{ protocol: "dmr", decoder: "dsd-fme", mode: "auto", outcome: "no-sync" },
			{
				protocol: "p25p1",
				decoder: "dsd-fme",
				mode: "auto",
				outcome: "timeout",
			},
			{
				protocol: "nxdn48",
				decoder: "dsd-fme",
				mode: "nxdn48",
				outcome: "no-sync",
			},
		],
	},
	162400000: {
		state: "unidentified",
		class: "carrier",
		protocol: "carrier",
		trials: DIGITAL_NO_SYNC,
	},
	160900000: {
		state: "unidentified",
		class: "carrier",
		protocol: "carrier",
		trials: DIGITAL_NO_SYNC,
	},
}

const CTCSS: Readonly<Record<number, number>> = {
	160625000: 88.5,
	446006250: 77.0,
	145637500: 123.0,
}

/**
 * A plan cut to the protocols asked for ("Decode as…"): only their trials run, and an answer for another protocol is
 * not given (the core drops protocols the signal's class cannot carry, so nothing may be tried at all).
 */
export function onlyProtocols(
	plan: IdentifyPlan,
	protocols: readonly ScannerProtocol[],
): IdentifyPlan {
	if (protocols.length === 0) return plan
	const trials = plan.trials.filter(t => protocols.includes(t.protocol))
	if (plan.protocol !== undefined && protocols.includes(plan.protocol))
		return { ...plan, trials }
	return { state: "unidentified", class: plan.class, trials }
}

/** The plan for a target: a known one, a generic one by kind, or unidentified off-signal. */
export function identifyPlanFor(signal: MockSignal | null): IdentifyPlan {
	if (!signal) return { state: "unidentified", class: "unknown", trials: [] }
	const known = IDENTIFY_PLANS[signal.hz]
	if (known) return known
	const ctcssHz = CTCSS[signal.hz]
	switch (signal.kind) {
		case "voice":
			return {
				state: "candidate",
				class: "analog-fm",
				protocol: "analog-fm",
				trials: DIGITAL_NO_SYNC,
				...(ctcssHz !== undefined ? { metadata: { ctcssHz } } : {}),
			}
		case "am":
			return {
				state: "candidate",
				class: "analog-fm",
				protocol: "analog-am",
				trials: [],
			}
		case "wfm":
		case "pulse":
			return { state: "candidate", class: "wideband", trials: [] }
		case "ais":
		case "tdma":
			return {
				state: "candidate",
				class: "gmsk-narrow",
				protocol: "digital-unknown",
				trials: DIGITAL_NO_SYNC,
			}
		case "burst":
			return {
				state: "candidate",
				class: "fsk2-wide",
				protocol: "digital-unknown",
				trials: DIGITAL_NO_SYNC,
			}
		case "steady":
			return {
				state: "unidentified",
				class: "carrier",
				protocol: "carrier",
				trials: DIGITAL_NO_SYNC,
			}
	}
}

// --- Decoders ---

interface DecoderSeed {
	id: string
	type: string
	targetsHz: number[]
	input: "audio_pcm" | "iq" | "external"
	output: "jsonl" | "nmea" | "beast" | "text"
	pattern: "pure_consumer" | "network_producer" | "external_sdr"
	basis: "configured" | "protocol" | "decoder-default"
	version: string
	deviceSerial?: string
}

export const DECODER_SEEDS: readonly DecoderSeed[] = [
	{
		id: "dsd-fme",
		type: "dsd-fme",
		targetsHz: [161150000, 163087500],
		input: "audio_pcm",
		output: "jsonl",
		pattern: "pure_consumer",
		basis: "configured",
		version: "1.0.0",
	},
	{
		id: "ais-catcher",
		type: "ais-catcher",
		targetsHz: [161975000, 162025000],
		input: "iq",
		output: "jsonl",
		pattern: "pure_consumer",
		basis: "protocol",
		version: "0.61",
	},
	{
		id: "multimon-ng",
		type: "multimon-ng",
		targetsHz: [160450000, 466025000],
		input: "audio_pcm",
		output: "text",
		pattern: "pure_consumer",
		basis: "configured",
		version: "1.3.1",
	},
	{
		id: "direwolf",
		type: "direwolf",
		targetsHz: [144800000],
		input: "audio_pcm",
		output: "text",
		pattern: "pure_consumer",
		basis: "decoder-default",
		version: "1.7",
	},
	{
		id: "rtl433-433",
		type: "rtl433",
		targetsHz: [433920000],
		input: "iq",
		output: "jsonl",
		pattern: "pure_consumer",
		basis: "decoder-default",
		version: "23.11",
	},
	{
		id: "rtl433-868",
		type: "rtl433",
		targetsHz: [868300000, 868950000],
		input: "iq",
		output: "jsonl",
		pattern: "pure_consumer",
		basis: "configured",
		version: "23.11",
	},
	{
		id: "acarsdec",
		type: "acarsdec",
		targetsHz: [131525000, 131725000, 131825000],
		input: "iq",
		output: "jsonl",
		pattern: "pure_consumer",
		basis: "configured",
		version: "3.7",
	},
	{
		id: "dumpvdl2",
		type: "dumpvdl2",
		targetsHz: [136725000, 136775000, 136875000, 136975000],
		input: "iq",
		output: "jsonl",
		pattern: "pure_consumer",
		basis: "configured",
		version: "2.3.0",
	},
	{
		id: "meshtastic",
		type: "lora-meshtastic",
		targetsHz: [869525000],
		input: "iq",
		output: "jsonl",
		pattern: "pure_consumer",
		basis: "decoder-default",
		version: "0.4.0",
	},
	{
		id: "readsb",
		type: "readsb",
		targetsHz: [1090000000],
		input: "external",
		output: "beast",
		pattern: "external_sdr",
		basis: "protocol",
		version: "3.14",
		deviceSerial: "00001090",
	},
]

/** True when the decoder can hear one of its targets with the receiver at `centerHz`. */
export function decoderInBand(seed: DecoderSeed, centerHz: number): boolean {
	if (seed.input === "external") return true
	const half = (SAMPLE_RATE_HZ / 2) * USABLE_FRACTION
	return seed.targetsHz.some(hz => Math.abs(hz - centerHz) <= half)
}

/** GET /api/decoders items with the band check against `centerHz`. */
export function buildDecoders(
	centerHz: number,
	startedAt: number,
	now: number,
	stats: ReadonlyMap<string, number>,
	suspendedSince: ReadonlyMap<string, string>,
): DecoderInfo[] {
	const half = (SAMPLE_RATE_HZ / 2) * USABLE_FRACTION
	return DECODER_SEEDS.map((seed, index) => {
		const external = seed.input === "external"
		const inBand = decoderInBand(seed, centerHz)
		const events = stats.get(seed.id) ?? 0
		const since =
			suspendedSince.get(seed.id) ?? new Date(startedAt).toISOString()
		const info: DecoderInfo = {
			id: seed.id,
			type: seed.type,
			running: inBand,
			health: "running",
			uptime: inBand ? Math.round((now - startedAt) / 1000) : 0,
			stats: { bytesIn: events * 4096, eventsOut: events, errors: 0 },
			lastOutputAt: events > 0 ? new Date(now - 2000).toISOString() : null,
			restartCount: 0,
			version: seed.version,
			targetFrequenciesHz: seed.targetsHz,
			desiredRunning: true,
			suspended: !inBand,
			startMode: "auto",
			owner: "config",
			idleTimeoutMs: 300_000,
			rateHistory: Array.from({ length: 15 }, (_, i) =>
				inBand ? (index * 3 + i * 7) % 11 : 0,
			),
			caps: {
				input: seed.input,
				output: seed.output,
				integrationPattern: seed.pattern,
			},
			rateAssessment: external
				? { verdict: "unknown", reasonCode: "external-input" }
				: {
						verdict: "best",
						sourceKind: "iq",
						sourceRateHz: SAMPLE_RATE_HZ,
						adaptation: "integer-decimation",
					},
			bandAssessment: external
				? {
						verdict: "unknown",
						reasonCode: "external-input",
						targetsHz: seed.targetsHz,
					}
				: {
						verdict: inBand ? "in-band" : "out-of-band",
						...(inBand ? {} : { reasonCode: "frequency-out-of-band" as const }),
						targetsHz: seed.targetsHz,
						basis: seed.basis,
						captureCenterHz: centerHz,
						windowHalfWidthHz: half,
					},
		}
		if (inBand) info.pid = 4100 + index
		if (external) {
			if (seed.deviceSerial !== undefined) info.deviceSerial = seed.deviceSerial
		} else info.sourceId = MOCK_SOURCE_ID
		if (!inBand)
			info.suspension = { reasonCode: "frequency-out-of-band", since }
		return info
	})
}

// --- Band plan (wk-bandplan v1) ---

export interface BandSeed {
	id: string
	name: string
	group: DisplayGroup
	a: number
	b: number
	mode: Band["mode"]
	step: number | null
	bw: number | null
	from: "operator" | "builtin-fr" | "builtin-eu"
	ver: boolean
	parent?: string
	skip?: string
	hidden?: boolean
	channels?: {
		id: string
		name: string
		mhz: number
		aliases?: string[]
		renamed?: boolean
	}[]
}

const pmrChannels = Array.from({ length: 16 }, (_, i) => ({
	id: `ch-${i + 1}`,
	name: `PMR446 ch ${i + 1}`,
	mhz: Number((446.00625 + i * 0.0125).toFixed(5)),
	aliases: [`pmr ${i + 1}`, `pmr${i + 1}`],
}))

export const BAND_SEEDS: readonly BandSeed[] = [
	{
		id: "cb",
		name: "CB 27 MHz",
		group: "personal-radio",
		a: 26.965,
		b: 27.405,
		mode: "am",
		step: 10000,
		bw: 10000,
		from: "builtin-fr",
		ver: false,
		channels: [
			{ id: "ch-9", name: "CB ch 9", mhz: 27.065 },
			{
				id: "ch-19",
				name: "CB ch 19",
				mhz: 27.185,
				aliases: ["routiers"],
				renamed: true,
			},
		],
	},
	{
		id: "fm",
		name: "FM broadcast",
		group: "broadcast",
		a: 87.5,
		b: 108,
		mode: "wfm",
		step: 100000,
		bw: 180000,
		from: "builtin-fr",
		ver: true,
		skip: "Broadcast",
	},
	{
		id: "air",
		name: "Airband",
		group: "air",
		a: 118,
		b: 137,
		mode: "am",
		step: 8330,
		bw: 8330,
		from: "builtin-eu",
		ver: true,
		channels: [
			{ id: "guard", name: "Guard 121.5", mhz: 121.5, aliases: ["guard"] },
			{ id: "acars-131525", name: "ACARS 131.525", mhz: 131.525 },
			{ id: "acars-eu", name: "ACARS Europe", mhz: 131.725 },
			{ id: "vdl2-136975", name: "VDL2 136.975", mhz: 136.975 },
		],
	},
	{
		id: "wxsat",
		name: "Weather satellites",
		group: "other",
		a: 137,
		b: 138,
		mode: "wfm",
		step: 5000,
		bw: 40000,
		from: "builtin-eu",
		ver: true,
		skip: "Passes only",
	},
	{
		id: "amateur-2m",
		name: "2 m amateur",
		group: "amateur",
		a: 144,
		b: 146,
		mode: "nfm",
		step: 12500,
		bw: 12500,
		from: "builtin-eu",
		ver: true,
		channels: [
			{ id: "aprs", name: "APRS Europe", mhz: 144.8, aliases: ["aprs"] },
		],
	},
	{
		id: "lmv",
		name: "Land mobile VHF",
		group: "land-mobile",
		a: 146,
		b: 174,
		mode: "nfm",
		step: 12500,
		bw: 12500,
		from: "builtin-fr",
		ver: false,
	},
	{
		id: "marine",
		name: "Marine VHF",
		group: "marine",
		parent: "lmv",
		a: 156,
		b: 162.025,
		mode: "nfm",
		step: 25000,
		bw: 12500,
		from: "builtin-fr",
		ver: true,
		channels: [
			{ id: "ch-16", name: "Marine ch 16", mhz: 156.8 },
			{ id: "ch-12", name: "Marine ch 12", mhz: 156.6 },
			{ id: "ch-70", name: "Marine ch 70", mhz: 156.525 },
			{ id: "ais-a", name: "AIS A", mhz: 161.975 },
			{ id: "ais-b", name: "AIS B", mhz: 162.025 },
		],
	},
	{
		id: "harbour",
		name: "Harbour channels",
		group: "marine",
		a: 156.5,
		b: 157.45,
		mode: "nfm",
		step: 25000,
		bw: 12500,
		from: "operator",
		ver: false,
	},
	{
		id: "wize",
		name: "Wize meters 169",
		group: "ism-srd",
		parent: "lmv",
		a: 169.4,
		b: 169.475,
		mode: "nfm",
		step: 12500,
		bw: 12500,
		from: "builtin-fr",
		ver: false,
	},
	{
		id: "pg169",
		name: "Pagers 169",
		group: "pagers",
		parent: "lmv",
		a: 169.475,
		b: 169.8,
		mode: "nfm",
		step: 12500,
		bw: 12500,
		from: "builtin-fr",
		ver: false,
	},
	{
		id: "dab",
		name: "DAB+",
		group: "broadcast",
		a: 174,
		b: 230,
		mode: "raw",
		step: 1712000,
		bw: 1536000,
		from: "builtin-fr",
		ver: false,
		skip: "Broadcast",
		hidden: true,
	},
	{
		id: "inpt",
		name: "INPT (Tetrapol)",
		group: "land-mobile",
		a: 380,
		b: 400,
		mode: "nfm",
		step: 12500,
		bw: 12500,
		from: "builtin-fr",
		ver: false,
		skip: "Encrypted public safety",
	},
	{
		id: "lmu",
		name: "Land mobile UHF",
		group: "land-mobile",
		a: 400,
		b: 470,
		mode: "nfm",
		step: 12500,
		bw: 12500,
		from: "builtin-fr",
		ver: false,
	},
	{
		id: "amateur-70cm",
		name: "70 cm amateur",
		group: "amateur",
		a: 430,
		b: 440,
		mode: "nfm",
		step: 12500,
		bw: 12500,
		from: "builtin-eu",
		ver: true,
	},
	{
		id: "ism433",
		name: "ISM 433 · LPD433",
		group: "ism-srd",
		parent: "lmu",
		a: 433.05,
		b: 434.79,
		mode: "nfm",
		step: 25000,
		bw: 25000,
		from: "builtin-fr",
		ver: true,
		channels: [
			{ id: "ism-43392", name: "ISM 433.92", mhz: 433.92, aliases: ["433"] },
		],
	},
	{
		id: "pmr446",
		name: "PMR446",
		group: "personal-radio",
		parent: "lmu",
		a: 446.0,
		b: 446.2,
		mode: "nfm",
		step: 12500,
		bw: 12500,
		from: "builtin-fr",
		ver: true,
		channels: pmrChannels,
	},
	{
		id: "pg466",
		name: "Pagers 466 (e*Message)",
		group: "pagers",
		parent: "lmu",
		a: 466.025,
		b: 466.23,
		mode: "nfm",
		step: 12500,
		bw: 12500,
		from: "builtin-fr",
		ver: false,
	},
	{
		id: "srd868",
		name: "SRD 868",
		group: "ism-srd",
		a: 863,
		b: 870,
		mode: "nfm",
		step: 25000,
		bw: 25000,
		from: "builtin-eu",
		ver: true,
		channels: [
			{ id: "ism-8683", name: "ISM 868.3", mhz: 868.3 },
			{ id: "wmbus", name: "wM-Bus 868.95", mhz: 868.95 },
			{
				id: "meshtastic-eu",
				name: "Meshtastic EU",
				mhz: 869.525,
				aliases: ["mesh", "lora"],
			},
		],
	},
	{
		id: "adsb",
		name: "ADS-B 1090",
		group: "air",
		a: 1089,
		b: 1091,
		mode: "raw",
		step: null,
		bw: 2000000,
		from: "builtin-eu",
		ver: true,
		skip: "Decoded elsewhere",
	},
]

const PACKS: readonly {
	id: BandSeed["from"]
	layer: number
	provenance: PlanProvenance
}[] = [
	{ id: "operator", layer: 0, provenance: { kind: "operator" } },
	{ id: "builtin-fr", layer: 1, provenance: { kind: "builtin" } },
	{ id: "builtin-eu", layer: 2, provenance: { kind: "builtin" } },
]

const CITATIONS = {
	"builtin-fr": [{ title: "ANFR TNRBF", url: "https://www.anfr.fr/" }],
	"builtin-eu": [
		{
			title: "ERC Report 25",
			url: "https://docdb.cept.org/document/category/ERC_Reports",
		},
	],
} as const

export function toBand(seed: BandSeed): Band {
	const channels: BandChannel[] = (seed.channels ?? []).map(c => ({
		id: c.id,
		name: c.name,
		frequencyHz: Math.round(c.mhz * 1e6),
		aliases: c.aliases ?? [],
		registryRef: null,
	}))
	const provenance: BandProvenance =
		seed.from === "operator"
			? { kind: "operator" }
			: seed.ver
				? { kind: "builtin-cited", citations: CITATIONS[seed.from] }
				: { kind: "builtin" }
	return {
		id: seed.id,
		name: seed.name,
		startHz: Math.round(seed.a * 1e6),
		endHz: Math.round(seed.b * 1e6),
		group: seed.group,
		mode: seed.mode,
		bandwidthHz: seed.bw,
		stepHz: seed.step,
		skip: seed.skip !== undefined ? { reason: seed.skip } : null,
		channels,
		parentId: seed.parent ?? null,
		colourHint: null,
		registryRef: null,
		scan: null,
		provenance,
	}
}

export interface Interval {
	startHz: number
	endHz: number
}

export function merge(intervals: readonly Interval[]): Interval[] {
	const sorted = [...intervals].sort(
		(a, b) => a.startHz - b.startHz || a.endHz - b.endHz,
	)
	const out: Interval[] = []
	for (const iv of sorted) {
		const last = out[out.length - 1]
		if (last && iv.startHz <= last.endHz + 1)
			last.endHz = Math.max(last.endHz, iv.endHz)
		else out.push({ ...iv })
	}
	return out
}

export function subtract(
	startHz: number,
	endHz: number,
	cover: readonly Interval[],
): Interval[] {
	const segments: Interval[] = []
	let cursor = startHz
	for (const iv of cover) {
		if (iv.endHz < cursor) continue
		if (iv.startHz > endHz) break
		if (iv.startHz > cursor)
			segments.push({ startHz: cursor, endHz: iv.startHz - 1 })
		cursor = Math.max(cursor, iv.endHz + 1)
		if (cursor > endHz) break
	}
	if (cursor <= endHz) segments.push({ startHz: cursor, endHz })
	return segments
}

/** GET /api/bandplans/resolved, resolved the way src/core/bandplans/resolve.ts does. */
export function buildResolvedBandPlan(): ResolvedBandPlanView {
	let cover: Interval[] = []
	const bands: ResolvedBand[] = []
	const shadowed: string[] = []
	const hidden: string[] = []
	for (const pack of PACKS) {
		const visible: Interval[] = []
		for (const seed of BAND_SEEDS.filter(s => s.from === pack.id)) {
			const key = `${pack.id}/${seed.id}`
			if (seed.hidden) {
				hidden.push(key)
				continue
			}
			const band = toBand(seed)
			const segments = subtract(band.startHz, band.endHz, cover)
			if (segments.length === 0) shadowed.push(key)
			else
				bands.push({
					key,
					packId: pack.id,
					bandId: seed.id,
					layer: pack.layer,
					band,
					segments,
					editedFields: seed.channels?.some(c => c.renamed) ? ["channels"] : [],
					issues: [],
					provenance: band.provenance,
					packProvenance: pack.provenance,
				})
			visible.push({ startHz: band.startHz, endHz: band.endHz })
		}
		cover = merge([...cover, ...visible])
	}
	bands.sort((a, b) => {
		const d = (a.segments[0]?.startHz ?? 0) - (b.segments[0]?.startHz ?? 0)
		if (d !== 0) return d
		if (a.layer !== b.layer) return a.layer - b.layer
		return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
	})
	shadowed.sort()
	hidden.sort()
	return {
		store: { state: "available", storeId: null, revision: 0 },
		context: { region: "EU", effectiveCountry: "FR" },
		bands,
		shadowed,
		hidden,
	}
}

// --- Decoded messages (Tuned.dc.html INFO and recent lines) ---

export interface MockMessage {
	decoderId: string
	decoderType: string
	hz: number
	outputType: string
	protocol: string
	category: ActivityCategory
	entityKey: string | null
	title: string
	fields: {
		key: string
		label: string
		value: string | number | boolean
		unit?: string
	}[]
	position?: { lat: number; lon: number; altM?: number }
	data: { readonly [key: string]: JsonValue }
}

export const MOCK_MESSAGES: readonly MockMessage[] = [
	{
		decoderId: "dsd-fme",
		decoderType: "dsd-fme",
		hz: 161150000,
		outputType: "call_end",
		protocol: "dmr",
		category: "voice",
		entityKey: "talkgroup:2081",
		title: "TG 2081 · radio 2081045",
		fields: [
			{ key: "talkgroup", label: "Talkgroup", value: "2081" },
			{ key: "source", label: "Radio", value: "2081045" },
			{ key: "slot", label: "Slot", value: 1 },
			{ key: "duration", label: "Duration", value: 12, unit: "s" },
		],
		data: {
			protocol: "DMR",
			talkgroup: "2081",
			source: "2081045",
			slot: 1,
			colorCode: 1,
			durationMs: 12000,
			encrypted: false,
		},
	},
	{
		decoderId: "dsd-fme",
		decoderType: "dsd-fme",
		hz: 161150000,
		outputType: "call_end",
		protocol: "dmr",
		category: "voice",
		entityKey: "talkgroup:9",
		title: "TG 9 · radio 2081045",
		fields: [
			{ key: "talkgroup", label: "Talkgroup", value: "9" },
			{ key: "source", label: "Radio", value: "2081045" },
			{ key: "slot", label: "Slot", value: 1 },
			{ key: "duration", label: "Duration", value: 41, unit: "s" },
		],
		data: {
			protocol: "DMR",
			talkgroup: "9",
			source: "2081045",
			slot: 1,
			colorCode: 1,
			durationMs: 41000,
			encrypted: false,
		},
	},
	{
		decoderId: "dsd-fme",
		decoderType: "dsd-fme",
		hz: 163087500,
		outputType: "call_end",
		protocol: "p25p1",
		category: "voice",
		entityKey: "talkgroup:1201",
		title: "TG 1201 · radio 4410022",
		fields: [
			{ key: "talkgroup", label: "Talkgroup", value: "1201" },
			{ key: "source", label: "Radio", value: "4410022" },
			{ key: "encrypted", label: "Encrypted", value: true },
		],
		data: {
			protocol: "P25",
			nac: "293",
			talkgroup: "1201",
			source: "4410022",
			encrypted: true,
			algorithm: "AES-256",
			durationMs: 8000,
		},
	},
	{
		decoderId: "ais-catcher",
		decoderType: "ais-catcher",
		hz: 161975000,
		outputType: "ship",
		protocol: "ais",
		category: "marine",
		entityKey: "mmsi:227006760",
		title: "Kerlouan · fishing",
		fields: [
			{ key: "mmsi", label: "MMSI", value: "227006760" },
			{ key: "sog", label: "Speed", value: 11.4, unit: "kn" },
			{ key: "cog", label: "Course", value: 284, unit: "°" },
		],
		position: { lat: 48.7262, lon: -3.9853 },
		data: {
			mmsi: "227006760",
			name: "KERLOUAN",
			shipType: "fishing",
			sog: 11.4,
			cog: 284,
			lat: 48.7262,
			lon: -3.9853,
			msgType: 1,
		},
	},
	{
		decoderId: "ais-catcher",
		decoderType: "ais-catcher",
		hz: 162025000,
		outputType: "ship",
		protocol: "ais",
		category: "marine",
		entityKey: "mmsi:228237700",
		title: "Belle Étoile · static",
		fields: [
			{ key: "mmsi", label: "MMSI", value: "228237700" },
			{ key: "shipType", label: "Type", value: "passenger" },
		],
		data: {
			mmsi: "228237700",
			name: "BELLE ETOILE",
			shipType: "passenger",
			msgType: 5,
		},
	},
	{
		decoderId: "multimon-ng",
		decoderType: "multimon-ng",
		hz: 160450000,
		outputType: "message",
		protocol: "pocsag",
		category: "paging",
		entityKey: "capcode:1234567",
		title: "Capcode 1234567 · alpha",
		fields: [
			{ key: "address", label: "Capcode", value: "1234567" },
			{
				key: "message",
				label: "Message",
				value: "Test page — system check 0412. Reply not required.",
			},
		],
		data: {
			protocol: "POCSAG1200",
			address: 1234567,
			function: 3,
			messageType: "alpha",
			message: "Test page — system check 0412. Reply not required.",
		},
	},
	{
		decoderId: "multimon-ng",
		decoderType: "multimon-ng",
		hz: 160450000,
		outputType: "message",
		protocol: "pocsag",
		category: "paging",
		entityKey: "capcode:1234560",
		title: "Capcode 1234560 · numeric",
		fields: [
			{ key: "address", label: "Capcode", value: "1234560" },
			{ key: "message", label: "Message", value: "0612 44 18" },
		],
		data: {
			protocol: "POCSAG1200",
			address: 1234560,
			function: 0,
			messageType: "numeric",
			message: "0612 44 18",
		},
	},
	{
		decoderId: "direwolf",
		decoderType: "direwolf",
		hz: 144800000,
		outputType: "aprs",
		protocol: "aprs",
		category: "aprs",
		entityKey: "callsign:F4ABC-9",
		title: "F4ABC-9 · mobile",
		fields: [
			{ key: "from", label: "From", value: "F4ABC-9" },
			{
				key: "comment",
				label: "Comment",
				value: "On the way home. QRV 145.500",
			},
			{ key: "speed", label: "Speed", value: 52, unit: "km/h" },
		],
		position: { lat: 48.3904, lon: -4.4861 },
		data: {
			from: "F4ABC-9",
			to: "APDW16",
			via: ["WIDE1-1"],
			comment: "On the way home. QRV 145.500",
			lat: 48.3904,
			lon: -4.4861,
			speedKmh: 52,
			course: 112,
		},
	},
	{
		decoderId: "direwolf",
		decoderType: "direwolf",
		hz: 144800000,
		outputType: "aprs",
		protocol: "aprs",
		category: "aprs",
		entityKey: "callsign:F6XYZ-13",
		title: "F6XYZ-13 · weather",
		fields: [
			{ key: "from", label: "From", value: "F6XYZ-13" },
			{ key: "temperature", label: "Temperature", value: 14.2, unit: "°C" },
		],
		position: { lat: 48.684, lon: -3.92 },
		data: {
			from: "F6XYZ-13",
			to: "APRS",
			via: ["WIDE2-1"],
			lat: 48.684,
			lon: -3.92,
			weather: {
				temperature_C: 14.2,
				humidity: 78,
				wind_avg_km_h: 18,
				wind_dir_deg: 270,
				wind_max_km_h: 31,
				pressure_hPa: 1012.4,
				rain_1h_mm: 0.3,
			},
		},
	},
	{
		decoderId: "rtl433-433",
		decoderType: "rtl433",
		hz: 433920000,
		outputType: "decode",
		protocol: "ism",
		category: "sensors",
		entityKey: "sensor:Generic-Remote-4128",
		title: "Generic-Remote 4128",
		// a model the core has no renderer for: no fields, only the JSON
		fields: [],
		data: {
			time: "2026-10-17 14:00:17",
			model: "Generic-Remote",
			id: 4128,
			cmd: 5,
			tristate: "ZZX0FX10ZZ",
		},
	},
	{
		decoderId: "multimon-ng",
		decoderType: "multimon-ng",
		hz: 160450000,
		outputType: "message",
		protocol: "pocsag",
		category: "paging",
		entityKey: "capcode:1234567",
		title: "Capcode 1234567",
		fields: [
			{ key: "address", label: "Capcode", value: "1234567" },
			{ key: "function", label: "Function", value: 1 },
		],
		data: {
			protocol: "POCSAG1200",
			address: 1234567,
			function: 1,
			messageType: "tone",
		},
	},
	{
		decoderId: "rtl433-433",
		decoderType: "rtl433",
		hz: 433920000,
		outputType: "decode",
		protocol: "ism",
		category: "sensors",
		entityKey: "sensor:Acurite-Tower-12345",
		title: "Acurite-Tower · ID 12345",
		fields: [
			{ key: "temperature_C", label: "Temperature", value: 18.4, unit: "°C" },
			{ key: "humidity", label: "Humidity", value: 61, unit: "%" },
			{ key: "battery_ok", label: "Battery", value: "OK" },
		],
		data: {
			model: "Acurite-Tower",
			id: 12345,
			channel: "A",
			temperature_C: 18.4,
			humidity: 61,
			battery_ok: 1,
		},
	},
	{
		decoderId: "rtl433-433",
		decoderType: "rtl433",
		hz: 433920000,
		outputType: "decode",
		protocol: "ism",
		category: "sensors",
		entityKey: "sensor:Toyota-a1b2c3d4",
		title: "Toyota TPMS · a1b2c3d4",
		// the core presents only the readings it knows (temperature, humidity, battery); the card humanises the rest
		fields: [
			{ key: "temperature_C", label: "Temperature", value: 21, unit: "°C" },
		],
		data: {
			time: "2026-10-17 14:01:40",
			model: "Toyota",
			type: "TPMS",
			id: "a1b2c3d4",
			status: 128,
			pressure_kPa: 232.5,
			temperature_C: 21,
			mic: "CRC",
		},
	},
	{
		decoderId: "rtl433-868",
		decoderType: "rtl433",
		hz: 868300000,
		outputType: "decode",
		protocol: "ism",
		category: "sensors",
		entityKey: "sensor:LaCrosse-TX29IT-47",
		title: "LaCrosse-TX29IT · ID 47",
		fields: [
			{ key: "temperature_C", label: "Temperature", value: 16.9, unit: "°C" },
			{ key: "battery_ok", label: "Battery", value: "OK" },
		],
		data: {
			model: "LaCrosse-TX29IT",
			id: 47,
			temperature_C: 16.9,
			battery_ok: 1,
		},
	},
	{
		decoderId: "rtl433-868",
		decoderType: "rtl433",
		hz: 868950000,
		outputType: "decode",
		protocol: "ism",
		category: "sensors",
		entityKey: "sensor:Wireless-MBus-41526375",
		title: "Water meter · ID 41526375",
		fields: [
			{ key: "total_m3", label: "Total", value: 1284.6, unit: "m³" },
			{ key: "flow", label: "Flow", value: 0, unit: "l/h" },
		],
		data: {
			model: "Wireless-MBus",
			id: 41526375,
			mode: "T1",
			total_m3: 1284.6,
		},
	},
	{
		decoderId: "acarsdec",
		decoderType: "acarsdec",
		hz: 131725000,
		outputType: "acars",
		protocol: "acars",
		category: "aviation-data",
		entityKey: "reg:F-HBXA",
		title: "F-HBXA · XK4521 · H1",
		fields: [
			{ key: "tail", label: "Tail", value: "F-HBXA" },
			{ key: "flight", label: "Flight", value: "XK4521" },
			{
				key: "text",
				label: "Text",
				value: "POS N48467 W003275,FL340,ETA 1447,FOB 9.2",
			},
		],
		data: {
			tail: "F-HBXA",
			flight: "XK4521",
			label: "H1",
			mode: "2",
			text: "POS N48467 W003275,FL340,ETA 1447,FOB 9.2",
		},
	},
	{
		decoderId: "dumpvdl2",
		decoderType: "dumpvdl2",
		hz: 136975000,
		outputType: "vdl2",
		protocol: "vdl2",
		category: "aviation-data",
		entityKey: "reg:F-GZTB",
		title: "F-GZTB · XK8801 · CPDLC",
		fields: [
			{ key: "tail", label: "Tail", value: "F-GZTB" },
			{ key: "text", label: "Text", value: "CLIMB TO AND MAINTAIN FL360" },
		],
		data: {
			tail: "F-GZTB",
			flight: "XK8801",
			station: "LFRB",
			direction: "uplink",
			text: "CLIMB TO AND MAINTAIN FL360",
		},
	},
	{
		decoderId: "meshtastic",
		decoderType: "lora-meshtastic",
		hz: 869525000,
		outputType: "meshtastic",
		protocol: "meshtastic",
		category: "mesh",
		entityKey: "node:!a3f2c1d4",
		title: "Harbour relay → everyone",
		fields: [
			{
				key: "text",
				label: "Text",
				value:
					"Anyone on the coast tonight? Signal is great from the lighthouse.",
			},
			{ key: "hops", label: "Hops", value: "2 of 3" },
			{ key: "snr", label: "SNR", value: 6.5, unit: "dB" },
		],
		data: {
			from: "!a3f2c1d4",
			to: "^all",
			text: "Anyone on the coast tonight? Signal is great from the lighthouse.",
			hopStart: 3,
			hopLimit: 1,
			snr: 6.5,
		},
	},
	{
		decoderId: "readsb",
		decoderType: "readsb",
		hz: 1090000000,
		outputType: "aircraft",
		protocol: "adsb",
		category: "aircraft",
		entityKey: "icao:3944EF",
		title: "AFR1234 · A320",
		fields: [
			{ key: "callsign", label: "Callsign", value: "AFR1234" },
			{ key: "altitude", label: "Altitude", value: 36000, unit: "ft" },
			{ key: "speed", label: "Speed", value: 452, unit: "kn" },
		],
		position: { lat: 48.79, lon: -3.86, altM: 10973 },
		data: {
			icao: "3944EF",
			callsign: "AFR1234",
			altitude: 36000,
			speed: 452,
			track: 241,
			lat: 48.79,
			lon: -3.86,
		},
	},
	{
		decoderId: "readsb",
		decoderType: "readsb",
		hz: 1090000000,
		outputType: "aircraft",
		protocol: "adsb",
		category: "aircraft",
		entityKey: "icao:4CA7F2",
		title: "EZY48KT · climbing",
		fields: [
			{ key: "callsign", label: "Callsign", value: "EZY48KT" },
			{ key: "altitude", label: "Altitude", value: 11250, unit: "ft" },
		],
		position: { lat: 48.52, lon: -3.71, altM: 3429 },
		data: {
			icao: "4CA7F2",
			callsign: "EZY48KT",
			altitude: 11250,
			speed: 288,
			track: 52,
			lat: 48.52,
			lon: -3.71,
		},
	},
]

/** Analog transmissions for the activity history (Tuned.dc.html recent lines). */
export const MOCK_TRANSMISSIONS: readonly {
	hz: number
	durationMs: number
	title: string
	ctcssHz: number | null
	dtmf: string | null
}[] = [
	{
		hz: 156800000,
		durationMs: 9000,
		title: "Marine ch 16",
		ctcssHz: null,
		dtmf: null,
	},
	{
		hz: 160625000,
		durationMs: 5000,
		title: "NFM voice",
		ctcssHz: 88.5,
		dtmf: null,
	},
	{
		hz: 160625000,
		durationMs: 2000,
		title: "DTMF *72#1405",
		ctcssHz: 88.5,
		dtmf: "*72#1405",
	},
	{
		hz: 446006250,
		durationMs: 14000,
		title: "PMR446 ch 1",
		ctcssHz: 77.0,
		dtmf: null,
	},
	{
		hz: 161425000,
		durationMs: 7000,
		title: "NFM voice · DCS 023N",
		ctcssHz: null,
		dtmf: null,
	},
	{
		hz: 145637500,
		durationMs: 21000,
		title: "2 m repeater · F4ABC",
		ctcssHz: 123.0,
		dtmf: null,
	},
]

/**
 * Saved frequencies (Tuner.dc.html / Immersive.dc.html `saved`, Palette.dc.html adds PMR446 ch 1), in
 * core's operator-data shape. Three sit inside the default capture (160.3–162.7 MHz) so the spectrum
 * shows their tags; PMR446 ch 1 keeps the CTCSS tone its transmissions carry.
 */
export const MOCK_SAVED_FREQUENCIES: readonly SavedFrequencyInput[] = [
	{
		name: "DMR repeater",
		frequencyHz: 161_150_000,
		mode: "nfm",
		bandwidthHz: 12_500,
		tone: { kind: "none" },
		group: "Local",
	},
	{
		name: "AIS channel A",
		frequencyHz: 161_975_000,
		mode: "nfm",
		bandwidthHz: 25_000,
		tone: { kind: "none" },
		group: "Marine",
	},
	{
		name: "Port ops",
		frequencyHz: 160_625_000,
		mode: "nfm",
		bandwidthHz: 12_500,
		tone: { kind: "none" },
		group: "Marine",
	},
	{
		name: "Marine ch 16",
		frequencyHz: 156_800_000,
		mode: "nfm",
		bandwidthHz: 12_500,
		tone: { kind: "none" },
		group: "Marine",
	},
	{
		name: "PMR446 ch 1",
		frequencyHz: 446_006_250,
		mode: "nfm",
		bandwidthHz: 12_500,
		tone: { kind: "ctcss", frequencyTenthsHz: 770 },
		group: "Local",
	},
	{
		name: "Tower",
		frequencyHz: 118_100_000,
		mode: "am",
		bandwidthHz: 8_330,
		tone: { kind: "none" },
		group: "Aviation",
	},
]

// --- Scanner (GET /api/scanner/bandplans, seeded discoveries) ---

const MHZ = (mhz: number) => Math.round(mhz * 1e6)
const LAND_MOBILE_OBW = [9000, 11_000, 4500]
const LAND_MOBILE: ScannerProtocol[] = [
	"dmr",
	"analog-fm",
	"p25p1",
	"nxdn48",
	"nxdn96",
]

/**
 * The core's built-in bandplans for region EU (src/core/scanner/bandplan/builtin.ts through
 * bandplansFor("EU"), same order and values), plus `pager-466`: the French 466 MHz paging block
 * of the canvas band plan (`pg466`), which the core has no built-in for.
 */
export const SCANNER_BANDPLANS: readonly Bandplan[] = [
	{
		id: "airband",
		region: "EU",
		name: "Airband (8.33 / 25 kHz)",
		ranges: [
			{
				startHz: MHZ(118),
				endHz: MHZ(137),
				rasters: [
					{ spacingHz: 25_000, firstChannelHz: MHZ(118) },
					{ spacingHz: 25_000 / 3, firstChannelHz: MHZ(118) },
				],
				obwHz: [],
				protocols: ["analog-am"],
				bandplanId: "airband",
			},
		],
	},
	{
		id: "cb",
		region: "EU",
		name: "CB (40 CEPT channels)",
		ranges: (
			[
				[26.965, 26.985],
				[27.005, 27.035],
				[27.055, 27.085],
				[27.105, 27.135],
				[27.155, 27.185],
				[27.205, 27.405],
			] as const
		).map(([a, b]) => ({
			startHz: MHZ(a),
			endHz: MHZ(b),
			rasters: [{ spacingHz: 10_000, firstChannelHz: MHZ(a) }],
			obwHz: [],
			protocols: ["analog-am", "analog-fm"] as ScannerProtocol[],
			bandplanId: "cb",
		})),
	},
	{
		id: "ism-169",
		region: "EU",
		name: "169 MHz metering (Wize / wireless M-Bus)",
		ranges: [
			{
				startHz: MHZ(169.4),
				endHz: MHZ(169.475),
				obwHz: [],
				protocols: ["ism"],
				bandplanId: "ism-169",
			},
		],
	},
	{
		id: "pager-vhf",
		region: "EU",
		name: "VHF paging (169 MHz metering band excluded)",
		ranges: [
			{
				startHz: MHZ(137),
				endHz: MHZ(169.4) - 1,
				rasters: [{ spacingHz: 12_500, firstChannelHz: MHZ(137) }],
				obwHz: [12_000],
				protocols: ["pocsag", "flex"],
				bandplanId: "pager-vhf",
			},
			{
				startHz: MHZ(169.475) + 1,
				endHz: MHZ(174),
				rasters: [{ spacingHz: 12_500, firstChannelHz: MHZ(137) }],
				obwHz: [12_000],
				protocols: ["pocsag", "flex"],
				bandplanId: "pager-vhf",
			},
		],
	},
	{
		id: "pmr446",
		region: "EU",
		name: "PMR446",
		ranges: [
			{
				startHz: MHZ(446),
				endHz: MHZ(446.2),
				rasters: [
					{ spacingHz: 12_500, firstChannelHz: MHZ(446.00625) },
					{ spacingHz: 6250, firstChannelHz: MHZ(446.003125) },
				],
				obwHz: [9000, 11_000],
				protocols: ["analog-fm", "dmr", "dpmr"],
				bandplanId: "pmr446",
			},
		],
	},
	{
		id: "dpmr446",
		region: "EU",
		name: "dPMR446 / NXDN 6.25 kHz",
		ranges: [
			{
				startHz: MHZ(446),
				endHz: MHZ(446.2),
				rasters: [{ spacingHz: 6250, firstChannelHz: MHZ(446.003125) }],
				obwHz: [4500],
				protocols: ["dpmr", "nxdn48"],
				bandplanId: "dpmr446",
			},
		],
	},
	{
		id: "uhf-land-mobile",
		region: "all",
		name: "UHF land mobile",
		ranges: [
			{
				startHz: MHZ(400),
				endHz: MHZ(470),
				rasters: [
					{ spacingHz: 12_500, firstChannelHz: MHZ(400.00625) },
					{ spacingHz: 6250, firstChannelHz: MHZ(400.003125) },
				],
				obwHz: LAND_MOBILE_OBW,
				protocols: LAND_MOBILE,
				bandplanId: "uhf-land-mobile",
			},
		],
	},
	{
		id: "vhf-land-mobile",
		region: "all",
		name: "VHF land mobile",
		ranges: [
			{
				startHz: MHZ(136),
				endHz: MHZ(174),
				rasters: [
					{ spacingHz: 12_500, firstChannelHz: MHZ(136.00625) },
					{ spacingHz: 6250, firstChannelHz: MHZ(136.003125) },
				],
				obwHz: LAND_MOBILE_OBW,
				protocols: [...LAND_MOBILE, "pocsag"],
				bandplanId: "vhf-land-mobile",
			},
		],
	},
	{
		id: "amateur-2m",
		region: "EU",
		name: "Amateur 2 m",
		ranges: [
			{
				startHz: MHZ(144),
				endHz: MHZ(146),
				rasters: [{ spacingHz: 12_500, firstChannelHz: MHZ(144) }],
				obwHz: [11_000, 16_000],
				protocols: ["analog-fm", "aprs", "dstar", "dmr", "ysf"],
				bandplanId: "amateur-2m",
			},
		],
	},
	{
		id: "amateur-70cm",
		region: "EU",
		name: "Amateur 70 cm",
		ranges: [
			{
				startHz: MHZ(430),
				endHz: MHZ(440),
				rasters: [
					{ spacingHz: 12_500, firstChannelHz: MHZ(430) },
					{ spacingHz: 25_000, firstChannelHz: MHZ(430) },
				],
				obwHz: [9000, 11_000, 16_000],
				protocols: ["analog-fm", "dstar", "dmr", "ysf", "p25p1"],
				bandplanId: "amateur-70cm",
			},
		],
	},
	{
		id: "aprs",
		region: "EU",
		name: "APRS 144.800",
		ranges: [
			{
				startHz: MHZ(144.8) - 8000,
				endHz: MHZ(144.8) + 8000,
				rasters: [{ spacingHz: 25_000, firstChannelHz: MHZ(144.8) }],
				obwHz: [16_000],
				protocols: ["aprs"],
				bandplanId: "aprs",
			},
		],
	},
	{
		id: "ism-433",
		region: "EU",
		name: "ISM 433 MHz",
		ranges: [
			{
				startHz: MHZ(433.05),
				endHz: MHZ(434.79),
				obwHz: [],
				protocols: ["ism"],
				bandplanId: "ism-433",
			},
		],
	},
	{
		id: "ism-868",
		region: "EU",
		name: "ISM 868 MHz",
		ranges: [
			{
				startHz: MHZ(863),
				endHz: MHZ(870),
				obwHz: [],
				protocols: ["ism"],
				bandplanId: "ism-868",
			},
		],
	},
	{
		id: "marine-vhf",
		region: "all",
		name: "Marine VHF (AIS excluded)",
		ranges: [
			{
				startHz: MHZ(156),
				endHz: MHZ(161.9625),
				rasters: [{ spacingHz: 25_000, firstChannelHz: MHZ(156) }],
				obwHz: [16_000],
				protocols: ["analog-fm"],
				bandplanId: "marine-vhf",
			},
			{
				startHz: MHZ(161.9875),
				endHz: MHZ(162.0125),
				rasters: [{ spacingHz: 25_000, firstChannelHz: MHZ(156) }],
				obwHz: [16_000],
				protocols: ["analog-fm"],
				bandplanId: "marine-vhf",
			},
		],
	},
	{
		id: "pager-466",
		region: "EU",
		name: "Pagers 466 MHz (e*Message)",
		ranges: [
			{
				startHz: MHZ(466.025),
				endHz: MHZ(466.23),
				rasters: [{ spacingHz: 12_500, firstChannelHz: MHZ(466.025) }],
				obwHz: [12_000],
				protocols: ["pocsag", "flex"],
				bandplanId: "pager-466",
			},
		],
	},
]

/** A seeded discovery (Brittany), on one of MOCK_SIGNALS; the scanner mock fills the rest. */
export interface DiscoverySeed {
	mhz: number
	protocol: ScannerProtocol
	confidence: ScannerConfidence
	class: ScannerClass
	identity?: Identity
	metadata?: Partial<DiscoveryMetadata>
	encrypted?: boolean
	operator?: {
		label?: string
		notes?: string
		lockout?: boolean
		keep?: boolean
	}
	/** Last heard this many minutes ago. */
	agoMin: number
	/** First heard this many days ago. */
	firstDays: number
	observations: number
	/** Also heard by the seeded marine sweep (MOCK_SWEEP_JOB_ID). */
	swept?: boolean
}

/** The id of seeded discovery `index` (the scanner mock and the recordings mock share it). */
export function seedDiscoveryId(index: number, hz: number): string {
	return `d_01JBRZSEED${String(index).padStart(2, "0")}${hz.toString(36).toUpperCase()}`
}

export const DISCOVERY_SEEDS: readonly DiscoverySeed[] = [
	{
		mhz: 161.15,
		protocol: "dmr",
		confidence: "decoded",
		class: "tdma-ms",
		identity: { kind: "dmr-cc", value: "1" },
		metadata: { talkgroups: ["2081", "9"], sources: ["2081045"], slots: [1] },
		operator: { label: "DMR repeater", keep: true },
		agoMin: 1,
		firstDays: 21,
		observations: 412,
	},
	{
		mhz: 163.0875,
		protocol: "p25p1",
		confidence: "decoded",
		class: "fsk4-12k5",
		identity: { kind: "p25-nac", value: "293" },
		metadata: { talkgroups: ["1201"], sources: ["4410022"] },
		agoMin: 9,
		firstDays: 12,
		observations: 88,
	},
	{
		mhz: 160.45,
		protocol: "pocsag",
		confidence: "decoded",
		class: "fsk2-wide",
		identity: { kind: "pocsag-capcode", value: "1234567" },
		metadata: { capcodes: ["1234567", "1234570"] },
		agoMin: 2,
		firstDays: 30,
		observations: 960,
	},
	{
		mhz: 466.025,
		protocol: "flex",
		confidence: "candidate",
		class: "fsk2-wide",
		agoMin: 240,
		firstDays: 4,
		observations: 37,
	},
	{
		mhz: 156.8,
		protocol: "analog-fm",
		confidence: "classified",
		class: "analog-fm",
		operator: {
			label: "Marine ch 16",
			notes: "Distress and calling; traffic moves to a working channel",
			keep: true,
		},
		agoMin: 6,
		firstDays: 27,
		observations: 233,
		swept: true,
	},
	{
		mhz: 156.6,
		protocol: "analog-fm",
		confidence: "classified",
		class: "analog-fm",
		operator: { label: "Port ops ch 12" },
		agoMin: 35,
		firstDays: 27,
		observations: 61,
		swept: true,
	},
	{
		mhz: 144.8,
		protocol: "aprs",
		confidence: "decoded",
		class: "afsk-fm",
		identity: { kind: "aprs-call", value: "F4ABC-9" },
		metadata: { callsigns: ["F4ABC-9", "F6XYZ-13"] },
		agoMin: 3,
		firstDays: 30,
		observations: 1204,
	},
	{
		mhz: 145.5,
		protocol: "analog-fm",
		confidence: "classified",
		class: "analog-fm",
		agoMin: 180,
		firstDays: 9,
		observations: 14,
	},
	{
		mhz: 145.6375,
		protocol: "analog-fm",
		confidence: "classified",
		class: "analog-fm",
		metadata: { ctcssHz: 123 },
		operator: { label: "Relay Brest" },
		agoMin: 50,
		firstDays: 18,
		observations: 73,
	},
	{
		mhz: 433.92,
		protocol: "ism",
		confidence: "decoded",
		class: "ook-burst",
		identity: { kind: "ism-model", value: "Acurite-Tower" },
		metadata: { ismModels: ["Acurite-Tower", "Toyota", "Generic-Remote"] },
		agoMin: 1,
		firstDays: 25,
		observations: 2210,
	},
	{
		mhz: 433.075,
		protocol: "unknown",
		confidence: "activity",
		class: "unknown",
		agoMin: 600,
		firstDays: 2,
		observations: 3,
	},
	{
		mhz: 446.00625,
		protocol: "analog-fm",
		confidence: "classified",
		class: "analog-fm",
		metadata: { ctcssHz: 77 },
		agoMin: 15,
		firstDays: 14,
		observations: 140,
	},
	{
		mhz: 446.03125,
		protocol: "analog-fm",
		confidence: "candidate",
		class: "analog-fm",
		agoMin: 95,
		firstDays: 6,
		observations: 22,
	},
	{
		mhz: 446.09375,
		protocol: "dmr",
		confidence: "decoded",
		class: "tdma-ms",
		identity: { kind: "dmr-cc", value: "3" },
		metadata: { talkgroups: ["99"], slots: [1] },
		encrypted: true,
		agoMin: 420,
		firstDays: 3,
		observations: 11,
	},
	{
		mhz: 160.625,
		protocol: "analog-fm",
		confidence: "classified",
		class: "analog-fm",
		metadata: { ctcssHz: 88.5 },
		agoMin: 4,
		firstDays: 30,
		observations: 512,
		swept: true,
	},
	{
		mhz: 160.9,
		protocol: "carrier",
		confidence: "activity",
		class: "carrier",
		operator: { label: "Spur", lockout: true },
		agoMin: 1,
		firstDays: 30,
		observations: 4900,
	},
	{
		mhz: 161.425,
		protocol: "analog-fm",
		confidence: "classified",
		class: "analog-fm",
		agoMin: 20,
		firstDays: 11,
		observations: 45,
	},
	{
		mhz: 162.4,
		protocol: "carrier",
		confidence: "activity",
		class: "carrier",
		agoMin: 1,
		firstDays: 30,
		observations: 3120,
	},
	{
		mhz: 161.975,
		protocol: "ais",
		confidence: "decoded",
		class: "gmsk-narrow",
		identity: { kind: "ais-mmsi", value: "227006760" },
		agoMin: 1,
		firstDays: 30,
		observations: 8800,
	},
	{
		mhz: 162.025,
		protocol: "ais",
		confidence: "decoded",
		class: "gmsk-narrow",
		identity: { kind: "ais-mmsi", value: "228237700" },
		agoMin: 1,
		firstDays: 30,
		observations: 7650,
	},
	{
		mhz: 131.725,
		protocol: "acars",
		confidence: "decoded",
		class: "unknown",
		identity: { kind: "acars-reg", value: "F-GKXA" },
		agoMin: 8,
		firstDays: 16,
		observations: 301,
	},
	{
		mhz: 136.975,
		protocol: "vdl2",
		confidence: "decoded",
		class: "unknown",
		identity: { kind: "vdl2-addr", value: "3944A1" },
		agoMin: 5,
		firstDays: 16,
		observations: 655,
	},
	{
		mhz: 118.1,
		protocol: "analog-am",
		confidence: "classified",
		class: "analog-fm",
		operator: { label: "Tower" },
		agoMin: 12,
		firstDays: 16,
		observations: 190,
	},
	{
		mhz: 119.7,
		protocol: "analog-am",
		confidence: "candidate",
		class: "analog-fm",
		agoMin: 75,
		firstDays: 5,
		observations: 19,
	},
	{
		mhz: 868.3,
		protocol: "ism",
		confidence: "decoded",
		class: "fsk2-wide",
		identity: { kind: "ism-model", value: "LaCrosse-TX29IT" },
		metadata: { ismModels: ["LaCrosse-TX29IT", "Fineoffset-WH51"] },
		agoMin: 2,
		firstDays: 20,
		observations: 1530,
	},
	{
		mhz: 868.95,
		protocol: "ism",
		confidence: "decoded",
		class: "fsk2-wide",
		identity: { kind: "ism-model", value: "Wireless-MBus" },
		metadata: { ismModels: ["Wireless-MBus"] },
		agoMin: 30,
		firstDays: 8,
		observations: 96,
	},
	{
		mhz: 869.525,
		protocol: "lora",
		confidence: "decoded",
		class: "wideband",
		identity: { kind: "lora-node", value: "!a1b2c3d4" },
		agoMin: 7,
		firstDays: 10,
		observations: 210,
	},
]

/** The seeded, ended marine sweep the swept discoveries list in `jobIds`. */
export const MOCK_SWEEP_JOB_ID = "j_01JBRZMOCKMARINE0000000000"
