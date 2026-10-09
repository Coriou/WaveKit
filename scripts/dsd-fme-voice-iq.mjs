/**
 * IQ mode of scripts/dsd-fme-voice-ab.mjs (core channelizer delta §5): the
 * same voice check fed from a cu8 capture through one of two fronts.
 *
 * - csdr: the decoder's own raw front (convert | shift | matched firdecimate
 *   | fmdemod). csdrFeedStages must equal DsdFmeDecoder.buildPipelineCommand
 *   on the raw path; a unit test checks it, like BACK_CHAIN.
 * - chan: wavekit-chan opens one 48 kHz cf32 channel at capture centre +
 *   offset (12 500 / 6 250, the request DsdFmeDecoder makes) and its socket
 *   feeds `csdr fmdemod | BACK_CHAIN | ...`, the channelised decoder chain.
 *
 * No side effects on import.
 */

import { spawn } from "node:child_process"
import { createReadStream, mkdtempSync, rmSync } from "node:fs"
import { connect } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { pipeline } from "node:stream/promises"
import { setTimeout as sleep } from "node:timers/promises"

/** dsd-fme's channel bandwidth, demod and output rate (DsdFmeDecoder.getDemodConfig). */
const CHANNEL_BANDWIDTH_HZ = 12_500
const DEMOD_RATE_HZ = 48_000
/** A recording has no RF: only the offset from the capture centre matters. */
export const NOMINAL_CENTER_HZ = 100_000_000
/** First stage of the channelised dsd-fme pipeline (cf32 in, delta E8). */
export const CHAN_FRONT = "csdr fmdemod"
/** Delta §5 tolerance, PROVISIONAL until the user confirms it (PF16). */
export const ambeTolerance = csdr => Math.max(1.25 * csdr, csdr + 20)

/** Parses the IQ-mode options; null when `--iq` is absent (default mode). */
export function parseIqArgs(argv) {
	const option = name => {
		const i = argv.indexOf(name)
		return i >= 0 ? argv[i + 1] : undefined
	}
	const iq = option("--iq")
	if (iq === undefined) return null
	const rate = Number(option("--rate"))
	const offset = Number(option("--offset") ?? 0)
	const front = option("--front")
	if (!Number.isInteger(rate) || rate < DEMOD_RATE_HZ)
		throw new Error(`--rate must be an integer >= ${DEMOD_RATE_HZ} Hz`)
	const limit = rate / 2 - CHANNEL_BANDWIDTH_HZ / 2
	if (!Number.isFinite(offset) || Math.abs(offset) > limit)
		throw new Error(`--offset must be within ±${Math.floor(limit)} Hz`)
	if (front !== "csdr" && front !== "chan")
		throw new Error("--front must be csdr or chan")
	return {
		iq,
		rate,
		offset,
		front,
		chanBin: option("--chan-bin") ?? "wavekit-chan",
		paced: !argv.includes("--unpaced"),
	}
}

/** sox WAV wrapper at the demod rate, after the back chain (DsdFmeDecoder). */
function wavStages(chain, demodRate) {
	return [
		chain,
		"csdr convert -i float -o s16",
		`sox -t raw -r ${demodRate} -e signed -b 16 -c 1 - -t wav -r ${DEMOD_RATE_HZ} -`,
	]
}

/** The raw dsd-fme chain for a cu8 capture, up to dsd-fme (csdr-stages.ts, "channel" mode). */
export function csdrFeedStages(rate, offset, chain) {
	const decimation = Math.max(1, Math.round(rate / DEMOD_RATE_HZ))
	const outputRate = rate / decimation
	const stopband = Math.min(outputRate / 2, CHANNEL_BANDWIDTH_HZ)
	let passband = CHANNEL_BANDWIDTH_HZ / 2
	if (passband >= stopband * 0.9) passband = stopband / 2
	const transition = Math.max(0.0001, (stopband - passband) / rate)
	const cutoff = Math.min(0.5, (passband + stopband) / 2 / outputRate)
	return [
		"csdr convert -i char -o float",
		...(offset !== 0 ? [`csdr shift ${(-offset / rate).toFixed(10)}`] : []),
		`csdr firdecimate ${decimation} ${transition.toFixed(6)} --cutoff ${cutoff.toFixed(4)}`,
		"csdr fmdemod",
		...wavStages(chain, outputRate),
	]
}

/** The channelised dsd-fme chain on the channel's cf32 output, up to dsd-fme. */
export function chanFeedStages(chain) {
	return [CHAN_FRONT, ...wavStages(chain, DEMOD_RATE_HZ)]
}

/** wavekit-chan spawn line (mirrors buildChannelizerArgs in channelizer-process.ts). */
export function chanArgs(rate, socketDir) {
	return [
		"--generation",
		"1",
		"--input-format",
		"cu8",
		"--input-rate",
		String(rate),
		"--input-center",
		String(NOMINAL_CENTER_HZ),
		"--usable-fraction",
		"0.9",
		"--block-samples",
		"16384",
		"--socket-dir",
		socketDir,
		"--control-fd",
		"3",
	]
}

/** The v1 open request; the queue holds a whole short capture's output. */
export function openRequest(offset) {
	return {
		v: 1,
		type: "open",
		id: "voice-ab",
		centerHz: NOMINAL_CENTER_HZ + offset,
		bandwidthHz: CHANNEL_BANDWIDTH_HZ,
		transitionHz: CHANNEL_BANDWIDTH_HZ / 2,
		outputRateHz: DEMOD_RATE_HZ,
		format: "cf32",
		queueBytes: 64 * 1024 * 1024,
	}
}

/**
 * A pipeline stage that releases the capture at `bytesPerSecond` (real time
 * for cu8 is 2 bytes per sample), or as fast as it is read when null.
 */
export function pace(
	bytesPerSecond,
	clock = { now: () => performance.now(), sleep },
) {
	return async function* (source) {
		const start = clock.now()
		let sent = 0
		for await (const chunk of source) {
			yield chunk
			sent += chunk.length
			if (bytesPerSecond === null) continue
			const due = start + (sent * 1000) / bytesPerSecond - clock.now()
			if (due > 0) await clock.sleep(due)
		}
	}
}

/**
 * Feeds `sink` the channel's cf32 output: spawns wavekit-chan, opens one
 * channel over fd 3, connects to its socket and only then streams the cu8
 * file into stdin, paced at real time unless `paced` is false (delta §8 risk
 * 4: the voice gate runs paced), so no IQ passes before the channel exists.
 * The socket is read without backpressure so the channel queue never
 * overflows (no discontinuities expected). A run passes only if it ends with
 * `input-eof` counting every fed byte and discarding none, with no `closed`
 * before it, so a truncated tail cannot pass silently. Resolves on exit with
 * { discontinuities, error }.
 */
export function chanFeed({ chanBin, iq, rate, offset, paced }, sink) {
	const dir = mkdtempSync(join(tmpdir(), "wkchan-"))
	const chan = spawn(chanBin, chanArgs(rate, dir), {
		stdio: ["pipe", "pipe", "inherit", "pipe"],
	})
	const result = { discontinuities: 0, error: null }
	const endSink = () => sink.writableEnded || sink.end()
	const fail = message => {
		result.error ??= message
		chan.kill()
	}
	let socket = null
	let eof = null
	let fed = 0
	const feedCapture = () =>
		pipeline(
			createReadStream(iq),
			pace(paced === false ? null : 2 * rate),
			async function* (source) {
				for await (const chunk of source) {
					fed += chunk.length
					yield chunk
				}
			},
			chan.stdin,
		).catch(err => fail(`capture: ${err.message}`))
	sink.on("error", () => {}) // dsd-fme may exit first; its exit code tells
	chan.stdin.on("error", () => {}) // reported through feedCapture
	chan.stdio[3]?.on("error", err => fail(`control fd: ${err.message}`))
	chan.on("error", err => fail(`spawn ${chanBin}: ${err.message}`))
	createInterface({ input: chan.stdout }).on("line", line => {
		let event
		try {
			event = JSON.parse(line)
		} catch {
			return fail(`unparsable event: ${line}`)
		}
		if (event.type === "ready")
			chan.stdio[3].write(
				`${JSON.stringify(openRequest(offset))}\n`,
				err => err && fail(`control fd: ${err.message}`),
			)
		else if (event.type === "rejected")
			fail(`channel rejected: ${event.reasonCode} ${event.detail}`)
		else if (event.type === "discontinuity") result.discontinuities++
		else if (event.type === "input-eof") eof = event
		else if (event.type === "closed" && !eof)
			fail(`channel closed before input-eof: ${event.reason}`)
		else if (event.type === "opened" && !socket) {
			socket = connect(event.socket)
			socket.on("connect", () => void feedCapture())
			socket.on("data", chunk => sink.write(chunk))
			socket.on("error", err => fail(`channel socket: ${err.message}`))
			socket.on("close", endSink)
		}
	})
	return new Promise(resolve =>
		chan.on("close", code => {
			rmSync(dir, { recursive: true, force: true })
			if (code !== 0) result.error ??= `wavekit-chan exited ${code}`
			else if (!eof) result.error ??= "wavekit-chan exited without input-eof"
			else if (eof.discardedBytes !== 0)
				result.error ??= `input-eof discarded ${eof.discardedBytes} byte(s) (odd-length capture)`
			else if (eof.inputSamples * 2 !== fed)
				result.error ??= `input-eof counted ${eof.inputSamples} samples, ${fed / 2} fed`
			if (!socket) endSink()
			resolve(result)
		}),
	)
}

/** Normalised decode lines carrying a link control (TGT=… SRC=…). */
export function linkLines(decoded) {
	return new Set(
		decoded.split("\n").filter(line => /\bTGT=\d+ SRC=\d+/.test(line)),
	)
}
