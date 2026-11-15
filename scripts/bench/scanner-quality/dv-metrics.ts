/**
 * Digital voice capture metrics: the decoder's calls scored against the overs
 * a transmission plan sent (scripts/fixtures/dv-plan.mjs). Shared by the
 * capture harness (tests/integration/dv-capture.ts, live dsd-fme) and the
 * truth scorecard's DV scenes (truth-dv.ts, recorded line timings).
 *
 * Per over:
 * - `calls`: the calls that hold it (must be 1); `splits` = calls - 1;
 * - `merged`: one of its calls also holds another over (two overs, one call);
 * - `headCutMs`: its first call's start minus key-up (late is positive);
 * - `endErrMs`: its last call's end minus key-down;
 * - `tFirstMs`: key-up to the first line that prints a checked field of it
 *   (a line belongs to the over whose span holds it, else the nearest);
 * - `framesChecked` / `framesSent`: such lines against the checked frames sent;
 * - `recording`: one of its calls names a WAV file.
 *
 * All times are ms on the plan's timeline (the harness maps line arrival
 * times onto it).
 */

/** An over as sent (dv-plan.mjs SentOver, with its scene's clear/encrypted flag). */
export interface DvOver {
	index: number
	protocol: string
	slot: 1 | 2 | null
	startMs: number
	endMs: number
	frames: number
	terminator: boolean
	/** Clear voice (a recording is expected); false: encrypted. Default true. */
	clear?: boolean
	/** Identities sent (talkgroup, source; YSF src; D-STAR my). */
	ids?: Readonly<Record<string, unknown>>
}

/** A call the adapter reported (its call_end, or its call_start alone). */
export interface DvCall {
	startedAtMs: number
	endedAtMs: number
	slot: number | null
	talkgroup: number | null
	source: number | null
	wavFile: boolean
	timeout: boolean
}

/** A decoder output line and when it arrived (plan ms). */
export interface DvLine {
	atMs: number
	text: string
}

export interface DvOverScore {
	index: number
	protocol: string
	slot: 1 | 2 | null
	durationMs: number
	terminator: boolean
	clear: boolean
	calls: number
	splits: number
	merged: boolean
	headCutMs: number | null
	endErrMs: number | null
	tFirstMs: number | null
	framesSent: number
	framesChecked: number
	recording: boolean
}

/**
 * A call holds an over when they overlap by at least min(HOLD_MIN_MS, half
 * the over): 200 ms is more than the adapter's 700 ms trailer leaves of a
 * re-key 0.2 s later minus one superframe (700 - 200 - 360 = 140 ms), so a
 * call's tail running into the next over is not counted as holding it.
 */
export const HOLD_MIN_MS = 200
/**
 * A call that overlaps no over (a 0 ms call made at a terminator line, or a
 * call the line latency put after key-down) belongs to the over whose span,
 * widened by these, holds its start: LEAD 500 ms (a settle-replay repeat is at
 * most one D-STAR superframe, 420 ms, plus 80 ms of jitter), TAIL 700 ms (the
 * adapter's call trailer).
 */
export const MATCH_LEAD_MS = 500
export const MATCH_TAIL_MS = 700

const overlap = (a0: number, a1: number, b0: number, b1: number): number =>
	Math.max(0, Math.min(a1, b1) - Math.max(a0, b0))

const sameSlot = (call: DvCall, over: DvOver): boolean =>
	over.slot === null || call.slot === null || call.slot === over.slot

/**
 * The over a time belongs to among `overs` (indexes) that `ok` allows: the
 * one whose span holds it, else the nearest whose span widened by
 * MATCH_LEAD_MS / MATCH_TAIL_MS holds it; -1: none.
 */
function nearestOver(
	overs: readonly DvOver[],
	t: number,
	ok: (o: DvOver) => boolean,
): number {
	let best = -1
	let bestDistance = Infinity
	overs.forEach((o, i) => {
		if (!ok(o)) return
		if (t < o.startMs - MATCH_LEAD_MS || t > o.endMs + MATCH_TAIL_MS) return
		const d = t < o.startMs ? o.startMs - t : t > o.endMs ? t - o.endMs : 0
		if (d < bestDistance) {
			best = i
			bestDistance = d
		}
	})
	return best
}

/** The overs (indexes into `overs`) each call holds. */
export function holdsOf(
	overs: readonly DvOver[],
	calls: readonly DvCall[],
): number[][] {
	return calls.map(call => {
		const held: number[] = []
		overs.forEach((o, i) => {
			if (!sameSlot(call, o)) return
			const need = Math.min(HOLD_MIN_MS, (o.endMs - o.startMs) / 2)
			if (overlap(call.startedAtMs, call.endedAtMs, o.startMs, o.endMs) >= need)
				held.push(i)
		})
		if (held.length > 0) return held
		const best = nearestOver(overs, call.startedAtMs, o => sameSlot(call, o))
		return best < 0 ? [] : [best]
	})
}

/** Scores every over of a plan against the calls and timed lines of one run. */
export function scoreOvers(
	overs: readonly DvOver[],
	calls: readonly DvCall[],
	lines: readonly DvLine[],
	checked: (line: string, over: DvOver) => boolean,
): DvOverScore[] {
	const holds = holdsOf(overs, calls)
	// Each checked line counts for the one over it belongs to (nearestOver).
	const owner = lines.map(l =>
		nearestOver(overs, l.atMs, o => checked(l.text, o)),
	)
	return overs.map((o, i) => {
		const mine = calls.filter((_, c) => holds[c]!.includes(i))
		const merged = calls.some(
			(_, c) => holds[c]!.includes(i) && holds[c]!.length > 1,
		)
		const window = lines.filter((_, k) => owner[k] === i)
		return {
			index: o.index,
			protocol: o.protocol,
			slot: o.slot,
			durationMs: o.endMs - o.startMs,
			terminator: o.terminator,
			clear: o.clear ?? true,
			calls: mine.length,
			splits: Math.max(0, mine.length - 1),
			merged,
			headCutMs:
				mine.length === 0
					? null
					: Math.min(...mine.map(c => c.startedAtMs)) - o.startMs,
			endErrMs:
				mine.length === 0
					? null
					: Math.max(...mine.map(c => c.endedAtMs)) - o.endMs,
			tFirstMs: window.length === 0 ? null : window[0]!.atMs - o.startMs,
			framesSent: o.frames,
			framesChecked: Math.min(o.frames, window.length),
			recording: mine.some(c => c.wavFile),
		}
	})
}

/** Nearest-rank percentile `p` (0 to 100) of `values`; null when empty. */
export function percentile(
	values: readonly number[],
	p: number,
): number | null {
	if (values.length === 0) return null
	const sorted = [...values].sort((a, b) => a - b)
	const rank = Math.max(1, Math.ceil((p / 100) * sorted.length))
	return sorted[rank - 1]!
}

export interface DvSummary {
	overs: number
	/** Overs held by exactly one call that holds no other over. */
	exactlyOne: number
	missed: number
	splits: number
	merged: number
	headCutP50Ms: number | null
	headCutP90Ms: number | null
	/** endErrMs p90 of overs sent with their terminator, and without. */
	endErrP90Ms: number | null
	endErrNoTermP90Ms: number | null
	tFirstP90Ms: number | null
	framesSent: number
	framesChecked: number
	/** Clear overs no recording holds. */
	recordingMissing: number
}

export function summarise(rows: readonly DvOverScore[]): DvSummary {
	const num = (xs: (number | null)[]): number[] =>
		xs.filter((x): x is number => x !== null)
	return {
		overs: rows.length,
		exactlyOne: rows.filter(r => r.calls === 1 && !r.merged).length,
		missed: rows.filter(r => r.calls === 0).length,
		splits: rows.reduce((n, r) => n + r.splits, 0),
		merged: rows.filter(r => r.merged).length,
		headCutP50Ms: percentile(num(rows.map(r => r.headCutMs)), 50),
		headCutP90Ms: percentile(num(rows.map(r => r.headCutMs)), 90),
		endErrP90Ms: percentile(
			num(rows.filter(r => r.terminator).map(r => r.endErrMs)),
			90,
		),
		endErrNoTermP90Ms: percentile(
			num(rows.filter(r => !r.terminator).map(r => r.endErrMs)),
			90,
		),
		tFirstP90Ms: percentile(num(rows.map(r => r.tFirstMs)), 90),
		framesSent: rows.reduce((n, r) => n + r.framesSent, 0),
		framesChecked: rows.reduce((n, r) => n + r.framesChecked, 0),
		recordingMissing: rows.filter(r => r.clear && !r.recording).length,
	}
}

/** One measured point of the harness: a scene at a CNR, error and phase. */
export interface DvPoint {
	scene: string
	variant: string
	cnrDb: number
	errorHz: number
	phase: number
	rows: DvOverScore[]
}

const ms = (v: number | null): string =>
	v === null ? "n/a" : `${Math.round(v)}`
const share = (n: number, d: number): string =>
	d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)} %`

/**
 * Markdown: one row per scene, variant, CNR and frequency error (the phases
 * and overs summed), then one row per over of every point.
 */
export function dvTable(points: readonly DvPoint[]): string {
	const groups = new Map<string, DvPoint[]>()
	for (const p of points) {
		const key = `${p.scene}|${p.variant}|${p.cnrDb}|${p.errorHz}`
		groups.set(key, [...(groups.get(key) ?? []), p])
	}
	const out = [
		"| Scene | Variant | CNR | Error | Overs | One call | Missed | Splits | Merged | headCut p50 / p90 ms | endErr p90 ms (TLC / none) | tFirst p90 ms | Frames checked |",
		"| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
	]
	for (const [key, ps] of groups) {
		const [scene, variant, cnr, err] = key.split("|") as [
			string,
			string,
			string,
			string,
		]
		const s = summarise(ps.flatMap(p => p.rows))
		out.push(
			`| ${scene} | ${variant} | ${cnr} dB | ${err} Hz | ${s.overs} | ${share(s.exactlyOne, s.overs)} | ${s.missed} | ${s.splits} | ${s.merged} | ${ms(s.headCutP50Ms)} / ${ms(s.headCutP90Ms)} | ${ms(s.endErrP90Ms)} / ${ms(s.endErrNoTermP90Ms)} | ${ms(s.tFirstP90Ms)} | ${share(s.framesChecked, s.framesSent)} |`,
		)
	}
	out.push(
		"",
		"| Scene | Variant | CNR | Error | Phase | Over | Slot | Length ms | Calls | Merged | headCut ms | endErr ms | tFirst ms | Frames |",
		"| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
	)
	for (const p of points)
		for (const r of p.rows)
			out.push(
				`| ${p.scene} | ${p.variant} | ${p.cnrDb} dB | ${p.errorHz} Hz | ${p.phase} | ${r.index} | ${r.slot ?? "-"} | ${Math.round(r.durationMs)} | ${r.calls} | ${r.merged ? "yes" : "no"} | ${ms(r.headCutMs)} | ${ms(r.endErrMs)} | ${ms(r.tFirstMs)} | ${r.framesChecked}/${r.framesSent}${r.terminator ? "" : " (no TLC)"} |`,
			)
	return out.join("\n")
}
