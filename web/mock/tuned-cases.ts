// Tuned card cases for the mock and tests: GET /api/decoders statuses at one frequency and the core's summary for
// it (GET /api/decoders/summary?hz=, built by ./decoder-summary.ts as the mock serves it). Synthetic frequencies
// only, apart from the public 1090 MHz ADS-B band. Each case says what the card should show (web/tests reads them).
import type {
	ActivitySummary,
	DecoderInfo,
	DecoderSummary,
} from "@wavekit/api-types"

import { buildDecoderSummaries } from "./decoder-summary.ts"

/** The cases' clock: every time below is relative to it. */
export const TUNED_CASE_NOW = Date.parse("2026-10-31T10:00:00Z")

const ago = (ms: number) => new Date(TUNED_CASE_NOW - ms).toISOString()

function status(
	over: Partial<DecoderInfo> & Pick<DecoderInfo, "id" | "type">,
): DecoderInfo {
	return {
		running: true,
		health: "running",
		uptime: 600,
		stats: { bytesIn: 0, eventsOut: 0, errors: 0 },
		restartCount: 0,
		desiredRunning: true,
		suspended: false,
		mode: "auto",
		owner: "config",
		...over,
	}
}

/** ADS-B: its protocol band, 1090 MHz. */
const adsb = (over: Partial<DecoderInfo> = {}) =>
	status({
		id: "readsb",
		type: "readsb",
		targetFrequenciesHz: [1_090_000_000],
		bandAssessment: {
			verdict: "in-band",
			targetsHz: [1_090_000_000],
			basis: "protocol",
		},
		...over,
	})

/** The pager decoder: a synthetic 466 MHz pair; its VFO channel follows the tuner (`targetFrequenciesHz`). */
const pager = (tunedHz: number, over: Partial<DecoderInfo> = {}) =>
	status({
		id: "multimon-ng",
		type: "multimon-ng",
		targetFrequenciesHz: [tunedHz],
		bandAssessment: {
			verdict: "in-band",
			targetsHz: [466_000_000, 466_025_000],
			basis: "configured",
		},
		...over,
	})

/** Digital voice: a synthetic 460–470 MHz range. */
const dmr = (over: Partial<DecoderInfo> = {}) =>
	status({
		id: "dsd-fme",
		type: "dsd-fme",
		targetFrequenciesHz: [466_012_500],
		bandAssessment: {
			verdict: "in-band",
			rangesHz: [{ minHz: 460_000_000, maxHz: 470_000_000 }],
			basis: "configured",
		},
		...over,
	})

const outOfBand = {
	running: false,
	suspended: true,
	suspension: {
		reasonCode: "frequency-out-of-band" as const,
		since: ago(60_000),
	},
}

export interface TunedCase {
	id: string
	title: string
	hz: number
	/** The resolved band plan's band there (its name and mode), else null. */
	band: { name: string; mode: string | null } | null
	/** What Identify or a proven discovery named there (discoveryCard), else null. */
	named: { proto: string; sub: string } | null
	decoders: DecoderInfo[]
	summary: DecoderSummary[]
	/** The channel's Activity, newest first; absent when nothing was heard. */
	activity?: readonly ActivitySummary[]
	expect: {
		/** The header's name for the signal. */
		proto: string
		/** The table's rows: decoder id and state word, in order. */
		rows: readonly (readonly [string, string])[]
		/** With `activity`: the event the card shows as the latest, else null. */
		latest?: string | null
	}
}

function tunedCase(c: Omit<TunedCase, "summary">): TunedCase {
	return {
		...c,
		summary: buildDecoderSummaries(c.decoders, TUNED_CASE_NOW, c.hz),
	}
}

const ADSB_HZ = 1_090_062_000
const ADSB_BAND = { name: "ADS-B (1090 MHz)", mode: "raw" }

let seq = 0
/** A decode on the channel (synthetic content). */
function heard(
	over: Partial<ActivitySummary> &
		Pick<ActivitySummary, "decoderId" | "protocol" | "category">,
	ms: number,
): ActivitySummary {
	seq += 1
	return {
		eventId: `tuned-${seq}`,
		commitSeq: String(seq),
		kind: "decoder-reception",
		producedAt: ago(ms),
		receivedAt: ago(ms),
		sourceId: "rtl-0",
		frequencyHz: ADSB_HZ,
		entityKey: null,
		title: null,
		fields: [],
		...over,
	}
}

/** A false pager decode stored at the 1090 MHz frequency (the pager's VFO channel sat there), newer than ADS-B's. */
const STRAY_PAGE = heard(
	{
		decoderId: "multimon-ng",
		protocol: "pocsag",
		category: "paging",
		title: "Capcode 0000001",
	},
	5_000,
)
const AIRCRAFT = [
	heard(
		{
			decoderId: "readsb",
			protocol: "adsb",
			category: "aircraft",
			frequencyHz: 1_090_000_000,
			entityKey: "aircraft:000001",
			title: "TEST01",
		},
		20_000,
	),
	heard(
		{
			decoderId: "readsb",
			protocol: "adsb",
			category: "aircraft",
			frequencyHz: 1_090_000_000,
			entityKey: "aircraft:000002",
			title: "TEST02",
		},
		40_000,
	),
]

export const TUNED_CASES: readonly TunedCase[] = [
	tunedCase({
		id: "adsb-paused",
		title:
			"1090 MHz: ADS-B paused for CPU budget; the pager's VFO channel sits here",
		hz: ADSB_HZ,
		band: ADSB_BAND,
		named: null,
		decoders: [
			adsb({
				running: false,
				suspended: true,
				suspension: { reasonCode: "efficiency-budget", since: ago(30_000) },
				efficiency: { detail: "budget" },
				lastOutputAt: ago(3_600_000),
				stats: { bytesIn: 0, eventsOut: 812, errors: 0 },
			}),
			pager(ADSB_HZ),
		],
		expect: { proto: "ADS-B", rows: [["readsb", "Paused"]] },
	}),
	tunedCase({
		id: "adsb-running",
		title: "1090 MHz: ADS-B decoding",
		hz: ADSB_HZ,
		band: ADSB_BAND,
		named: null,
		decoders: [
			adsb({
				lastOutputAt: ago(2_000),
				stats: { bytesIn: 1, eventsOut: 1204, errors: 0 },
			}),
			pager(ADSB_HZ),
		],
		expect: { proto: "ADS-B", rows: [["readsb", "Decoding"]] },
	}),
	tunedCase({
		id: "adsb-host-busy",
		title:
			"1090 MHz: ADS-B decoding while the host is busy: samples were dropped on several streams",
		hz: ADSB_HZ,
		band: ADSB_BAND,
		named: null,
		decoders: [
			adsb({
				lastOutputAt: ago(2_000),
				stats: { bytesIn: 1, eventsOut: 1204, errors: 0 },
				hostBusy: { congestedBranches: 2, loopLagP99Ms: 180 },
			}),
		],
		expect: { proto: "ADS-B", rows: [["readsb", "Decoding"]] },
	}),
	tunedCase({
		id: "adsb-shed-retry",
		title:
			"1090 MHz: ADS-B shed for its own dropped samples; it retries in 40 s",
		hz: ADSB_HZ,
		band: ADSB_BAND,
		named: null,
		decoders: [
			adsb({
				running: false,
				suspended: true,
				suspension: { reasonCode: "efficiency-budget", since: ago(20_000) },
				efficiency: {
					detail: "late-drops",
					cause: "decoder",
					retryAt: new Date(TUNED_CASE_NOW + 40_000).toISOString(),
				},
				lastOutputAt: ago(25_000),
				stats: { bytesIn: 1, eventsOut: 1204, errors: 0 },
			}),
		],
		expect: { proto: "ADS-B", rows: [["readsb", "Paused"]] },
	}),
	tunedCase({
		id: "adsb-stray-page",
		title:
			"1090 MHz: ADS-B decoding; a false pager decode stored here never names the card or its latest",
		hz: ADSB_HZ,
		band: ADSB_BAND,
		named: null,
		decoders: [
			adsb({
				lastOutputAt: ago(20_000),
				stats: { bytesIn: 1, eventsOut: 1204, errors: 0 },
			}),
			pager(ADSB_HZ, { lastOutputAt: ago(5_000) }),
		],
		activity: [STRAY_PAGE, ...AIRCRAFT],
		expect: {
			proto: "ADS-B",
			rows: [["readsb", "Decoding"]],
			latest: AIRCRAFT[0]!.eventId,
		},
	}),
	tunedCase({
		id: "adsb-source-paused",
		title:
			"1090 MHz: the operator paused the receiver feed; ADS-B waits for Resume",
		hz: ADSB_HZ,
		band: ADSB_BAND,
		named: null,
		decoders: [
			adsb({
				running: false,
				suspended: true,
				suspension: { reasonCode: "source-paused", since: ago(45_000) },
				sourceId: "rtl-0",
				lastOutputAt: ago(60_000),
				stats: { bytesIn: 1, eventsOut: 1204, errors: 0 },
			}),
			pager(ADSB_HZ, {
				running: false,
				suspended: true,
				suspension: { reasonCode: "source-paused", since: ago(45_000) },
			}),
		],
		expect: { proto: "ADS-B", rows: [["readsb", "Paused"]] },
	}),
	tunedCase({
		id: "pager-dmr-466",
		title:
			"466 MHz: pager listening and digital voice decoding; ADS-B waits off band",
		hz: 466_000_000,
		band: null,
		named: null,
		decoders: [
			adsb(outOfBand),
			pager(466_000_000, { lastOutputAt: ago(300_000) }),
			dmr({
				lastOutputAt: ago(10_000),
				stats: { bytesIn: 1, eventsOut: 37, errors: 0 },
			}),
		],
		expect: {
			proto: "Digital voice",
			rows: [
				["dsd-fme", "Decoding"],
				["multimon-ng", "Listening"],
			],
		},
	}),
	tunedCase({
		id: "pager-restarting",
		title:
			"466 MHz: the pager crashed and restarts on its own (no Restart offered)",
		hz: 466_000_000,
		band: null,
		named: null,
		decoders: [
			pager(466_000_000, {
				running: false,
				health: "restarting",
				nextRestartAt: new Date(TUNED_CASE_NOW + 5_000).toISOString(),
			}),
		],
		expect: { proto: "Pager", rows: [["multimon-ng", "Failed"]] },
	}),
	tunedCase({
		id: "unknown",
		title: "300 MHz: no band plan entry and no decoder's band",
		hz: 300_000_000,
		band: null,
		named: null,
		decoders: [adsb(outOfBand), pager(300_000_000, outOfBand), dmr(outOfBand)],
		expect: { proto: "NFM", rows: [] },
	}),
	tunedCase({
		id: "discovery-proof",
		title:
			"300.0125 MHz: a proven DMR discovery names it; no decoder's band holds it",
		hz: 300_012_500,
		band: null,
		// discoveryCard of a discovery whose proof says "DMR decoded (CC1)"
		named: { proto: "DMR", sub: "CC 1 · slot 2" },
		decoders: [adsb(outOfBand), pager(300_012_500, outOfBand), dmr(outOfBand)],
		expect: { proto: "DMR", rows: [] },
	}),
]
