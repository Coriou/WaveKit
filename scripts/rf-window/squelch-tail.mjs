#!/usr/bin/env node
// RF window (WG7 MA.4): squelch noise tail per squelch mode. Records the live audio stream
// while someone keys and releases a handheld, finds each mute onset in the audio and
// measures the unmuted broadband noise just before it (the tail after carrier loss).
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
	SQUELCH_MODES,
	UsageError,
	apiBaseUrl,
	audioStreamUrl,
	decodePcm,
	findNoiseTails,
	liveAudioPatchProblems,
	parseArgs,
	restorePatch,
	summarize,
	tailBoundMs,
	wsUrl,
} from "./lib.mjs"
import {
	api,
	emit,
	interruptSignal,
	openSocket,
	recordAudio,
	runMain,
} from "./client.mjs"

const usage = `Usage: node scripts/rf-window/squelch-tail.mjs --host HOST [--run | --apply]
       [--modes manual,auto,noise] [--seconds 120] [--back-chain-ms 0] [--save-dir DIR]
       [--min-noise-rms 0.02] [--min-hf-ratio 0.9]

Without --run or --apply: prints the plan and touches nothing (dry run).
--run    read-only: records the current squelch mode only (GET status, /ws, audio stream).
--apply  also switches live audio to each --modes entry (PATCH /api/live-audio/config
         squelchMode) and restores the previous squelchMode at the end or on Ctrl-C.
Key and release a handheld on the live audio channel several times per mode.`

const spec = {
	modes: { type: "string" },
	seconds: { type: "number", default: 120, min: 10, max: 1800 },
	"back-chain-ms": { type: "number", default: 0, min: 0, max: 5000 },
	"save-dir": { type: "string" },
	"min-noise-rms": { type: "number", min: 0, max: 1 },
	"min-hf-ratio": { type: "number", min: 0, max: 2 },
}

function parse(argv) {
	const args = parseArgs(argv, spec)
	if (args.help === true) return args
	args.base = apiBaseUrl(args.host)
	args.modeList =
		args.modes === undefined ? null : args.modes.split(",").map(m => m.trim())
	for (const mode of args.modeList ?? [])
		if (!SQUELCH_MODES.includes(mode))
			throw new UsageError(`Unknown squelch mode ${mode}`)
	if (args.modeList !== null && args.mode === "run")
		throw new UsageError("--modes switches the squelch mode: it needs --apply")
	return args
}

async function main(args) {
	if (args.mode === "dry-run") {
		emit("plan", {
			script: "squelch-tail",
			api: args.base,
			reads: [
				"GET /api/live-audio/status",
				"/ws live-audio",
				"live audio /stream",
			],
			writes: args.modeList
				? args.modeList.map(
						m => `PATCH /api/live-audio/config {"squelchMode":"${m}"}`,
					)
				: [],
			restore: args.modeList
				? "previous squelchMode (absent = manual)"
				: "nothing changed",
			secondsPerMode: args.seconds,
			note: "dry run: nothing was sent; add --run (read-only) or --apply",
		})
		return 0
	}
	const signal = interruptSignal()
	const status = await api(args.base, "GET", "/api/live-audio/status")
	if (status.running !== true) throw new Error("Live audio is not running")
	const previous = status.config
	const current = previous.squelchMode ?? "manual"
	const modes = args.modeList ?? [current]
	const classifier = {
		...(args["min-noise-rms"] !== undefined
			? { minNoiseRms: args["min-noise-rms"] }
			: {}),
		...(args["min-hf-ratio"] !== undefined
			? { minHfRatio: args["min-hf-ratio"] }
			: {}),
	}
	emit("start", {
		sourceId: status.sourceId,
		modulation: previous.modulation,
		sourceIqSampleRate: status.sourceIqSampleRate,
		squelch: previous.squelch,
		squelchMode: current,
		modes,
	})
	for (const mode of modes) {
		const problems = liveAudioPatchProblems(previous, { squelchMode: mode })
		if (problems.length > 0) throw new Error(problems.join("; "))
	}
	let changed = false
	const results = []
	try {
		for (const mode of modes) {
			if (signal.aborted) break
			if (args.mode === "apply" && mode !== current) {
				await api(args.base, "PATCH", "/api/live-audio/config", {
					squelchMode: mode,
				})
				changed = true
			}
			const transmissions = []
			const socket = await openSocket(
				wsUrl(args.base),
				{ type: "subscribe", channels: ["live-audio"] },
				msg => {
					if (
						msg.type === "live-audio:transmission" &&
						msg.data?.state === "closed"
					)
						transmissions.push(msg.data)
				},
			)
			emit("recording", { mode, seconds: args.seconds })
			let audio
			try {
				audio = await recordAudio(
					audioStreamUrl(args.base, previous.httpPort),
					args.seconds,
					signal,
				)
			} finally {
				socket.close()
			}
			if (args["save-dir"] !== undefined) {
				await mkdir(args["save-dir"], { recursive: true })
				const file = join(
					args["save-dir"],
					`squelch-tail-${mode}-${Math.round(audio.sampleRate)}-${audio.format}.raw`,
				)
				await writeFile(file, audio.data)
				emit("saved", { mode, file })
			}
			const samples = decodePcm(audio.data, audio.format)
			const tails = findNoiseTails(samples, audio.sampleRate, classifier)
			const releases = tails.filter(t => t.after === "audio")
			// WG7 req 4.1 bounds manual and auto mode; noise mode is reported without one.
			const bound = mode === "noise" ? null : tailBoundMs(args["back-chain-ms"])
			const result = {
				mode,
				audioSeconds: samples.length / audio.sampleRate,
				releases: releases.length,
				tailMs: summarize(releases.map(t => t.tailMs)),
				boundMs: bound,
				overBound:
					bound === null ? null : releases.filter(t => t.tailMs > bound).length,
				noiseOnlyOpens: tails.filter(t => t.after === "muted").length,
				transmissionsClosed: transmissions.length,
				closeReasons: transmissions.reduce((acc, t) => {
					acc[t.closeReason] = (acc[t.closeReason] ?? 0) + 1
					return acc
				}, {}),
				tails,
			}
			results.push(result)
			emit("mode-result", result)
		}
	} finally {
		if (changed) {
			const { body } = restorePatch(previous, { squelchMode: true })
			await api(args.base, "PATCH", "/api/live-audio/config", body)
			emit("restored", { body })
		}
	}
	emit("done", {
		modes: results.map(r => ({
			mode: r.mode,
			releases: r.releases,
			tailMs: r.tailMs,
		})),
	})
	return 0
}

runMain(usage, parse, main)
