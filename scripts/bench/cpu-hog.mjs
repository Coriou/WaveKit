#!/usr/bin/env node
// cpu-hog.mjs: one busy CPU for the main-thread budget harness's starvation runs (--hog).
//
//   node cpu-hog.mjs --parent <pid> --max-seconds <s>
//
// A tight integer arithmetic loop on the main thread with no I/O and no allocation; it is not
// niced (the harness spawns it straight from its own node, so it keeps the harness's priority). It
// installs no signal handler, so SIGTERM ends it at once; the harness stops every hog by the PID it
// recorded (SIGTERM, then SIGKILL after 2 s), never by name or pattern.
//
// It also ends itself, so a harness killed by SIGHUP or SIGKILL never leaves it running: once per
// outer iteration (well under a second) it exits when its parent changed (the parent died and it
// was reparented) or its hard lifetime (--max-seconds, the harness's settle + window + 30 s) ran
// out. The expected parent is --parent, else process.ppid read at start.
import { pathToFileURL } from "node:url"

/**
 * Whether a hog should end now: its parent is not the one it started under (reparented, or born
 * an orphan under PID 1), or it has outlived its cap. Pure, for the tests.
 *
 * @param {{ expectedParent: number, currentParent: number, startMs: number, nowMs: number, maxMs: number }} s
 * @returns {"parent" | "lifetime" | null}
 */
export function hogExitReason(s) {
	if (s.currentParent !== s.expectedParent || s.currentParent === 1)
		return "parent"
	if (s.nowMs - s.startMs >= s.maxMs) return "lifetime"
	return null
}

/**
 * The hog's options from its argv; null when they do not parse.
 *
 * @param {readonly string[]} argv
 * @param {number} ppid
 * @returns {{ expectedParent: number, maxMs: number } | null}
 */
export function parseHogArgs(argv, ppid) {
	let expectedParent = ppid
	let maxSeconds = 300
	for (let i = 0; i < argv.length; i += 2) {
		const v = Number(argv[i + 1])
		if (!Number.isFinite(v) || v <= 0) return null
		if (argv[i] === "--parent" && Number.isInteger(v)) expectedParent = v
		else if (argv[i] === "--max-seconds") maxSeconds = v
		else return null
	}
	return { expectedParent, maxMs: maxSeconds * 1000 }
}

function run() {
	const opts = parseHogArgs(process.argv.slice(2), process.ppid)
	if (opts === null) {
		process.stderr.write(
			"usage: cpu-hog.mjs [--parent <pid>] [--max-seconds <s>]\n",
		)
		process.exit(2)
	}
	const startMs = Date.now()
	let x = 1
	for (;;) {
		const reason = hogExitReason({
			expectedParent: opts.expectedParent,
			currentParent: process.ppid,
			startMs,
			nowMs: Date.now(),
			maxMs: opts.maxMs,
		})
		if (reason !== null) process.exit(reason === "parent" ? 3 : 0)
		for (let i = 0; i < 5_000_000; i++)
			x = (Math.imul(x, 1_103_515_245) + 12_345) | 0
		// Keeps the loop observable so it is not optimised away.
		if (x === 0x7fffffff) process.stdout.write("")
	}
}

if (
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(process.argv[1]).href
)
	run()
