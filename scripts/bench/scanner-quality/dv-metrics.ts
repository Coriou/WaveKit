/**
 * Digital voice capture metrics: the decoder's calls scored against the overs
 * a transmission plan sent (scripts/fixtures/dv-plan.mjs). Shared by the
 * capture harness (tests/integration/dv-capture.ts, live dsd-fme) and the
 * truth scorecard's DV scenes (truth-dv.ts, recorded line timings).
 *
 * Per over:
 * - `calls`: the calls that hold it (must be 1); `splits` = calls - 1;
 * - `missed`: its calls overlap it by less than min(HOLD_MIN_MS, half the
 *   over) in all (`heldMs`), so no call or only a nearby one (a 0 ms call at
 *   a late terminator line, given to it by the widened span) holds it;
 * - `merged`: one of its calls also holds another over (two overs, one call);
 * - `headCutMs`: its first call's start minus key-up (late is positive;
 *   negative in the settle-replay variant when the call began on the
 *   replayed copy fed just before the over);
 * - `endErrMs`: its last call's end minus key-down;
 * - `tFirstMs`: key-up to the first line that prints a checked field of it
 *   (a line belongs to the over whose span holds it, else the nearest, but
 *   never to an over less than one frame past its key-up while an earlier
 *   over can still own it: see lineOwner);
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
	/** The length the plan asked (dv-plan.mjs SentOver nominalMs). */
	nominalMs?: number | undefined
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
	/** The length the plan asked; null: not known (a recorded seed). */
	nominalMs: number | null
	terminator: boolean
	clear: boolean
	calls: number
	splits: number
	/** Its calls' overlap with it, summed (ms). */
	heldMs: number
	/** heldMs short of min(HOLD_MIN_MS, half the over): no call really holds it. */
	missed: boolean
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
 * An over asked to last this long or longer must never be missed (the
 * acceptance bar `dvMissedLong` 0): 1 s is the shortest over of the design's
 * "exactly one call, 100 %" class (DV-CAPTURE section B).
 */
export const DV_LONG_OVER_MS = 1000
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

/**
 * One frame of each protocol, the soonest after key-up a decoder can print a
 * field of the new over: DMR one 60 ms TDMA frame, P25 one 180 ms LDU, YSF one
 * 100 ms frame, NXDN48 and dPMR one 80 ms frame, D-STAR one 20 ms voice frame.
 * Unknown protocols: 0 (no guard).
 */
export const DV_FRAME_MS: Readonly<Record<string, number>> = {
	dmr: 60,
	p25: 180,
	ysf: 100,
	nxdn48: 80,
	dpmr: 80,
	dstar: 20,
}

/**
 * The over a checked line belongs to: nearestOver among the overs at least
 * one frame (DV_FRAME_MS) past their key-up at the line's time, else among
 * all of them. A line that arrives before the next over could have printed
 * anything (the late terminator of an over re-keyed 0.2 s later, same ids)
 * stays with the over already on air.
 */
function lineOwner(
	overs: readonly DvOver[],
	t: number,
	ok: (o: DvOver) => boolean,
): number {
	const settled = nearestOver(
		overs,
		t,
		o => ok(o) && t >= o.startMs + (DV_FRAME_MS[o.protocol] ?? 0),
	)
	return settled >= 0 ? settled : nearestOver(overs, t, ok)
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
	// Each checked line counts for the one over it belongs to (lineOwner).
	const owner = lines.map(l =>
		lineOwner(overs, l.atMs, o => checked(l.text, o)),
	)
	return overs.map((o, i) => {
		const mine = calls.filter((_, c) => holds[c]!.includes(i))
		const merged = calls.some(
			(_, c) => holds[c]!.includes(i) && holds[c]!.length > 1,
		)
		const window = lines.filter((_, k) => owner[k] === i)
		const heldMs = mine.reduce(
			(n, c) => n + overlap(c.startedAtMs, c.endedAtMs, o.startMs, o.endMs),
			0,
		)
		return {
			index: o.index,
			protocol: o.protocol,
			slot: o.slot,
			durationMs: o.endMs - o.startMs,
			nominalMs: o.nominalMs ?? null,
			terminator: o.terminator,
			clear: o.clear ?? true,
			calls: mine.length,
			splits: Math.max(0, mine.length - 1),
			heldMs,
			missed:
				mine.length === 0 ||
				heldMs < Math.min(HOLD_MIN_MS, (o.endMs - o.startMs) / 2),
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
	/** Overs no call really holds (DvOverScore missed). */
	missed: number
	/** Missed overs whose nominal length is at least DV_LONG_OVER_MS (unknown nominal: not counted). */
	missedLong: number
	splits: number
	merged: number
	/** Over the timed overs (timedRow): not merged, not missed. */
	headCutP50Ms: number | null
	headCutP90Ms: number | null
	/** endErrMs p90 of the timed overs sent with their terminator, without, and all. */
	endErrP90Ms: number | null
	endErrNoTermP90Ms: number | null
	endErrAllP90Ms: number | null
	tFirstP90Ms: number | null
	framesSent: number
	framesChecked: number
	/** Clear overs no recording holds. */
	recordingMissing: number
}

/**
 * An over whose head cut and end error are timings of its own call: not
 * merged (the call's start or end is another over's) and not missed (a
 * nearby 0 ms call's times say nothing of this over).
 */
export const timedRow = (r: DvOverScore): boolean => !r.merged && !r.missed

const num = (xs: (number | null)[]): number[] =>
	xs.filter((x): x is number => x !== null)

/** The head cuts of the timed overs of `rows`. */
export const headCuts = (rows: readonly DvOverScore[]): number[] =>
	num(rows.filter(timedRow).map(r => r.headCutMs))
/** The end errors of the timed overs of `rows`. */
export const endErrs = (rows: readonly DvOverScore[]): number[] =>
	num(rows.filter(timedRow).map(r => r.endErrMs))

export function summarise(rows: readonly DvOverScore[]): DvSummary {
	const timed = rows.filter(timedRow)
	return {
		overs: rows.length,
		exactlyOne: rows.filter(r => r.calls === 1 && !r.merged && !r.missed)
			.length,
		missed: rows.filter(r => r.missed).length,
		missedLong: rows.filter(
			r => r.missed && r.nominalMs !== null && r.nominalMs >= DV_LONG_OVER_MS,
		).length,
		splits: rows.reduce((n, r) => n + r.splits, 0),
		merged: rows.filter(r => r.merged).length,
		headCutP50Ms: percentile(headCuts(rows), 50),
		headCutP90Ms: percentile(headCuts(rows), 90),
		endErrP90Ms: percentile(endErrs(timed.filter(r => r.terminator)), 90),
		endErrNoTermP90Ms: percentile(
			endErrs(timed.filter(r => !r.terminator)),
			90,
		),
		endErrAllP90Ms: percentile(endErrs(rows), 90),
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
	/** Empty when the point failed. */
	rows: DvOverScore[]
	/** Why the point failed (dv-capture.ts runDvGrid): it has no rows then. */
	error?: string
	/**
	 * The decoder's non-zero exit or signal after it read all its input and
	 * printed lines (dv-capture.ts createShellRunner): recorded, not a failure.
	 */
	exit?: string
}

const ms = (v: number | null): string =>
	v === null ? "n/a" : `${Math.round(v)}`
/** Text safe in one markdown table cell: no pipe, no line break, at most 300 characters. */
const cell = (s: string): string =>
	s.replace(/\s+/g, " ").replace(/\|/g, "\\|").slice(0, 300)
const share = (n: number, d: number): string =>
	d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)} %`

/**
 * Markdown: one row per scene, variant, CNR and frequency error (the phases
 * and overs summed, `Failed` its points that failed), then one row per over
 * of every point (a failed point: one row with its error). headCut can be
 * negative (settle-replay: the call started on the replayed copy of the
 * over's head, before its key-up); the headers say so. Nominal is the length
 * the plan asked, Length the one sent.
 */
export function dvTable(points: readonly DvPoint[]): string {
	const groups = new Map<string, DvPoint[]>()
	for (const p of points) {
		const key = `${p.scene}|${p.variant}|${p.cnrDb}|${p.errorHz}`
		groups.set(key, [...(groups.get(key) ?? []), p])
	}
	const out = [
		"| Scene | Variant | CNR | Error | Failed | Overs | One call | Missed | Splits | Merged | headCut p50 / p90 ms (< 0: began on the settle-replay copy) | endErr p90 ms (TLC / none) | tFirst p90 ms | Frames checked | Signal exits |",
		"| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
	]
	for (const [key, ps] of groups) {
		const [scene, variant, cnr, err] = key.split("|") as [
			string,
			string,
			string,
			string,
		]
		const s = summarise(ps.flatMap(p => p.rows))
		const failed = ps.filter(p => p.error !== undefined).length
		// A decoder killed by a signal after its input (dsd-fme crashed at EOF):
		// its lines are kept, but the run is abnormal.
		const signalled = ps.filter(p => p.exit?.startsWith("SIG") === true).length
		out.push(
			`| ${scene} | ${variant} | ${cnr} dB | ${err} Hz | ${failed} | ${s.overs} | ${share(s.exactlyOne, s.overs)} | ${s.missed} | ${s.splits} | ${s.merged} | ${ms(s.headCutP50Ms)} / ${ms(s.headCutP90Ms)} | ${ms(s.endErrP90Ms)} / ${ms(s.endErrNoTermP90Ms)} | ${ms(s.tFirstP90Ms)} | ${share(s.framesChecked, s.framesSent)} | ${signalled} |`,
		)
	}
	out.push(
		"",
		"| Scene | Variant | CNR | Error | Phase | Over | Slot | Nominal ms | Length ms | Calls | Merged | headCut ms (< 0: began on the settle-replay copy) | endErr ms | tFirst ms | Frames | Note |",
		"| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
	)
	for (const p of points) {
		const at = `| ${p.scene} | ${p.variant} | ${p.cnrDb} dB | ${p.errorHz} Hz | ${p.phase} |`
		if (p.error !== undefined) {
			out.push(
				`${at} - | - | - | - | - | - | - | - | - | - | failed: ${cell(p.error)} |`,
			)
			continue
		}
		for (const r of p.rows) {
			const note = [
				r.missed ? `missed (held ${Math.round(r.heldMs)} ms)` : "",
				p.exit === undefined ? "" : cell(p.exit),
			]
				.filter(n => n !== "")
				.join("; ")
			out.push(
				`${at} ${r.index} | ${r.slot ?? "-"} | ${r.nominalMs === null ? "-" : Math.round(r.nominalMs)} | ${Math.round(r.durationMs)} | ${r.calls} | ${r.merged ? "yes" : "no"} | ${ms(r.headCutMs)} | ${ms(r.endErrMs)} | ${ms(r.tFirstMs)} | ${r.framesChecked}/${r.framesSent}${r.terminator ? "" : " (no TLC)"} | ${note} |`,
			)
		}
	}
	return out.join("\n")
}
