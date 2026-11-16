/**
 * Truth scorecard: digital voice scenes. Each scene is a transmission plan's
 * overs (scripts/fixtures/dv-plan.mjs, labelled `digital-voice` with their
 * protocol and slot) and the decoder lines a dsd-fme printed for it, with
 * their times (tests/mocks/fixtures/synthetic/dv-latency-<scene>.json). The
 * decoder double replays those lines through the production adapter on a fake
 * clock (dv-replay.ts), so the call lifecycle scored is the code under test
 * and the line latency is the recorded one, not the 1 s flat answer of the
 * scanner scenes' doubles.
 *
 * A seed file marked `provisional` was modelled, not recorded
 * (scripts/fixtures/dv-latency-seeds.mjs); the in-image capture baseline
 * (tests/integration/dv-capture.test.ts, WAVEKIT_DVCAP_LINES) replaces it.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { falseCalls, scoreOvers, type DvOverScore } from "./dv-metrics.js"
import { DV_MODES, checkedLine, replayDvLines } from "./dv-replay.js"
import { DV_LABEL_PROTOCOLS, type TruthInterval } from "./truth-labels.js"
import type { CaseScore } from "./truth-score.js"

/** Where the seeds live (relative to the checkout the scorecard runs from). */
export const DV_SEED_DIR = "tests/mocks/fixtures/synthetic"
export const DV_SEED_PREFIX = "dv-latency-"

const ms = z.number().finite()
const SeedSchema = z
	.object({
		version: z.literal(1),
		provisional: z.boolean(),
		note: z.string().max(400),
		scene: z
			.string()
			.regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
			.max(64),
		protocol: z.enum(DV_LABEL_PROTOCOLS),
		frequencyHz: z.number().finite().positive(),
		overs: z
			.array(
				z
					.object({
						index: z.number().int().nonnegative(),
						protocol: z.enum(DV_LABEL_PROTOCOLS),
						slot: z.union([z.literal(1), z.literal(2), z.null()]),
						startMs: ms,
						endMs: ms,
						frames: z.number().int().nonnegative(),
						terminator: z.boolean(),
						clear: z.boolean(),
						ids: z.record(z.string(), z.union([z.string(), z.number()])),
						/** The length the plan asked (dv-plan.mjs SentOver nominalMs). */
						nominalMs: ms.positive().optional(),
					})
					.strict()
					.refine(o => o.endMs > o.startMs, "an over ends after it starts"),
			)
			// None: a scene of noise syncs only, scored by its false calls (dvFalse).
			.max(1000),
		lines: z
			.array(z.object({ atMs: ms, text: z.string().max(400) }).strict())
			.max(100_000),
	})
	.strict()
export type DvSeed = z.infer<typeof SeedSchema>

export interface DvCase {
	/** `dv-<scene>`: the name `--only` takes. */
	name: string
	seed: DvSeed
}

export function parseDvSeed(path: string, text: string): DvSeed {
	let json: unknown
	try {
		json = JSON.parse(text)
	} catch {
		throw new Error(`${path}: not JSON`)
	}
	const parsed = SeedSchema.safeParse(json)
	if (!parsed.success) {
		const issue = parsed.error.issues[0]
		throw new Error(
			`${path}: ${issue ? `${issue.path.join(".")} ${issue.message}` : "invalid"}`,
		)
	}
	return parsed.data
}

/**
 * Every seed of `dir`, by file name. Two seeds of one scene (so one case
 * name, which `--only` and the exceptions match by) fail the load.
 */
export function loadDvCases(dir = DV_SEED_DIR): DvCase[] {
	const files = new Map<string, string>()
	return readdirSync(dir)
		.filter(f => f.startsWith(DV_SEED_PREFIX) && f.endsWith(".json"))
		.sort()
		.map(f => {
			const seed = parseDvSeed(join(dir, f), readFileSync(join(dir, f), "utf8"))
			const name = `dv-${seed.scene}`
			const first = files.get(name)
			if (first !== undefined)
				throw new Error(
					`${join(dir, f)}: case ${name} is already ${first}'s: one seed per scene`,
				)
			files.set(name, f)
			return { name, seed }
		})
}

/** The overs as truth intervals (label digital-voice, protocol, slot). */
export function dvIntervals(c: DvCase): TruthInterval[] {
	return c.seed.overs.map(o => ({
		frequencyHz: c.seed.frequencyHz,
		startMs: o.startMs,
		endMs: o.endMs,
		label: "digital-voice" as const,
		source: "synthetic" as const,
		confirmed: true,
		protocol: o.protocol,
		...(o.slot === null ? {} : { slot: o.slot }),
	}))
}

/** Replays a scene's lines through the adapter and scores its overs. */
export function runDvCase(c: DvCase): DvOverScore[] {
	return runDvScene(c).rows
}

/** runDvCase, with the identity-less calls that hold no over (falseCalls). */
export function runDvScene(c: DvCase): {
	rows: DvOverScore[]
	dvFalse: number
} {
	const mode = DV_MODES[c.seed.protocol] ?? "auto"
	const calls = replayDvLines(c.seed.lines, mode)
	return {
		rows: scoreOvers(c.seed.overs, calls, c.seed.lines, checkedLine),
		dvFalse: falseCalls(c.seed.overs, calls).length,
	}
}

/**
 * A scene's case score: its DV rows only (no kept files, voice or identify:
 * the scene runs the decoder, not the scanner). `totals` is recounted by the
 * caller (scoreDvCase).
 */
export function dvCaseScore(
	c: DvCase,
	rows: DvOverScore[],
	dvFalse = 0,
): Omit<CaseScore, "totals"> {
	return {
		name: c.name,
		kind: "synthetic",
		kept: [],
		voice: [],
		identify: [],
		dv: rows,
		dvFalse,
		// No scanner, so nothing injected.
		decodes: {
			ambient: 0,
			skipped: 0,
			dropped: 0,
			replayTrials: 0,
			replayDecoded: 0,
			analogTrials: 0,
		},
		decisions: {},
	}
}
