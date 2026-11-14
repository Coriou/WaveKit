/**
 * `scanner-quality --truth <dir|synthetic>`: the truth scorecard. Runs the synthetic truth
 * scenes (truth-scenes.ts) and every labelled capture of `<dir>` (truth-labels.ts) through the
 * scanner with the analog recorder in the loop (truth-run.ts), scores them (truth-score.ts),
 * prints the scorecard as one JSON line and then one human line, and exits 1 when a total is
 * above the checked-in limits (truth-thresholds.json), 2 on bad arguments or labels.
 *
 *   --truth <dir>         labelled captures (`*.truth.json`); `synthetic` runs the scenes only
 *   --synthetic on|off    run the synthetic scenes too (default on)
 *   --thresholds <file>   limits (default scripts/bench/scanner-quality/truth-thresholds.json)
 *   --out <file>          also write the scorecard JSON there
 *   --only <a,b>          only the named cases
 *   --unconfirmed         score unconfirmed labels too (proposals nobody checked yet)
 *   --separate            run each capture with a fresh scanner state (default: the captures run
 *                         in name order as one session: each starts at its real offset from the
 *                         first on the virtual clock, with the state the ones before it left,
 *                         as a restarted core continues its discovery store)
 */
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import process from "node:process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { T0_MS } from "./harness.js"
import {
	SESSION_MIN_GAP_MS,
	captureCase,
	runTruthCase,
	type TruthCase,
} from "./truth-run.js"
import { loadTruthDir, parseThresholds } from "./truth-labels.js"
import { syntheticCases } from "./truth-scenes.js"
import {
	formatScorecardLine,
	scoreCase,
	scorecard,
	type CaseScore,
} from "./truth-score.js"

export const DEFAULT_THRESHOLDS =
	"scripts/bench/scanner-quality/truth-thresholds.json"

export class TruthArgsError extends Error {}

export interface TruthOptions {
	truth: string
	synthetic: boolean
	thresholds: string
	out: string | null
	only: readonly string[] | null
	unconfirmed: boolean
	separate: boolean
}

export function parseTruthArgs(argv: readonly string[]): TruthOptions {
	const arg = (name: string): string | undefined => {
		const i = argv.indexOf(`--${name}`)
		if (i < 0) return undefined
		const v = argv[i + 1]
		if (v === undefined || v.startsWith("--"))
			throw new TruthArgsError(`--${name} needs a value`)
		return v
	}
	const truth = arg("truth")
	if (truth === undefined) throw new TruthArgsError("--truth needs a value")
	const synthetic = arg("synthetic") ?? "on"
	if (synthetic !== "on" && synthetic !== "off")
		throw new TruthArgsError("--synthetic is on or off")
	const only = arg("only")
	return {
		truth,
		synthetic: synthetic === "on" || truth === "synthetic",
		thresholds: arg("thresholds") ?? DEFAULT_THRESHOLDS,
		out: arg("out") ?? null,
		only: only === undefined ? null : only.split(",").filter(Boolean),
		unconfirmed: argv.includes("--unconfirmed"),
		separate: argv.includes("--separate"),
	}
}

/** The cases to run: the synthetic scenes, then the labelled captures in name order. */
export function truthCases(o: TruthOptions): TruthCase[] {
	const cases: TruthCase[] = o.synthetic ? syntheticCases() : []
	if (o.truth !== "synthetic")
		for (const t of loadTruthDir(o.truth))
			cases.push(
				captureCase({
					name: t.name,
					path: t.capturePath,
					rateHz: t.truth.rateHz,
					centreHz: t.truth.centreHz,
					durationMs: t.truth.durationMs,
					startedAtMs:
						t.truth.startedAt === undefined
							? null
							: Date.parse(t.truth.startedAt),
					complete: t.truth.complete,
					intervals: t.truth.intervals.filter(
						iv => o.unconfirmed || iv.confirmed,
					),
					decodes: t.truth.decodes,
				}),
			)
	if (o.only === null) return cases
	const unknown = o.only.filter(n => !cases.some(c => c.name === n))
	if (unknown.length > 0)
		throw new TruthArgsError(`--only names no case: ${unknown.join(", ")}`)
	return cases.filter(c => o.only!.includes(c.name))
}

/** Runs the scorecard; resolves with the exit code (0 pass, 1 worse than the limits). */
export async function runTruthCli(argv: readonly string[]): Promise<number> {
	let o: TruthOptions
	let cases: TruthCase[]
	let limits: ReturnType<typeof parseThresholds>
	try {
		o = parseTruthArgs(argv)
		limits = parseThresholds(
			o.thresholds,
			readFileSync(resolve(o.thresholds), "utf8"),
		)
		cases = truthCases(o)
	} catch (err: unknown) {
		process.stderr.write(
			`${err instanceof Error ? err.message : String(err)}\n`,
		)
		return 2
	}
	const scores: CaseScore[] = []
	let iq = 0
	let wall = 0
	// The session's state directory (captures only; the synthetic scenes each start fresh).
	const stateDir = o.separate
		? null
		: mkdtempSync(join(tmpdir(), "wk-truth-session-"))
	let firstStart: number | null = null
	let nextT0 = T0_MS
	try {
		for (const c of cases) {
			let session: { stateDir: string; t0Ms: number } | undefined
			if (stateDir !== null && c.kind === "capture") {
				const at = c.startedAtMs ?? null
				firstStart ??= at
				// Its real offset from the first capture, never before the previous run ended.
				const t0 =
					at !== null && firstStart !== null
						? Math.max(nextT0, T0_MS + (at - firstStart))
						: nextT0
				session = { stateDir, t0Ms: t0 }
			}
			const run = await runTruthCase(c, session)
			if (session)
				nextT0 = session.t0Ms + run.iqSeconds * 1000 + SESSION_MIN_GAP_MS
			iq += run.iqSeconds
			wall += run.wallSeconds
			const s = scoreCase(c, run)
			scores.push(s)
			const t = s.totals
			process.stderr.write(
				`  ${c.name}: kept ${t.keptFiles}, false voice ${t.falseVoice}, missed voice ${t.missedVoice}/${t.voiceTransmissions}, identify ${t.identifyRight}/${t.labelledSignals} (${run.wallSeconds.toFixed(1)} s)\n`,
			)
		}
	} finally {
		if (stateDir !== null) rmSync(stateDir, { recursive: true, force: true })
	}
	const card = scorecard(scores, limits)
	const json = JSON.stringify(card)
	if (o.out !== null) writeFileSync(o.out, `${json}\n`)
	process.stderr.write(
		`  ${iq.toFixed(0)} s of IQ in ${wall.toFixed(0)} s of wall time\n`,
	)
	process.stdout.write(`${json}\n${formatScorecardLine(card)}\n`)
	return card.pass ? 0 : 1
}
