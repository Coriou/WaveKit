#!/usr/bin/env node
// The in-job half of the remote check, run by .github/workflows/ci-remote.yml. It always exits 0;
// the result is verdict.json, uploaded as the job's artifact and read by scripts/remote-check.mjs.
//
//   node scripts/remote-check-job.mjs verdict <step...>        verdict from the steps step.sh recorded
//   node scripts/remote-check-job.mjs root <shard> <step...>   also run this shard of the root tests:
//                                                              files packed by weight, failed files rerun once together
//
// <step...> are the step names expected in $RUNNER_TEMP/verdict-steps; a missing one counts as -1.
// A failed step's last lines ($RUNNER_TEMP/step-<name>.log, trimmed by tailLines) go in `tail`.
// A failed setup step (SETUP_STEPS in remote-check-lib.mjs) sets `infra`: the client reruns the job
// once instead of reporting a failure. This script is the one place that classifies a failed
// install or shared build, by its whole log (codeCaused): a lockfile, manifest or TypeScript error
// is the checked code's and leaves `infra` unset, so `ok: false` is a failure; anything else is
// INFRA.
//
// Time budget of a root job (timeout-minutes 25 = 1500 s), counted from its "Start verdict" step:
// the setup steps end by 600 s (step.sh, VERDICT_STEPS_S) and this script by VERDICT_END_S =
// 1260 s: the shard run gets everything up to 1260 - RERUN_S = 1080 s, the one rerun of at most
// 10 failed files the last 180 s. 1260 s plus the artifact upload (under 60 s) ends 3 minutes
// before the job timeout, so a verdict is always written.

import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import {
	classifyShard,
	packShards,
	parseVitestReport,
	setupFailure,
	SHARDS,
	tailLines,
} from "./remote-check-lib.mjs"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const runnerTemp = process.env["RUNNER_TEMP"] ?? tmpdir()
const RERUN_S = 180
const MAX_RERUN_FILES = 10

/** @param {string} name */
function readOr(name, fallback = "") {
	try {
		return readFileSync(join(runnerTemp, name), "utf8")
	} catch {
		return fallback
	}
}

const startedAt = Number(readOr("verdict-start").trim()) * 1000 || Date.now()
const deadline = startedAt + Number(process.env["VERDICT_END_S"] ?? 1260) * 1000

/** @param {string[]} expected */
function recordedSteps(expected) {
	/** @type {Record<string, number>} */
	const steps = {}
	for (const line of readOr("verdict-steps").split("\n")) {
		const [name, code] = line.split("\t")
		if (name) steps[name] = Number(code)
	}
	for (const name of expected) steps[name] ??= -1
	return steps
}

/**
 * Runs vitest on `files` with the JSON reporter until `until`; report undefined when it wrote none.
 * @param {string[]} files
 * @param {string} out
 * @param {number} until
 * @param {string[]} [extra]
 */
function vitest(files, out, until, extra = []) {
	const r = spawnSync(
		"pnpm",
		[
			"exec",
			"vitest",
			"run",
			...extra,
			"--reporter=default",
			"--reporter=json",
			`--outputFile.json=${out}`,
			...files,
		],
		{
			cwd: root,
			stdio: ["ignore", "inherit", "inherit"],
			timeout: Math.max(10_000, until - Date.now()),
			killSignal: "SIGKILL",
		},
	)
	const code = r.status ?? -1
	if (!existsSync(out)) return { code, report: undefined }
	try {
		return {
			code,
			report: parseVitestReport(JSON.parse(readFileSync(out, "utf8")), root),
		}
	} catch {
		return { code, report: undefined }
	}
}

function listFiles() {
	const r = spawnSync(
		"pnpm",
		["exec", "vitest", "list", "--filesOnly", "--json"],
		{ cwd: root, encoding: "utf8", maxBuffer: 64 << 20 },
	)
	const list = /** @type {{ file: string }[]} */ (JSON.parse(r.stdout))
	return list.map(x =>
		x.file.startsWith(`${root}/`) ? x.file.slice(root.length + 1) : x.file,
	)
}

/** @param {string} file @param {string} message */
const entry = (file, message) => ({ file, test: "", message })

/** @param {number} shard */
function runShard(shard) {
	/** @type {{ files?: Record<string, number> }} */
	const table = JSON.parse(
		readFileSync(join(root, "scripts/remote-check-durations.json"), "utf8"),
	)
	const bin = packShards(listFiles(), table.files ?? {})[shard - 1]
	const files = bin?.files ?? []
	console.log(
		`shard ${shard}/${SHARDS}: ${files.length} files, weight ${bin?.weight ?? 0}, expected ${bin?.cost ?? 0}s`,
	)
	if (files.length === 0)
		return { code: 0, failed: [], flaky: [], durations: {} }
	const dir = mkdtempSync(join(runnerTemp, "rc-"))
	const first = vitest(files, join(dir, "main.json"), deadline - RERUN_S * 1000)
	if (!first.report)
		return {
			code: 1,
			failed: [
				entry(
					`shard ${shard}`,
					`vitest wrote no report (exit ${first.code}, timeout or crash)`,
				),
			],
			flaky: [],
			durations: {},
		}
	/** @type {Record<string, number>} */
	const durations = {}
	for (const [f, r] of first.report) durations[f] = r.seconds
	// Failed files are rerun once, together and serially; more than 10 are all real failures.
	const bad = [...first.report].filter(([, r]) => !r.ok).map(([f]) => f)
	let reruns
	if (bad.length > 0 && bad.length <= MAX_RERUN_FILES) {
		console.log(`rerunning ${bad.length} failed file(s)`)
		reruns = new Map(
			vitest(bad, join(dir, "rerun.json"), deadline, ["--maxWorkers=1"]).report,
		)
	}
	const { failed, flaky } = classifyShard(first.report, reruns)
	// A non-zero exit without a failed test is an unhandled error vitest reports only in its log.
	if (first.code !== 0 && bad.length === 0)
		failed.push(
			entry(
				`shard ${shard}`,
				`vitest exited ${first.code} with no failed test; see the job log`,
			),
		)
	return { code: failed.length ? 1 : 0, failed, flaky, durations }
}

function main() {
	const [mode, ...rest] = process.argv.slice(2)
	const shard = mode === "root" ? Number(rest.shift()) : undefined
	const steps = recordedSteps(rest)
	/** @type {Record<string, unknown>} */
	const verdict = { job: process.env["VERDICT_JOB"] ?? mode ?? "job" }
	let failed = /** @type {unknown[]} */ ([])
	let flaky = /** @type {unknown[]} */ ([])
	if (shard !== undefined) {
		verdict["shard"] = shard
		if (Object.values(steps).every(c => c === 0)) {
			try {
				const r = runShard(shard)
				steps["root-tests"] = r.code
				failed = r.failed
				flaky = r.flaky
				verdict["durations"] = r.durations
			} catch (e) {
				steps["root-tests"] = 1
				failed = [
					entry(
						`shard ${shard}`,
						`job script error: ${String(e).slice(0, 200)}`,
					),
				]
			}
		} else steps["root-tests"] = -1
	}
	// The end of each failed step's output (step.sh writes it to $RUNNER_TEMP/step-<name>.log).
	/** @type {Record<string, string[]>} */
	const tail = {}
	for (const [name, code] of Object.entries(steps)) {
		if (code === 0 || name === "root-tests") continue
		const lines = tailLines(readOr(`step-${name}.log`))
		if (lines.length) tail[name] = lines
	}
	Object.assign(verdict, {
		ok: Object.values(steps).every(c => c === 0) && failed.length === 0,
		infra: setupFailure(steps, n => readOr(`step-${n}.log`)) !== undefined,
		seconds: Math.round((Date.now() - startedAt) / 1000),
		steps,
		failed,
		flaky,
		tail,
	})
	verdict["durations"] ??= {}
	writeFileSync(join(root, "verdict.json"), JSON.stringify(verdict))
	console.log(JSON.stringify({ ...verdict, durations: undefined }))
}

main()
