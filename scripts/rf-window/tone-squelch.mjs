#!/usr/bin/env node
// RF window (WG7 MA.4): tone squelch gate on real RF. Sets live audio `toneSquelch`, logs
// `status.toneSquelch.state` transitions and live-audio:transmission events, restores the
// previous toneSquelch. The gate mutes audio only: every transmission is still an event.
import {
	UsageError,
	apiBaseUrl,
	classifyTone,
	formatTone,
	liveAudioPatchProblems,
	parseArgs,
	parseTone,
	restorePatch,
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

const usage = `Usage: node scripts/rf-window/tone-squelch.mjs --host HOST [--run | --apply --tone TONE]
       [--seconds 120] [--poll-ms 500]

TONE: ctcss:<Hz> (a standard tone, e.g. ctcss:100.0), dcs:<octal>[N|I] (e.g. dcs:023N).
Without --run or --apply: prints the plan and touches nothing (dry run).
--run    read-only: logs the configured gate's state and transmissions.
--apply  sets toneSquelch (PATCH /api/live-audio/config; NFM only), then restores the
         previous value (absent = {"kind":"none"}) at the end or on Ctrl-C.
Key the handheld with the matching tone, then with another tone or none.`

const spec = {
	tone: { type: "string" },
	seconds: { type: "number", default: 120, min: 5, max: 1800 },
	"poll-ms": { type: "number", default: 500, min: 100, max: 5000, int: true },
}

function parse(argv) {
	const args = parseArgs(argv, spec)
	if (args.help === true) return args
	args.base = apiBaseUrl(args.host)
	args.toneValue = args.tone === undefined ? undefined : parseTone(args.tone)
	if (args.mode === "apply" && args.toneValue === undefined)
		throw new UsageError("--apply needs --tone")
	if (args.mode === "run" && args.toneValue !== undefined)
		throw new UsageError("--tone changes the config: it needs --apply")
	return args
}

async function main(args) {
	if (args.mode === "dry-run") {
		emit("plan", {
			script: "tone-squelch",
			api: args.base,
			reads: ["GET /api/live-audio/status (polled)", "/ws live-audio"],
			writes: args.toneValue
				? [
						`PATCH /api/live-audio/config {"toneSquelch":${JSON.stringify(args.toneValue)}}`,
					]
				: [],
			restore: args.toneValue
				? "previous toneSquelch (absent = none)"
				: "nothing changed",
			seconds: args.seconds,
			note: "dry run: nothing was sent; add --run (read-only) or --apply --tone",
		})
		return 0
	}
	const signal = interruptSignal()
	const status = await api(args.base, "GET", "/api/live-audio/status")
	if (status.running !== true) throw new Error("Live audio is not running")
	const previous = status.config
	const tone = args.toneValue ?? previous.toneSquelch ?? { kind: "none" }
	if (args.mode === "apply") {
		const problems = liveAudioPatchProblems(previous, { toneSquelch: tone })
		if (problems.length > 0) throw new Error(problems.join("; "))
	}
	emit("start", {
		sourceId: status.sourceId,
		modulation: previous.modulation,
		previousTone: formatTone(previous.toneSquelch),
		tone: formatTone(tone),
	})
	const transmissions = []
	const opens = new Map()
	let gateState = null
	let gateChangedAt = null
	const gateOpenDelays = []
	let changed = false
	let socket = null
	try {
		if (args.mode === "apply") {
			await api(args.base, "PATCH", "/api/live-audio/config", {
				toneSquelch: tone,
			})
			changed = true
		}
		socket = await openSocket(
			wsUrl(args.base),
			{ type: "subscribe", channels: ["live-audio"] },
			(msg, at) => {
				if (msg.type !== "live-audio:transmission") return
				const data = msg.data
				if (data.state === "open") opens.set(data.transmissionId, at)
				else {
					const result = classifyTone(tone, data.tone)
					transmissions.push({ ...data, toneResult: result })
					emit("transmission", {
						id: data.transmissionId,
						durationMs: data.durationMs,
						closeReason: data.closeReason,
						tone: data.tone,
						vsGate: result,
					})
				}
			},
		)
		const end = performance.now() + args.seconds * 1000
		while (!signal.aborted && performance.now() < end) {
			const now = await api(args.base, "GET", "/api/live-audio/status")
			const state = now.toneSquelch?.state ?? "absent"
			const at = performance.now()
			if (state !== gateState) {
				// Delay from the latest open transmission to the gate opening (poll-limited).
				if (state === "open") {
					const lastOpen = Math.max(0, ...opens.values())
					if (lastOpen > 0) gateOpenDelays.push(at - lastOpen)
				}
				emit("gate", {
					state,
					previous: gateState,
					squelchOpen: now.squelchOpen,
				})
				gateState = state
				gateChangedAt = at
			}
			await sleep(args["poll-ms"], signal)
		}
	} finally {
		socket?.close()
		if (changed) {
			const { body } = restorePatch(previous, { toneSquelch: true })
			await api(args.base, "PATCH", "/api/live-audio/config", body)
			emit("restored", { body })
		}
	}
	const byResult = transmissions.reduce((acc, t) => {
		acc[t.toneResult] = (acc[t.toneResult] ?? 0) + 1
		return acc
	}, {})
	emit("done", {
		tone: formatTone(tone),
		transmissionsClosed: transmissions.length,
		byToneResult: byResult,
		gateOpenDelayMs: summarize(gateOpenDelays),
		pollMs: args["poll-ms"],
		lastGateState: gateState,
		lastGateChangeAgoMs:
			gateChangedAt === null ? null : performance.now() - gateChangedAt,
	})
	return 0
}

runMain(usage, parse, main)
