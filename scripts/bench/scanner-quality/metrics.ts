/**
 * Scanner quality benchmark: scores one run against the scene's ground truth.
 *
 * Matching: a track belongs to the truth signal whose centre is nearest, within max(half its
 * nominal bandwidth, 6.25 kHz), while that signal is on (500 ms slack). A capture counts for every
 * signal its passband overlaps while that signal is on (capturesSpectrally). A discovery
 * matches the same way by frequency, created at any time after the signal's first transmission
 * began (push-to-talk pooling and pending promotion create records after a transmission ends).
 *
 * Identification oracle (fake decoders; nothing is decoded): a capture identifies its signal when
 * the real replay planner put the signal's protocol in its trials, the capture centre lies within
 * the decoder's reach of the signal's centre (2.5 kHz for the 48 kHz audio decoders and the
 * analog trial; for rtl_433 and LoRa the capture's passband must hold the whole signal, see
 * reachHz), the captured window holds at
 * least 80 % of min(500 ms, the transmission), and the signal's SNR reaches the decoder floor
 * (DECODE_FLOOR_DB). The trials run one after another at a nominal 1 s each, so a protocol in
 * trial slot k is identified k s after the capture finished.
 */
import type { CaptureRecord, RunRecord } from "./harness.js"
import {
	SIGNAL_CLASSES,
	type Interval,
	type RetunedScene,
	type Scene,
	type SignalClass,
	type TruthSignal,
} from "./scene.js"

/** Nominal replay cost of one trial (ms). */
export const TRIAL_MS = 1_000
/** Decoder SNR floors (dB, scene convention) below which the fake decoder never answers. */
export const DECODE_FLOOR_DB: Record<string, number> = {
	"analog-fm": 6,
	dmr: 10,
	pocsag: 8,
	aprs: 10,
	ism: 8,
	lora: 0,
}
const NARROW_REACH_HZ = 2_500

/**
 * The scanner class a working classifier shows for a signal class (spectral class on the record),
 * where one is expected: FM voice is `analog-fm`, an unmodulated carrier `carrier`.
 */
export const EXPECTED_CLASS: Partial<Record<SignalClass, string>> = {
	"nfm-voice": "analog-fm",
	"nfm-ptt": "analog-fm",
	carrier: "carrier",
}
const ON_SLACK_MS = 500

export type Stage =
	| "track"
	| "gate"
	| "discovery"
	| "capture"
	| "trial-plan"
	| "identify"

export interface SignalScore {
	id: string
	class: SignalClass
	snrDb: number
	offsetKHz: number
	spurious: boolean
	expectedProtocol: string | null
	transmissions: number
	tracks: number
	tracksPerTransmission: number
	/** Best channel-gate SNR any of its tracks reached (dB), null without a channel reading. */
	bestChannelSnrDb: number | null
	gatePassed: boolean
	discovered: boolean
	/** Discoveries ever created for it (merged-away ones included). */
	discoveriesCreated: number
	/** Discoveries for it still listed at the end; > 1 is a split. */
	discoveriesLive: number
	timeToDiscoveryMs: number | null
	captured: boolean
	trialPlanned: boolean
	identified: boolean
	timeToIdentifyMs: number | null
	/** Onset to the first moment one of its records showed its expected class (EXPECTED_CLASS). */
	timeToClassifyMs: number | null
	/** The first stage that failed (null: every applicable stage passed). */
	lostAt: Stage | null
	/** Labels the discoveries showed (class / hint). */
	labels: string[]
}

export interface FalseDiscovery {
	id: string
	offsetKHz: number
	bandwidthHz: number
	class: string
	kind: "dc" | "birdie" | "other"
}

export interface CellScore {
	class: SignalClass
	snrDb: number
	signals: number
	discovered: number
	identifiable: number
	identified: number
	medianTtdMs: number | null
	medianTtiMs: number | null
}

export interface QualityReport {
	scene: string
	rateHz: number
	centreHz: number
	iqSeconds: number
	cpuSecondsPerIqSecond: number
	wallSeconds: number
	signals: SignalScore[]
	cells: CellScore[]
	totals: {
		real: number
		discovered: number
		recall: number
		identifiable: number
		identified: number
		identificationRate: number
		duplicateRecords: number
		splitSignals: number
		falseDiscoveries: number
		falseByKind: Record<FalseDiscovery["kind"], number>
		tracks: number
		discoveries: number
		captures: number
		/** Requests the modelled capture port refused (busy, rate-limited). */
		capturesRefused: number
	}
	falseDiscoveries: FalseDiscovery[]
}

const median = (xs: number[]): number | null => {
	if (xs.length === 0) return null
	const s = [...xs].sort((a, b) => a - b)
	const m = s.length >> 1
	return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

const toleranceOf = (t: TruthSignal): number =>
	Math.max(t.bandwidthHz / 2, 6_250)

function onAt(t: TruthSignal, fromMs: number, toMs: number): boolean {
	return t.intervals.some(
		iv => iv.startMs - ON_SLACK_MS <= toMs && iv.endMs + ON_SLACK_MS >= fromMs,
	)
}

/**
 * The signal was on air inside [fromMs, toMs]: strict interval overlap, no slack. A capture's IQ
 * window is exact (pre-roll to its end), so a transmission that starts after the window closed is
 * not in it, however close.
 */
export function onAirWithin(
	t: Pick<TruthSignal, "intervals">,
	fromMs: number,
	toMs: number,
): boolean {
	return t.intervals.some(iv => iv.startMs < toMs && iv.endMs > fromMs)
}

/** On-intervals closer than 1 s are one transmission (a sensor's triple send). */
function transmissionsOf(t: TruthSignal): Interval[] {
	const out: Interval[] = []
	for (const iv of t.intervals) {
		const last = out.at(-1)
		if (last && iv.startMs - last.endMs < 1_000) last.endMs = iv.endMs
		else out.push({ ...iv })
	}
	return out
}

/** The truth signal a frequency and time span belong to, or null. */
function matchTruth(
	scene: Scene,
	hz: number,
	fromMs: number,
	toMs: number,
	/** Discoveries: created at or after the signal's first transmission, at any later time. */
	sinceFirst = false,
): TruthSignal | null {
	let best: TruthSignal | null = null
	let bestD = Infinity
	for (const t of scene.truth) {
		const d = Math.abs(hz - t.centreHz)
		const inTime = sinceFirst
			? fromMs >= (t.intervals[0]?.startMs ?? 0) - ON_SLACK_MS
			: onAt(t, fromMs, toMs)
		if (d > toleranceOf(t) || !inTime) continue
		if (d < bestD) {
			best = t
			bestD = d
		}
	}
	return best
}

const trialMatches = (
	expected: string,
	trial: CaptureRecord["trials"][number],
): boolean =>
	expected === "analog-fm"
		? trial.kind === "analog" && trial.protocol === "analog-fm"
		: trial.protocol === expected

/** Decoders that take the capture's whole passband (the rest demodulate a 48 kHz audio channel). */
const PASSBAND_DECODERS = new Set(["rtl433", "lora-meshtastic"])

/**
 * How far (Hz) the capture centre may sit from the signal's centre for `decoder` to decode it, or
 * null when the capture cannot hold the signal at all. Passband decoders need the whole signal
 * inside the capture: rate ≥ nominal bandwidth, else null (a 96 kHz capture never holds a
 * 100 kHz signal), then (rate − bandwidth) / 2, the offset at which the signal's edge meets the
 * capture's edge: a passband exactly as wide as the signal must be centred on it (reach 0).
 */
export function reachHz(
	decoder: string,
	capture: Pick<CaptureRecord, "rateHz">,
	t: Pick<TruthSignal, "bandwidthHz">,
): number | null {
	if (!PASSBAND_DECODERS.has(decoder)) return NARROW_REACH_HZ
	if (capture.rateHz < t.bandwidthHz) return null
	return (capture.rateHz - t.bandwidthHz) / 2
}

/**
 * The capture's passband [rf − rate / 2, rf + rate / 2] overlaps the signal's nominal band
 * [centre − bandwidth / 2, centre + bandwidth / 2]: the capture holds at least part of it.
 */
export function capturesSpectrally(
	capture: Pick<CaptureRecord, "rfHz" | "rateHz">,
	t: Pick<TruthSignal, "centreHz" | "bandwidthHz">,
): boolean {
	return (
		Math.abs(capture.rfHz - t.centreHz) < (capture.rateHz + t.bandwidthHz) / 2
	)
}

function overlapMs(
	window: [number, number],
	intervals: readonly Interval[],
): {
	overlap: number
	needed: number
} {
	let best = { overlap: 0, needed: Infinity }
	for (const iv of intervals) {
		const o = Math.min(window[1], iv.endMs) - Math.max(window[0], iv.startMs)
		if (o <= 0) continue
		const needed = 0.8 * Math.min(500, iv.endMs - iv.startMs)
		if (o - needed > best.overlap - best.needed) best = { overlap: o, needed }
	}
	return best
}

/** The scene ms the fake decoders identify `t` from `capture`, or null. */
export function oracleIdentify(
	t: TruthSignal,
	capture: CaptureRecord,
): number | null {
	const expected = t.expectedProtocol
	if (
		expected === null ||
		capture.windowMs === null ||
		capture.finishedMs === null
	)
		return null
	if (t.snrDb < (DECODE_FLOOR_DB[expected] ?? 10)) return null
	const slot = capture.trials.findIndex(tr => trialMatches(expected, tr))
	if (slot < 0) return null
	const trial = capture.trials[slot]!
	const reach = reachHz(trial.decoder, capture, t)
	if (reach === null || Math.abs(capture.rfHz - t.centreHz) > reach) return null
	const { overlap, needed } = overlapMs(capture.windowMs, t.intervals)
	if (overlap < needed) return null
	return capture.finishedMs + (slot + 1) * TRIAL_MS
}

export function score(scene: Scene, run: RunRecord): QualityReport {
	const live = new Set(run.finalIds)
	const tracksOf = new Map<string, number>()
	const gateOf = new Set<string>()
	const chSnrOf = new Map<string, number>()
	for (const tr of run.tracks) {
		const t = matchTruth(scene, tr.centreHz, tr.firstMs, tr.lastMs)
		if (!t) continue
		tracksOf.set(t.id, (tracksOf.get(t.id) ?? 0) + 1)
		if (tr.gate === "passed") gateOf.add(t.id)
		if (tr.maxChannelSnrDb !== null)
			chSnrOf.set(
				t.id,
				Math.max(chSnrOf.get(t.id) ?? -Infinity, tr.maxChannelSnrDb),
			)
	}
	const discOf = new Map<string, RunRecord["discoveries"]>()
	const falses: FalseDiscovery[] = []
	for (const d of run.discoveries) {
		const t = matchTruth(scene, d.centreHz, d.createdMs, d.createdMs, true)
		const offsetKHz = (d.centreHz - scene.centreHz) / 1000
		if (!t || t.spurious) {
			const kind: FalseDiscovery["kind"] =
				t?.class === "dc" || Math.abs(d.centreHz - scene.centreHz) <= 12_500
					? "dc"
					: t?.class === "birdie"
						? "birdie"
						: "other"
			falses.push({
				id: d.id,
				offsetKHz,
				bandwidthHz: d.bandwidthHz,
				class: d.class,
				kind,
			})
			if (!t) continue
		}
		const list = discOf.get(t.id) ?? []
		list.push(d)
		discOf.set(t.id, list)
	}
	const signals: SignalScore[] = scene.truth.map(t => {
		const txs = transmissionsOf(t)
		const firstOn = t.intervals[0]?.startMs ?? 0
		const ds = discOf.get(t.id) ?? []
		// Every capture whose passband holds part of the signal while it was on; the oracle decides
		// whether that capture is enough to decode it.
		// The capture's own IQ window decides, not the track's lifetime: a capture that ended
		// before a later signal came on holds none of it.
		const captures = run.captures.filter(
			c =>
				c.windowMs !== null &&
				capturesSpectrally(c, t) &&
				onAirWithin(t, c.windowMs[0], c.windowMs[1]),
		)
		const idTimes = captures
			.map(c => oracleIdentify(t, c))
			.filter((x): x is number => x !== null)
		const want = EXPECTED_CLASS[t.class]
		const classAt = want
			? ds.flatMap(d =>
					d.firstClassMs[want] === undefined ? [] : [d.firstClassMs[want]!],
				)
			: []
		const firstCreated = ds.length
			? Math.min(...ds.map(d => d.createdMs))
			: null
		const tracks = tracksOf.get(t.id) ?? 0
		const planned =
			t.expectedProtocol !== null &&
			captures.some(c =>
				c.trials.some(tr => trialMatches(t.expectedProtocol!, tr)),
			)
		const stages: [Stage, boolean][] = [
			["track", tracks > 0],
			["gate", gateOf.has(t.id)],
			["discovery", ds.length > 0],
		]
		if (t.expectedProtocol !== null)
			stages.push(
				["capture", captures.length > 0],
				["trial-plan", planned],
				["identify", idTimes.length > 0],
			)
		const labels = [
			...new Set(ds.map(d => (d.hint ? `${d.class}/${d.hint}` : d.class))),
		]
		return {
			id: t.id,
			class: t.class,
			snrDb: t.snrDb,
			offsetKHz: t.offsetHz / 1000,
			spurious: t.spurious,
			expectedProtocol: t.expectedProtocol,
			transmissions: txs.length,
			tracks,
			tracksPerTransmission: txs.length ? tracks / txs.length : 0,
			bestChannelSnrDb: chSnrOf.get(t.id) ?? null,
			gatePassed: gateOf.has(t.id),
			discovered: ds.length > 0,
			discoveriesCreated: ds.length,
			discoveriesLive: ds.filter(d => live.has(d.id)).length,
			timeToDiscoveryMs: firstCreated === null ? null : firstCreated - firstOn,
			captured: captures.length > 0,
			trialPlanned: planned,
			identified: idTimes.length > 0,
			timeToIdentifyMs: idTimes.length ? Math.min(...idTimes) - firstOn : null,
			timeToClassifyMs: classAt.length ? Math.min(...classAt) - firstOn : null,
			lostAt: t.spurious ? null : (stages.find(([, ok]) => !ok)?.[0] ?? null),
			labels,
		}
	})
	const real = signals.filter(s => !s.spurious)
	const cells: CellScore[] = []
	for (const c of SIGNAL_CLASSES)
		for (const snr of [
			...new Set(real.filter(s => s.class === c).map(s => s.snrDb)),
		].sort((a, b) => a - b)) {
			const xs = real.filter(s => s.class === c && s.snrDb === snr)
			const ident = xs.filter(s => s.expectedProtocol !== null)
			cells.push({
				class: c,
				snrDb: snr,
				signals: xs.length,
				discovered: xs.filter(s => s.discovered).length,
				identifiable: ident.length,
				identified: ident.filter(s => s.identified).length,
				medianTtdMs: median(
					xs.flatMap(s =>
						s.timeToDiscoveryMs === null ? [] : [s.timeToDiscoveryMs],
					),
				),
				medianTtiMs: median(
					xs.flatMap(s =>
						s.timeToIdentifyMs === null ? [] : [s.timeToIdentifyMs],
					),
				),
			})
		}
	const identifiable = real.filter(s => s.expectedProtocol !== null)
	const falseByKind = { dc: 0, birdie: 0, other: 0 }
	for (const f of falses) falseByKind[f.kind]++
	const discovered = real.filter(s => s.discovered).length
	const identified = identifiable.filter(s => s.identified).length
	return {
		scene: scene.name,
		rateHz: run.rateHz,
		centreHz: run.centreHz,
		iqSeconds: run.iqSeconds,
		cpuSecondsPerIqSecond:
			run.iqSeconds > 0 ? run.cpuSeconds / run.iqSeconds : 0,
		wallSeconds: run.wallSeconds,
		signals,
		cells,
		totals: {
			real: real.length,
			discovered,
			recall: real.length ? discovered / real.length : 0,
			identifiable: identifiable.length,
			identified,
			identificationRate: identifiable.length
				? identified / identifiable.length
				: 0,
			duplicateRecords: real.reduce(
				(n, s) => n + Math.max(0, s.discoveriesLive - 1),
				0,
			),
			splitSignals: real.filter(s => s.discoveriesLive > 1).length,
			falseDiscoveries: falses.length,
			falseByKind,
			tracks: run.tracks.length,
			discoveries: run.discoveries.length,
			captures: run.captures.length,
			capturesRefused:
				run.refusedCaptures.busy + run.refusedCaptures.rateLimited,
		},
		falseDiscoveries: falses,
	}
}

// === text output ===

const pad = (s: string, n: number): string =>
	s.length >= n ? s : s + " ".repeat(n - s.length)
const ms = (v: number | null): string =>
	v === null ? "-" : `${(v / 1000).toFixed(1)}s`
const yn = (b: boolean): string => (b ? "y" : ".")

/** Per-signal table, class × SNR summary and totals. */
export function formatReport(r: QualityReport): string {
	const lines: string[] = []
	lines.push(
		`scene ${r.scene}: ${r.rateHz / 1e6} Msps at ${(r.centreHz / 1e6).toFixed(3)} MHz, ${r.iqSeconds.toFixed(1)} s IQ, ` +
			`${r.cpuSecondsPerIqSecond.toFixed(3)} CPU s per IQ s, wall ${r.wallSeconds.toFixed(1)} s`,
	)
	lines.push("")
	const head = [
		["signal", 20],
		["kHz", 8],
		["trk/tx", 7],
		["chSNR", 6],
		["gate", 5],
		["disc", 5],
		["ttd", 7],
		["live/new", 9],
		["cap", 4],
		["plan", 5],
		["ident", 6],
		["tti", 7],
		["ttc", 7],
		["lost at", 11],
		["labels", 0],
	] as const
	lines.push(head.map(([h, n]) => pad(h, n)).join(""))
	for (const s of r.signals) {
		const cols = [
			s.id,
			s.offsetKHz.toFixed(1),
			s.tracksPerTransmission.toFixed(1),
			s.bestChannelSnrDb === null ? "-" : s.bestChannelSnrDb.toFixed(0),
			yn(s.gatePassed),
			yn(s.discovered),
			ms(s.timeToDiscoveryMs),
			`${s.discoveriesLive}/${s.discoveriesCreated}`,
			s.expectedProtocol === null ? "-" : yn(s.captured),
			s.expectedProtocol === null ? "-" : yn(s.trialPlanned),
			s.expectedProtocol === null ? "-" : yn(s.identified),
			ms(s.timeToIdentifyMs),
			ms(s.timeToClassifyMs),
			s.spurious ? "(spurious)" : (s.lostAt ?? "ok"),
			s.labels.join(","),
		]
		lines.push(cols.map((c, i) => pad(c, head[i]![1])).join(""))
	}
	lines.push("")
	lines.push("class        SNR  found  ident  median ttd  median tti")
	for (const c of r.cells)
		lines.push(
			`${pad(c.class, 12)} ${pad(`${c.snrDb}`, 4)} ${pad(`${c.discovered}/${c.signals}`, 6)} ` +
				`${pad(c.identifiable ? `${c.identified}/${c.identifiable}` : "-", 6)} ` +
				`${pad(ms(c.medianTtdMs), 11)} ${ms(c.medianTtiMs)}`,
		)
	const t = r.totals
	lines.push("")
	lines.push(
		`recall ${t.discovered}/${t.real} (${(100 * t.recall).toFixed(0)} %), identified ${t.identified}/${t.identifiable} ` +
			`(${(100 * t.identificationRate).toFixed(0)} %), split signals ${t.splitSignals} (+${t.duplicateRecords} records), ` +
			`false discoveries ${t.falseDiscoveries} (dc ${t.falseByKind.dc}, birdie ${t.falseByKind.birdie}, other ${t.falseByKind.other})`,
	)
	lines.push(
		`pipeline tracks ${t.tracks}, discoveries created ${t.discoveries}, IQ captures made ${t.captures} (refused by the port ${t.capturesRefused})`,
	)
	for (const f of r.falseDiscoveries)
		lines.push(
			`  false: ${f.kind} at ${f.offsetKHz.toFixed(1)} kHz, ${f.bandwidthHz} Hz, class ${f.class}`,
		)
	return lines.join("\n")
}

/** No ground truth (--file): what the scanner found and what it would try. */
export function formatUnscored(run: RunRecord): string {
	const lines: string[] = []
	const cpu = run.iqSeconds > 0 ? run.cpuSeconds / run.iqSeconds : 0
	lines.push(
		`file: ${run.rateHz / 1e6} Msps at ${(run.centreHz / 1e6).toFixed(3)} MHz, ${run.iqSeconds.toFixed(1)} s IQ, ` +
			`${cpu.toFixed(3)} CPU s per IQ s, wall ${run.wallSeconds.toFixed(1)} s (no ground truth)`,
	)
	const gated = run.tracks.filter(t => t.gate === "passed").length
	lines.push(
		`pipeline tracks ${run.tracks.length} (gate passed ${gated}, edge ${run.tracks.filter(t => t.edge).length}), ` +
			`discoveries created ${run.discoveries.length}, listed at end ${run.finalIds.length}, captures ${run.captures.length}`,
	)
	const byLabel = new Map<string, number>()
	for (const d of run.discoveries) {
		const k = d.hint ? `${d.class}/${d.hint}` : d.class
		byLabel.set(k, (byLabel.get(k) ?? 0) + 1)
	}
	lines.push(
		`discovery labels: ${[...byLabel].map(([k, n]) => `${k} ${n}`).join(", ") || "none"}`,
	)
	const trials = new Map<string, number>()
	const skipped = new Map<string, number>()
	for (const c of run.captures) {
		for (const t of c.trials)
			trials.set(t.protocol, (trials.get(t.protocol) ?? 0) + 1)
		for (const s of c.skipped)
			skipped.set(
				`${s.protocol}:${s.reason}`,
				(skipped.get(`${s.protocol}:${s.reason}`) ?? 0) + 1,
			)
	}
	lines.push(
		`planned trials: ${[...trials].map(([k, n]) => `${k} ${n}`).join(", ") || "none"}`,
	)
	if (skipped.size)
		lines.push(
			`skipped trials: ${[...skipped].map(([k, n]) => `${k} ${n}`).join(", ")}`,
		)
	const firstMs = run.discoveries.map(d => d.createdMs).sort((a, b) => a - b)
	lines.push(
		`first discovery after ${ms(firstMs[0] ?? null)}, median creation time ${ms(median(firstMs))}`,
	)
	const bw = run.discoveries.map(d => d.bandwidthHz)
	lines.push(`median discovery bandwidth ${median(bw) ?? "-"} Hz`)
	return lines.join("\n")
}

export function unscoredJson(run: RunRecord) {
	return {
		rateHz: run.rateHz,
		iqSeconds: run.iqSeconds,
		cpuSecondsPerIqSecond:
			run.iqSeconds > 0 ? run.cpuSeconds / run.iqSeconds : 0,
		tracks: run.tracks.length,
		gatePassed: run.tracks.filter(t => t.gate === "passed").length,
		discoveries: run.discoveries.length,
		listed: run.finalIds.length,
		captures: run.captures.length,
	}
}

// === retuned scenes ===

export interface RetunedSignalScore {
	id: string
	class: SignalClass
	spurious: boolean
	/** Records created for it (deleted or merged ones included). */
	created: number
	/** Records for it still listed at the end. */
	live: number
	/** Classes its records showed. */
	labels: string[]
	timeToClassifyMs: number | null
}

export interface RetunedReport {
	scene: string
	iqSeconds: number
	signals: RetunedSignalScore[]
	/** Records of no real signal: created, and still listed at the end. */
	falseCreated: number
	falseLive: number
}

/**
 * Scores a retuned run by absolute frequency: a record belongs to the truth whose RF position
 * (any of them, for a spur) is nearest within max(half its width, 6.25 kHz).
 */
export function scoreRetuned(
	scene: RetunedScene,
	run: RunRecord,
	firstOnMs: Partial<Record<string, number>> = {},
): RetunedReport {
	const live = new Set(run.finalIds)
	const of = new Map<string, RunRecord["discoveries"]>()
	let falseCreated = 0
	let falseLive = 0
	for (const d of run.discoveries) {
		let best: (typeof scene.truth)[number] | null = null
		let bestD = Infinity
		for (const t of scene.truth)
			for (const hz of t.rfHz) {
				const dist = Math.abs(d.centreHz - hz)
				if (dist <= Math.max(t.bandwidthHz / 2, 6_250) && dist < bestD) {
					best = t
					bestD = dist
				}
			}
		if (best === null || best.spurious) {
			falseCreated++
			if (live.has(d.id)) falseLive++
		}
		if (best === null) continue
		const list = of.get(best.id) ?? []
		list.push(d)
		of.set(best.id, list)
	}
	return {
		scene: scene.name,
		iqSeconds: run.iqSeconds,
		signals: scene.truth.map(t => {
			const ds = of.get(t.id) ?? []
			const want = EXPECTED_CLASS[t.class]
			const at = want
				? ds.flatMap(d =>
						d.firstClassMs[want] === undefined ? [] : [d.firstClassMs[want]!],
					)
				: []
			return {
				id: t.id,
				class: t.class,
				spurious: t.spurious,
				created: ds.length,
				live: ds.filter(d => live.has(d.id)).length,
				labels: [...new Set(ds.map(d => d.class))],
				timeToClassifyMs: at.length
					? Math.min(...at) - (firstOnMs[t.id] ?? 0)
					: null,
			}
		}),
		falseCreated,
		falseLive,
	}
}

export function formatRetuned(r: RetunedReport): string {
	const lines = [`scene ${r.scene}: ${r.iqSeconds.toFixed(1)} s IQ (retuned)`]
	for (const s of r.signals)
		lines.push(
			`  ${pad(s.id, 18)} ${s.spurious ? "(spurious)" : "          "} created ${s.created} live ${s.live} ttc ${ms(s.timeToClassifyMs)} labels ${s.labels.join(",") || "-"}`,
		)
	lines.push(
		`false discoveries created ${r.falseCreated}, listed at the end ${r.falseLive}`,
	)
	return lines.join("\n")
}
