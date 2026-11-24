#!/usr/bin/env node
// Runs one test file N times in a row while W synthetic CPU hogs load the host, to show
// whether the test is deterministic under load.
//
//   node scripts/flake-under-load.mjs <test> [runs=20] [hogs=4] [--hog-deadline-s=1800] [-- <extra args>]
//
// <test> is a vitest path (run with `pnpm exec vitest run <path> --maxWorkers=1`) or
// `cargo:<name>[@<test target>]`, run as `cargo test [--test <target>] <name>` in
// native/wavekit-chan. Extra args after `--` go to the test command.
//
// Each hog is a child `node -e` busy loop that exits on its own at a hard deadline, so a
// killed harness can never leave one behind. The harness stops the hogs by their recorded
// PIDs only, on finish, on SIGINT/SIGTERM and on exit.

import { spawn, spawnSync } from "node:child_process"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

function usage(message) {
	if (message) process.stderr.write(`${message}\n`)
	process.stderr.write(
		"usage: node scripts/flake-under-load.mjs <vitest path | cargo:<name>[@<target>]> [runs=20] [hogs=4] [--hog-deadline-s=1800] [-- <extra args>]\n",
	)
	process.exit(2)
}

const argv = process.argv.slice(2)
const dashdash = argv.indexOf("--")
const extra = dashdash === -1 ? [] : argv.slice(dashdash + 1)
const own = dashdash === -1 ? argv : argv.slice(0, dashdash)
let hogDeadlineS = 1800
const positional = []
for (const a of own) {
	if (a.startsWith("--hog-deadline-s="))
		hogDeadlineS = Number(a.slice("--hog-deadline-s=".length))
	else if (a === "-h" || a === "--help") usage()
	else positional.push(a)
}
const [test, runsArg = "20", hogsArg = "4"] = positional
if (test === undefined) usage("missing test")
const runs = Number(runsArg)
const hogs = Number(hogsArg)
if (!Number.isInteger(runs) || runs < 1 || runs > 500)
	usage("runs must be an integer 1..500")
if (!Number.isInteger(hogs) || hogs < 0 || hogs > 64)
	usage("hogs must be an integer 0..64")
if (!Number.isFinite(hogDeadlineS) || hogDeadlineS < 1 || hogDeadlineS > 7200)
	usage("--hog-deadline-s must be 1..7200")

function command() {
	if (test.startsWith("cargo:")) {
		const [name, target] = test.slice("cargo:".length).split("@")
		if (!name) usage("cargo: needs a test name")
		const args = ["test"]
		if (target) args.push("--test", target)
		args.push(name, ...extra)
		return {
			cmd: "cargo",
			args,
			cwd: path.join(repo, "native", "wavekit-chan"),
		}
	}
	return {
		cmd: "pnpm",
		args: ["exec", "vitest", "run", test, "--maxWorkers=1", ...extra],
		cwd: repo,
	}
}

const load = () =>
	os
		.loadavg()
		.map(x => x.toFixed(1))
		.join(" ")

// The hog: a pure busy loop with its own deadline (it also exits if its parent goes away).
const hogSource = `
const end = Date.now() + Number(process.argv[1]) * 1000
const parent = process.ppid
let x = 0
for (;;) {
	for (let i = 0; i < 5e6; i++) x = (x * 1103515245 + 12345) % 2147483648
	if (Date.now() > end) process.exit(0)
	try { process.kill(parent, 0) } catch { process.exit(0) }
}
`

const hogPids = []
function startHogs() {
	for (let i = 0; i < hogs; i++) {
		const child = spawn(
			process.execPath,
			["-e", hogSource, String(hogDeadlineS)],
			{
				stdio: "ignore",
			},
		)
		if (child.pid !== undefined) hogPids.push(child.pid)
		child.on("error", () => {})
	}
}
let stopped = false
// Kill by recorded PID only. spawnSync below blocks the event loop, so an exited hog
// stays an unreaped zombie and its PID cannot be reused before stopHogs runs.
function stopHogs() {
	if (stopped) return
	stopped = true
	for (const pid of hogPids) {
		try {
			process.kill(pid, "SIGKILL")
		} catch {
			// already gone
		}
	}
}
process.on("exit", stopHogs)
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
	process.on(sig, () => {
		stopHogs()
		process.exit(130)
	})
}

const { cmd, args, cwd } = command()
process.stdout.write(`flake-under-load: ${cmd} ${args.join(" ")}\n`)
process.stdout.write(`runs ${runs}, hogs ${hogs}, load at start ${load()}\n`)
startHogs()
process.stdout.write(`hog pids: ${hogPids.join(" ") || "none"}\n`)

let pass = 0
let fail = 0
const failures = []
const started = Date.now()
for (let i = 1; i <= runs; i++) {
	const t0 = Date.now()
	// Hogs exit on their own at the deadline: a run starting after it is not under load.
	if (hogs > 0 && t0 - started >= hogDeadlineS * 1000) {
		process.stdout.write(
			`run ${i}: hog deadline (${hogDeadlineS} s) passed, stopping: later runs would be unloaded\n`,
		)
		break
	}
	const r = spawnSync(cmd, args, {
		cwd,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	})
	const s = ((Date.now() - t0) / 1000).toFixed(1)
	if (r.status === 0) {
		pass++
		process.stdout.write(`run ${i}: pass ${s} s (load ${load()})\n`)
	} else {
		fail++
		const tail = `${r.stdout ?? ""}${r.stderr ?? ""}`
			.split("\n")
			.slice(-40)
			.join("\n")
		failures.push({ run: i, tail })
		process.stdout.write(
			`run ${i}: FAIL exit ${r.status ?? r.signal} ${s} s (load ${load()})\n`,
		)
	}
}
stopHogs()
for (const f of failures)
	process.stdout.write(`\n--- run ${f.run} output tail ---\n${f.tail}\n`)
process.stdout.write(
	`\nresult: ${pass}/${pass + fail} passed (of ${runs} asked), ${fail} failed, ${((Date.now() - started) / 1000).toFixed(0)} s, load at end ${load()}\n`,
)
process.exit(fail === 0 ? 0 : 1)
