#!/usr/bin/env node
// RF window (WG7 MA.4): REST drag-to-tune latency, the precondition for WS tuner control.
// N retunes through POST /api/tuner/:sourceId/frequency, alternately centre + step and
// centre - step; for each, the time from sending the command to the first spectrum:frame
// whose centre is the new one. Restores the starting centre at the end or on Ctrl-C.
import {
	UsageError,
	apiBaseUrl,
	frameAtCentre,
	parseArgs,
	retuneTargets,
	summarize,
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

const usage = `Usage: node scripts/rf-window/tune-latency.mjs --host HOST [--run | --apply]
       [--source ID] [--count 20] [--step-hz 100000] [--interval-ms 1000] [--timeout-ms 3000]

Without --run or --apply: prints the plan and touches nothing (dry run).
--run    read-only: reads the tuner state and the spectrum frames, retunes nothing.
--apply  retunes --count times (POST /api/tuner/:sourceId/frequency), then restores the
         starting frequency. Refused unless the tuner's controlMode is "internal" and the
         latest frame's centre equals the tuner frequency (nobody else is driving it).`

const spec = {
	source: { type: "string" },
	count: { type: "number", default: 20, min: 1, max: 200, int: true },
	"step-hz": {
		type: "number",
		default: 100_000,
		min: 1_000,
		max: 5_000_000,
		int: true,
	},
	"interval-ms": {
		type: "number",
		default: 1_000,
		min: 200,
		max: 60_000,
		int: true,
	},
	"timeout-ms": {
		type: "number",
		default: 3_000,
		min: 500,
		max: 30_000,
		int: true,
	},
}

function parse(argv) {
	const args = parseArgs(argv, spec)
	if (args.help === true) return args
	args.base = apiBaseUrl(args.host)
	if (args.source !== undefined && !/^[A-Za-z0-9_.:-]{1,64}$/.test(args.source))
		throw new UsageError("--source is not a source id")
	return args
}

async function main(args) {
	if (args.mode === "dry-run") {
		emit("plan", {
			script: "tune-latency",
			api: args.base,
			reads: [
				"GET /api/tuner[/:sourceId]",
				"/ws spectrum (25 Hz x 512 on the source)",
			],
			writes: [
				`${args.count} x POST /api/tuner/${args.source ?? "<source>"}/frequency (centre +/- ${args["step-hz"]} Hz)`,
			],
			restore: "starting frequency",
			note: "dry run: nothing was sent; add --run (read-only) or --apply",
		})
		return 0
	}
	const signal = interruptSignal()
	const tuners = await api(args.base, "GET", "/api/tuner")
	const tuner =
		args.source === undefined
			? tuners[0]
			: tuners.find(t => t.sourceId === args.source)
	if (tuner === undefined) throw new Error("No such rtl_tcp tuner")
	const sourceId = tuner.sourceId
	const startHz = tuner.frequency
	let latest = null
	const waiters = new Set()
	const socket = await openSocket(
		wsUrl(args.base),
		{
			type: "subscribe",
			channels: ["spectrum"],
			options: { spectrum: { sourceId, hz: 25, bins: 512 } },
		},
		(msg, at) => {
			if (msg.type !== "spectrum:frame" || msg.data?.sourceId !== sourceId)
				return
			latest = msg.data
			for (const waiter of waiters) waiter(msg.data, at)
		},
	)
	const results = []
	let moved = false
	try {
		const deadline = performance.now() + 5_000
		while (latest === null && performance.now() < deadline && !signal.aborted)
			await sleep(50, signal)
		emit("start", {
			sourceId,
			controlMode: tuner.controlMode,
			frequency: startHz,
			sampleRate: tuner.sampleRate,
			declaredOnlyFields: tuner.declaredOnlyFields ?? [],
			frameCentreHz: latest?.centerHz ?? null,
			frameTuningTrust: latest?.tuningTrust ?? null,
		})
		if (args.mode !== "apply") return 0
		if (tuner.controlMode !== "internal")
			throw new Error(
				`controlMode is ${tuner.controlMode}: someone else drives the tuner`,
			)
		if (latest === null) throw new Error("No spectrum frame within 5 s")
		if (latest.centerHz !== startHz)
			throw new Error(
				`Frame centre ${latest.centerHz} differs from the tuner frequency ${startHz}`,
			)
		for (const target of retuneTargets(startHz, args["step-hz"], args.count)) {
			if (signal.aborted) break
			let resolveFrame
			const seen = new Promise(resolve => (resolveFrame = resolve))
			const waiter = (frame, at) => {
				if (frameAtCentre(frame, sourceId, target)) resolveFrame({ frame, at })
			}
			waiters.add(waiter)
			const sentAt = performance.now()
			moved = true
			await api(
				args.base,
				"POST",
				`/api/tuner/${encodeURIComponent(sourceId)}/frequency`,
				{
					hz: target,
				},
			)
			const answeredAt = performance.now()
			const timeout = sleep(args["timeout-ms"], signal).then(() => null)
			const hit = await Promise.race([seen, timeout])
			waiters.delete(waiter)
			const result = {
				targetHz: target,
				restMs: answeredAt - sentAt,
				frameMs: hit === null ? null : hit.at - sentAt,
				tuningTrust: hit?.frame.tuningTrust ?? null,
				epoch: hit?.frame.epoch ?? null,
			}
			results.push(result)
			emit("retune", result)
			await sleep(args["interval-ms"], signal)
		}
	} finally {
		socket.close()
		if (moved) {
			await api(
				args.base,
				"POST",
				`/api/tuner/${encodeURIComponent(sourceId)}/frequency`,
				{
					hz: startHz,
				},
			)
			emit("restored", { sourceId, frequency: startHz })
		}
	}
	if (args.mode === "apply")
		emit("done", {
			sourceId,
			retunes: results.length,
			missed: results.filter(r => r.frameMs === null).length,
			restMs: summarize(results.map(r => r.restMs)),
			commandToFrameMs: summarize(
				results.filter(r => r.frameMs !== null).map(r => r.frameMs),
			),
			trust: results.reduce((acc, r) => {
				acc[r.tuningTrust ?? "missed"] =
					(acc[r.tuningTrust ?? "missed"] ?? 0) + 1
				return acc
			}, {}),
		})
	return 0
}

runMain(usage, parse, main)
