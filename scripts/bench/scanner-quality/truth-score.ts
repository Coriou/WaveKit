/**
 * Scanner truth scorecard: scores what the recorder kept and what identify concluded against
 * the labels (truth-labels.ts), per case and in total, and checks the totals against the
 * checked-in limits (truth-thresholds.json).
 *
 * - False voice: a kept analog file whose best-overlapping label on its channel is not analog
 *   voice (DMR, POCSAG, a carrier, noise); in a case labelled `complete`, a kept file that
 *   overlaps no label counts too. `digitalKeptAsVoice` is the DMR and POCSAG part.
 * - Missed voice: an analog-voice transmission that no single kept file holds whole (its start
 *   and end within EDGE_TOLERANCE_MS). A transmission split over several files is missed too:
 *   whoever listens gets no one file of it.
 * - Identify: per labelled signal (one label on one channel), the verdict of the discovery that
 *   holds it at the end: right, wrong (a protocol other than the label's), or unidentified.
 *
 * Every number is a count of labelled things, never of time, so two runs of the same truth set
 * give the same scorecard (the runs are on the virtual clock).
 */
import type { RecordingRecord, TruthCase, TruthRun } from "./truth-run.js"
import {
	DIGITAL_LABELS,
	LIMIT_KINDS,
	NON_VOICE_LABELS,
	type Thresholds,
	type TruthException,
	type TruthInterval,
	type TruthLabel,
} from "./truth-labels.js"

/**
 * A kept file matches a label on its channel when its frequency is within half a 12.5 kHz
 * channel of the label's (or half the label's own bandwidth, when wider).
 */
export const CHANNEL_MATCH_HZ = 6_250
/**
 * A file holds a voice transmission whole when it starts no later than 300 ms after the
 * transmission's start and ends no earlier than 300 ms before its end: an onset reported a few
 * 50 ms blocks late, inside the recorder's 500 ms pre-roll, and an end within the label's own
 * precision (a label cut from a 100 ms envelope).
 */
export const EDGE_TOLERANCE_MS = 300
/** One signal: intervals of one label within this of each other's frequency. */
export const SIGNAL_MERGE_HZ = 3_125

/** The protocol a right identify verdict names for a label; null: no protocol (not a signal). */
const EXPECTED_PROTOCOL: Record<TruthLabel, string | null> = {
	"analog-voice": "analog-fm",
	dmr: "dmr",
	pocsag: "pocsag",
	carrier: null,
	noise: null,
	unknown: null,
}
/** Protocols that name nothing (an unidentified discovery). */
const NO_PROTOCOL = new Set(["unknown", "digital-unknown", "carrier"])

export interface KeptFile {
	frequencyHz: number
	startMs: number | null
	durationMs: number | null
	/** The label it overlaps most on its channel; "unmatched" when none. */
	label: TruthLabel | "unmatched"
	falseVoice: boolean
	/** The named exception that accounts for it (a false voice file only). */
	excepted?: string
}

export interface VoiceScore {
	frequencyHz: number
	startMs: number
	endMs: number
	/** whole: one kept file holds it; split: kept files cover it only together; partial; none. */
	recorded: "whole" | "split" | "partial" | "none"
	/** The named exception that accounts for it (a missed transmission only). */
	excepted?: string
}

export interface IdentifyScore {
	label: TruthLabel
	frequencyHz: number
	intervals: number
	/** The discovery's protocol and class at the end; null when no discovery holds it. */
	protocol: string | null
	class: string | null
	verdict: "right" | "wrong" | "unidentified"
}

export interface CaseScore {
	name: string
	kind: TruthCase["kind"]
	kept: KeptFile[]
	voice: VoiceScore[]
	identify: IdentifyScore[]
	decodes: TruthRun["decodes"]
	decisions: Record<string, number>
	totals: Totals
}

export interface Totals {
	cases: number
	keptFiles: number
	falseVoice: number
	digitalKeptAsVoice: number
	falseVoiceByLabel: Record<string, number>
	unmatchedKept: number
	voiceTransmissions: number
	missedVoice: number
	splitVoice: number
	labelledSignals: number
	identifyRight: number
	identifyWrong: number
	unidentified: number
	/**
	 * Harness steps that gave up waiting for the recorder's I/O: a run that may not repeat. Gated
	 * at 0 by the checked-in limits.
	 */
	ioOverruns: number
	/** Replays and recordings the run stopped before they settled: a verdict never seen. */
	unsettled: number
	/** False voice files and missed voice transmissions named exceptions account for. */
	excepted: number
}

export interface Scorecard {
	version: 1
	totals: Totals
	cases: CaseScore[]
	/** Totals of each kind of case (the limits gate these). */
	byKind: Record<(typeof LIMIT_KINDS)[number], Totals>
	/** Limits not met (kind, metric, value, the limit); empty: pass. */
	failures: {
		kind: (typeof LIMIT_KINDS)[number]
		metric: string
		value: number
		max?: number
		min?: number
	}[]
	pass: boolean
}

const overlap = (a0: number, a1: number, b0: number, b1: number): number =>
	Math.max(0, Math.min(a1, b1) - Math.max(a0, b0))

const reachOf = (iv: TruthInterval): number =>
	Math.max(CHANNEL_MATCH_HZ, (iv.bandwidthHz ?? 0) / 2)

const onChannel = (hz: number, iv: TruthInterval): boolean =>
	Math.abs(hz - iv.frequencyHz) <= reachOf(iv)

/** A kept file's span in scene ms, or null when the recorder did not report its start. */
function spanOf(r: RecordingRecord): [number, number] | null {
	if (r.startMs === null || r.durationMs === null) return null
	return [r.startMs, r.startMs + r.durationMs]
}

function labelKept(
	r: RecordingRecord,
	intervals: readonly TruthInterval[],
	complete: boolean,
): KeptFile {
	const span = spanOf(r)
	let best: TruthInterval | null = null
	let bestMs = 0
	for (const iv of intervals) {
		if (!onChannel(r.targetHz, iv)) continue
		// A file whose start is unknown matches its channel's labels by channel alone.
		const ms =
			span === null
				? iv.endMs - iv.startMs
				: overlap(span[0], span[1], iv.startMs, iv.endMs)
		if (ms > bestMs) {
			best = iv
			bestMs = ms
		}
	}
	const label = best?.label ?? "unmatched"
	return {
		frequencyHz: r.targetHz,
		startMs: r.startMs,
		durationMs: r.durationMs,
		label,
		falseVoice:
			label === "unmatched" ? complete : NON_VOICE_LABELS.includes(label),
	}
}

function scoreVoice(
	iv: TruthInterval,
	kept: readonly RecordingRecord[],
): VoiceScore {
	const spans = kept
		.filter(r => onChannel(r.targetHz, iv))
		.map(spanOf)
		.filter((s): s is [number, number] => s !== null)
		.filter(([a, b]) => overlap(a, b, iv.startMs, iv.endMs) > 0)
		.sort((x, y) => x[0] - y[0])
	const from = iv.startMs + EDGE_TOLERANCE_MS
	const to = iv.endMs - EDGE_TOLERANCE_MS
	const base = {
		frequencyHz: iv.frequencyHz,
		startMs: iv.startMs,
		endMs: iv.endMs,
	}
	if (spans.length === 0) return { ...base, recorded: "none" }
	if (spans.some(([a, b]) => a <= from && b >= to))
		return { ...base, recorded: "whole" }
	// Together: the files cover [from, to] with no gap longer than the tolerance.
	let reach = from
	for (const [a, b] of spans) {
		if (a > reach + EDGE_TOLERANCE_MS) break
		reach = Math.max(reach, b)
	}
	return {
		...base,
		recorded: spans[0]![0] <= from && reach >= to ? "split" : "partial",
	}
}

/** Labelled signals: intervals grouped by label and channel (SIGNAL_MERGE_HZ). */
function signalsOf(intervals: readonly TruthInterval[]): TruthInterval[][] {
	const groups: TruthInterval[][] = []
	for (const iv of [...intervals].sort(
		(a, b) => a.frequencyHz - b.frequencyHz || a.startMs - b.startMs,
	)) {
		if (iv.label === "unknown") continue
		const g = groups.find(
			x =>
				x[0]!.label === iv.label &&
				Math.abs(x[0]!.frequencyHz - iv.frequencyHz) <= SIGNAL_MERGE_HZ,
		)
		if (g) g.push(iv)
		else groups.push([iv])
	}
	return groups
}

function scoreIdentify(group: TruthInterval[], run: TruthRun): IdentifyScore {
	const first = group[0]!
	const listed = new Set(run.finalIds)
	// The listed discovery nearest the signal, among those on its channel.
	let best: TruthRun["discoveries"][number] | null = null
	for (const d of run.discoveries) {
		if (d.gone || !listed.has(d.id)) continue
		if (!onChannel(d.centreHz, first)) continue
		if (
			best === null ||
			Math.abs(d.centreHz - first.frequencyHz) <
				Math.abs(best.centreHz - first.frequencyHz)
		)
			best = d
	}
	const expected = EXPECTED_PROTOCOL[first.label]
	const protocol = best?.protocol ?? null
	const named = protocol !== null && !NO_PROTOCOL.has(protocol)
	let verdict: IdentifyScore["verdict"]
	if (expected !== null)
		verdict = protocol === expected ? "right" : named ? "wrong" : "unidentified"
	else if (first.label === "carrier")
		// A carrier is right as a carrier (its class or protocol) or with no record at all.
		verdict =
			best === null || best.class === "carrier" || protocol === "carrier"
				? "right"
				: named
					? "wrong"
					: "unidentified"
	// Noise is right when nothing names a protocol for it.
	else verdict = named ? "wrong" : "right"
	return {
		label: first.label,
		frequencyHz: first.frequencyHz,
		intervals: group.length,
		protocol,
		class: best?.class ?? null,
		verdict,
	}
}

const emptyTotals = (): Totals => ({
	cases: 0,
	keptFiles: 0,
	falseVoice: 0,
	digitalKeptAsVoice: 0,
	falseVoiceByLabel: {},
	unmatchedKept: 0,
	voiceTransmissions: 0,
	missedVoice: 0,
	splitVoice: 0,
	labelledSignals: 0,
	identifyRight: 0,
	identifyWrong: 0,
	unidentified: 0,
	ioOverruns: 0,
	unsettled: 0,
	excepted: 0,
})

export function scoreCase(c: TruthCase, run: TruthRun): CaseScore {
	const keptRecords = run.recordings.filter(
		r => r.outcome === "finalized" && r.onDisk,
	)
	const kept = keptRecords
		.map(r => labelKept(r, c.intervals, c.complete))
		.sort(
			(a, b) =>
				a.frequencyHz - b.frequencyHz || (a.startMs ?? 0) - (b.startMs ?? 0),
		)
	const voice = c.intervals
		.filter(iv => iv.label === "analog-voice")
		.map(iv => scoreVoice(iv, keptRecords))
	const identify = signalsOf(c.intervals).map(g => scoreIdentify(g, run))
	const t = emptyTotals()
	t.ioOverruns = run.busyOverruns
	t.unsettled = run.unsettled
	const score: CaseScore = {
		name: c.name,
		kind: c.kind,
		kept,
		voice,
		identify,
		decodes: run.decodes,
		decisions: Object.fromEntries(
			Object.entries(run.decisions).sort(([a], [b]) => a.localeCompare(b)),
		),
		totals: t,
	}
	return { ...score, totals: recount(score) }
}

/** A case's totals from its kept files, voice and identify rows; excepted rows count apart. */
function recount(c: CaseScore): Totals {
	const t = emptyTotals()
	t.cases = 1
	t.keptFiles = c.kept.length
	for (const k of c.kept) {
		if (k.label === "unmatched") t.unmatchedKept++
		if (!k.falseVoice) continue
		if (k.excepted !== undefined) {
			t.excepted++
			continue
		}
		t.falseVoice++
		t.falseVoiceByLabel[k.label] = (t.falseVoiceByLabel[k.label] ?? 0) + 1
		if (k.label !== "unmatched" && DIGITAL_LABELS.includes(k.label))
			t.digitalKeptAsVoice++
	}
	t.voiceTransmissions = c.voice.length
	for (const v of c.voice) {
		if (v.recorded === "whole") continue
		if (v.excepted !== undefined) {
			t.excepted++
			continue
		}
		t.missedVoice++
		if (v.recorded === "split") t.splitVoice++
	}
	t.labelledSignals = c.identify.length
	t.identifyRight = c.identify.filter(i => i.verdict === "right").length
	t.identifyWrong = c.identify.filter(i => i.verdict === "wrong").length
	t.unidentified = c.identify.filter(i => i.verdict === "unidentified").length
	t.ioOverruns = c.totals.ioOverruns
	t.unsettled = c.totals.unsettled
	return t
}

/**
 * Marks the rows each named exception accounts for (cases in run order, rows in order) on copies
 * of the cases, recounts their totals, and says how many rows each exception found.
 */
function applyExceptions(
	cases: readonly CaseScore[],
	exceptions: readonly TruthException[],
): { cases: CaseScore[]; found: Map<string, number> } {
	const out: CaseScore[] = cases.map(c => ({
		...c,
		kept: c.kept.map(({ excepted: _e, ...k }) => k),
		voice: c.voice.map(({ excepted: _e, ...v }) => v),
	}))
	const found = new Map<string, number>()
	for (const e of exceptions) {
		let n = 0
		for (const c of out) {
			if (c.kind !== e.kind || (e.case !== undefined && c.name !== e.case))
				continue
			const rows: { excepted?: string }[] =
				e.metric === "falseVoice"
					? c.kept.filter(
							k =>
								k.falseVoice && (e.label === undefined || k.label === e.label),
						)
					: c.voice.filter(v => v.recorded !== "whole")
			for (const row of rows) {
				if (n >= e.count) break
				if (row.excepted !== undefined) continue
				row.excepted = e.name
				n++
			}
		}
		found.set(e.name, n)
	}
	return { cases: out.map(c => ({ ...c, totals: recount(c) })), found }
}

function addTotals(a: Totals, b: Totals): Totals {
	const byLabel = { ...a.falseVoiceByLabel }
	for (const [k, v] of Object.entries(b.falseVoiceByLabel))
		byLabel[k] = (byLabel[k] ?? 0) + v
	return {
		cases: a.cases + b.cases,
		keptFiles: a.keptFiles + b.keptFiles,
		falseVoice: a.falseVoice + b.falseVoice,
		digitalKeptAsVoice: a.digitalKeptAsVoice + b.digitalKeptAsVoice,
		falseVoiceByLabel: byLabel,
		unmatchedKept: a.unmatchedKept + b.unmatchedKept,
		voiceTransmissions: a.voiceTransmissions + b.voiceTransmissions,
		missedVoice: a.missedVoice + b.missedVoice,
		splitVoice: a.splitVoice + b.splitVoice,
		labelledSignals: a.labelledSignals + b.labelledSignals,
		identifyRight: a.identifyRight + b.identifyRight,
		identifyWrong: a.identifyWrong + b.identifyWrong,
		unidentified: a.unidentified + b.unidentified,
		ioOverruns: a.ioOverruns + b.ioOverruns,
		unsettled: a.unsettled + b.unsettled,
		excepted: a.excepted + b.excepted,
	}
}

/** Numeric totals by name (the metrics a threshold may gate). */
export function metricOf(t: Totals, name: string): number | undefined {
	const v = (t as unknown as Record<string, unknown>)[name]
	return typeof v === "number" ? v : undefined
}

/** Every metric a limit names that the scorecard has not (none: the limits can be checked). */
export function unknownMetrics(limits: Thresholds): string[] {
	const t = emptyTotals()
	const out: string[] = []
	for (const kind of LIMIT_KINDS)
		for (const metric of Object.keys(limits.limits[kind] ?? {}))
			if (metricOf(t, metric) === undefined) out.push(`${kind}.${metric}`)
	return out.sort()
}

/**
 * The scorecard of the cases, checked against `limits`. A limit on no metric is an error.
 * `subset`: only some cases ran (`--only`), so the minimums are not checked, the maximums are.
 */
export function scorecard(
	scored: readonly CaseScore[],
	limits: Thresholds,
	opts: { subset?: boolean } = {},
): Scorecard {
	const unknown = unknownMetrics(limits)
	if (unknown.length > 0)
		throw new Error(`threshold names an unknown metric: ${unknown.join(", ")}`)
	const applied = applyExceptions(scored, limits.exceptions ?? [])
	const cases = applied.cases
	const sum = (cs: readonly CaseScore[]): Totals =>
		cs.reduce((acc, c) => addTotals(acc, c.totals), emptyTotals())
	const byKind = {
		synthetic: sum(cases.filter(c => c.kind === "synthetic")),
		capture: sum(cases.filter(c => c.kind === "capture")),
	}
	const failures: Scorecard["failures"] = []
	// A kind with no case in this run is not gated (its totals are all 0).
	for (const kind of LIMIT_KINDS.filter(k => byKind[k].cases > 0))
		for (const [metric, limit] of Object.entries(
			limits.limits[kind] ?? {},
		).sort(([a], [b]) => a.localeCompare(b))) {
			const value = metricOf(byKind[kind], metric)!
			// A subset of the cases (--only) cannot reach a minimum set for all of them.
			if (
				(limit.max !== undefined && value > limit.max) ||
				(limit.min !== undefined && !opts.subset && value < limit.min)
			)
				failures.push({
					kind,
					metric,
					value,
					...(limit.max !== undefined ? { max: limit.max } : {}),
					...(limit.min !== undefined ? { min: limit.min } : {}),
				})
		}
	// A stale exception (fewer rows than its count where it applies) fails: the ratchet.
	for (const e of limits.exceptions ?? []) {
		const applies =
			e.case !== undefined
				? cases.some(c => c.kind === e.kind && c.name === e.case)
				: byKind[e.kind].cases > 0 && opts.subset !== true
		const n = applied.found.get(e.name) ?? 0
		if (applies && n < e.count)
			failures.push({
				kind: e.kind,
				metric: `exception:${e.name}`,
				value: n,
				min: e.count,
			})
	}
	return {
		version: 1,
		totals: sum(cases),
		byKind,
		cases,
		failures,
		pass: failures.length === 0,
	}
}

/** The one human line. */
export function formatScorecardLine(s: Scorecard): string {
	const t = s.totals
	const verdict = s.pass
		? "PASS"
		: `FAIL (${s.failures
				.map(f =>
					f.max !== undefined && f.value > f.max
						? `${f.kind} ${f.metric} ${f.value} > ${f.max}`
						: `${f.kind} ${f.metric} ${f.value} < ${f.min ?? 0}`,
				)
				.join(", ")})`
	return (
		`truth scorecard: ${t.cases} cases, ${t.keptFiles} kept files: ` +
		`false voice ${t.falseVoice} (digital ${t.digitalKeptAsVoice}), ` +
		`missed voice ${t.missedVoice}/${t.voiceTransmissions} (split ${t.splitVoice}), ` +
		`identify ${t.identifyRight}/${t.labelledSignals} right, ${t.identifyWrong} wrong: ${verdict}`
	)
}
