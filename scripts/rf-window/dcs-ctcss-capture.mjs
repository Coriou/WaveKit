#!/usr/bin/env node
// RF window (WG7 MA.4): CTCSS / DCS detection on real RF. Read-only: collects the `tone`
// of closed live-audio:transmission events while a handheld with a known tone or code keys
// up, and compares each with the expected one (DCS inverted twins count as the same code).
import {
	UsageError,
	apiBaseUrl,
	classifyTone,
	formatTone,
	parseArgs,
	parseTone,
	summarize,
	summarizeTones,
	wsUrl,
} from "./lib.mjs"
import {
	api,
	emit,
	interruptSignal,
	openSocket,
	runMain,
	sleep,
} from "./client.mjs"

const usage = `Usage: node scripts/rf-window/dcs-ctcss-capture.mjs --host HOST --expect TONE [--run]
       [--seconds 300] [--count 20]

TONE: ctcss:<Hz> (e.g. ctcss:100.0), dcs:<octal>[N|I] (e.g. dcs:023N) or none.
Without --run: prints the plan and touches nothing (dry run). With --run: read-only
(GET status, /ws live-audio). Stops after --seconds or --count closed transmissions.
Transmissions need at least 0.75 s of audio for a tone result; key for 2 s or more.`

const spec = {
	expect: { type: "string" },
	seconds: { type: "number", default: 300, min: 5, max: 3600 },
	count: { type: "number", default: 20, min: 1, max: 1000, int: true },
}

function parse(argv) {
	const args = parseArgs(argv, spec)
	if (args.help === true) return args
	args.base = apiBaseUrl(args.host)
	if (args.mode === "apply")
		throw new UsageError("This script is read-only: use --run, not --apply")
	if (args.expect === undefined) throw new UsageError("--expect is required")
	args.expected = parseTone(args.expect)
	return args
}

async function main(args) {
	if (args.mode === "dry-run") {
		emit("plan", {
			script: "dcs-ctcss-capture",
			api: args.base,
			reads: ["GET /api/live-audio/status", "/ws live-audio"],
			writes: [],
			expect: formatTone(args.expected),
			seconds: args.seconds,
			count: args.count,
			note: "dry run: nothing was sent; add --run (read-only)",
		})
		return 0
	}
	const signal = interruptSignal()
	const status = await api(args.base, "GET", "/api/live-audio/status")
	if (status.running !== true) throw new Error("Live audio is not running")
	emit("start", {
		sourceId: status.sourceId,
		modulation: status.config.modulation,
		squelchMode: status.config.squelchMode ?? "manual",
		squelch: status.config.squelch,
		toneSquelch: formatTone(status.config.toneSquelch),
		expect: formatTone(args.expected),
	})
	const closed = []
	const socket = await openSocket(
		wsUrl(args.base),
		{ type: "subscribe", channels: ["live-audio"] },
		msg => {
			if (
				msg.type !== "live-audio:transmission" ||
				msg.data?.state !== "closed"
			)
				return
			closed.push(msg.data)
			emit("transmission", {
				id: msg.data.transmissionId,
				durationMs: msg.data.durationMs,
				closeReason: msg.data.closeReason,
				tone: msg.data.tone,
				result: classifyTone(args.expected, msg.data.tone),
			})
		},
	)
	try {
		const end = performance.now() + args.seconds * 1000
		while (
			!signal.aborted &&
			closed.length < args.count &&
			performance.now() < end
		)
			await sleep(250, signal)
	} finally {
		socket.close()
	}
	emit("done", {
		expect: formatTone(args.expected),
		...summarizeTones(args.expected, closed),
		durationMs: summarize(closed.map(t => t.durationMs)),
	})
	return 0
}

runMain(usage, parse, main)
