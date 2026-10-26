/**
 * Decoder-enablement 3.18 through the production channel path, with a
 * SYNTHETIC POCSAG1200 burst (scripts/fixtures/pocsag-iq.mjs) on a 6.25 kHz
 * offset channel of an off-raster capture at 1.024 Msps:
 *
 * cu8 IQ -> wavekit-chan (the real channelizer, built from native/ into a
 * tmp target dir; skipped, with the reason, when this host cannot build it
 * offline) with MultimonDecoder's own channel request per planned channel -> cf32 at 48 kHz -> the decoder's production
 * command line for channel IQ. When csdr is installed the whole command runs;
 * otherwise its csdr head (agc, fmdemod, gain 3, limit, s16) is done here
 * and its exact sox | multimon-ng tail runs. The burst must decode on its
 * channel and on no raster neighbour. The independent reference test is
 * paging-raster-pocsag.test.ts.
 */
import { spawn, spawnSync } from "node:child_process"
import { createConnection } from "node:net"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import {
	buildWavekitChan,
	wavekitChanBuildUnavailable,
} from "./wavekit-chan-build.js"
import pino from "pino"
import { synthesizePocsagCu8 } from "../../scripts/fixtures/pocsag-iq.mjs"
import { MultimonDecoder } from "../../src/decoders/builtin/multimon-ng.js"
import type { DecoderChannelRequest } from "../../src/core/channelizer/types.js"
import type { DecoderOutput } from "../../src/decoders/types.js"

const FS = 1_024_000
const CENTRE = 466_103_300
const BURST_HZ = 466_156_250
const CHANNELS = [
	BURST_HZ,
	BURST_HZ - 6250,
	BURST_HZ + 6250,
	BURST_HZ - 12_500,
	BURST_HZ + 12_500,
]

const has = (cmd: string, args: string[]) =>
	spawnSync(cmd, args, { stdio: "ignore" }).error === undefined
const hasTools = has("multimon-ng", ["-h"]) && has("sox", ["--version"])
const hasCsdr = has("csdr", ["--help"])
const CRATE = resolve(__dirname, "../../native/wavekit-chan")
// Why this host cannot build the crate offline, if it cannot.
const chanUnavailable = wavekitChanBuildUnavailable(CRATE)
// An isolated cargo target owned by this run (mkdtemp in beforeAll), never shared.
let TARGET = ""
let BINARY = ""

class Probe extends MultimonDecoder {
	pipeline(): string {
		return this.buildPipelineCommand()
	}
	parse(line: string): DecoderOutput | null {
		return this.parseOutput(line)
	}
}
const probe = (options: Record<string, unknown>) =>
	new Probe(
		{
			id: "pager",
			type: "multimon-ng",
			enabled: true,
			options: { modes: ["POCSAG512", "POCSAG1200", "POCSAG2400"], ...options },
		},
		pino({ level: "silent" }),
	)

/** Opens every request (one at a time), feeds the IQ, returns each channel's cf32. */
async function channelize(
	iq: Buffer,
	requests: DecoderChannelRequest[],
): Promise<Buffer[]> {
	const dir = mkdtempSync("/tmp/wkc-")
	const child = spawn(
		BINARY,
		[
			"--generation",
			"1",
			"--input-format",
			"cu8",
			"--input-rate",
			String(FS),
			"--input-center",
			String(CENTRE),
			"--usable-fraction",
			"0.8",
			"--block-samples",
			"16384",
			"--socket-dir",
			dir,
			"--control-fd",
			"3",
		],
		{ stdio: ["pipe", "pipe", "ignore", "pipe"] },
	)
	const control = child.stdio[3] as NodeJS.WritableStream
	const out = requests.map(() => [] as Buffer[])
	const ended: Promise<void>[] = []
	let opened = 0
	let lines = ""
	try {
		await new Promise<void>((done, fail) => {
			const open = (i: number) =>
				control.write(
					JSON.stringify({
						v: 1,
						type: "open",
						id: `c${i}`,
						centerHz: requests[i]!.centerHz,
						bandwidthHz: requests[i]!.bandwidthHz,
						transitionHz: requests[i]!.transitionHz,
						outputRateHz: requests[i]!.outputRateHz,
						format: requests[i]!.format,
						queueBytes: 16 * 1024 * 1024,
					}) + "\n",
				)
			child.on("error", fail)
			child.stdout!.on("data", (chunk: Buffer) => {
				lines += chunk.toString()
				let nl: number
				while ((nl = lines.indexOf("\n")) >= 0) {
					const event = JSON.parse(lines.slice(0, nl)) as {
						type: string
						socket?: string
					}
					lines = lines.slice(nl + 1)
					if (event.type === "ready") open(0)
					else if (event.type === "rejected")
						fail(new Error(`channel rejected: ${JSON.stringify(event)}`))
					else if (event.type === "opened") {
						const index = opened++
						const socket = createConnection(event.socket!)
						socket.on("data", (data: Buffer) => out[index]!.push(data))
						ended.push(
							new Promise(end => {
								socket.on("close", () => end())
								socket.on("error", () => end())
							}),
						)
						socket.once("connect", () =>
							opened < requests.length ? open(opened) : done(),
						)
					}
				}
			})
		})
		child.stdin!.end(iq)
		await new Promise(end => child.once("exit", end))
		await Promise.all(ended)
	} finally {
		child.kill()
		rmSync(dir, { recursive: true, force: true })
	}
	return out.map(parts => Buffer.concat(parts))
}

/** csdr agc | fmdemod | gain 3 | limit | convert -o s16, done here (no csdr). */
function csdrHead(cf32: Buffer): Buffer {
	const n = Math.floor(cf32.length / 8)
	const pcm = Buffer.alloc(2 * n)
	let pi = 0
	let pq = 0
	for (let k = 0; k < n; k++) {
		const i = cf32.readFloatLE(8 * k)
		const q = cf32.readFloatLE(8 * k + 4)
		const d = Math.atan2(q * pi - i * pq, i * pi + q * pq) / Math.PI
		pi = i
		pq = q
		const v = Math.max(-1, Math.min(1, 3 * d))
		pcm.writeInt16LE(Math.round(v * 32_767), 2 * k)
	}
	return pcm
}

describe.skipIf(!hasTools)(
	"paging raster through wavekit-chan and the production chain (3.18)",
	() => {
		beforeAll(async () => {
			if (chanUnavailable) return
			TARGET = mkdtempSync(join(tmpdir(), "wavekit-chan-target-"))
			BINARY = await buildWavekitChan(CRATE, TARGET)
		}, 600_000)
		beforeEach(context => {
			if (chanUnavailable) context.skip(chanUnavailable)
		})
		afterAll(() => {
			if (TARGET) rmSync(TARGET, { recursive: true, force: true })
		})

		it("decodes the burst on its channel and on no neighbour", async () => {
			const iq = synthesizePocsagCu8({
				sampleRateHz: FS,
				offsetHz: BURST_HZ - CENTRE,
				address: 765_432,
				message: "90210",
			})
			const requests = CHANNELS.map(
				hz =>
					probe({ channelHz: hz }).getChannelRequest({
						sampleRateHz: FS,
						centerHz: CENTRE,
					}) as DecoderChannelRequest,
			)
			for (const [i, r] of requests.entries())
				expect(r).toMatchObject({
					centerHz: CHANNELS[i],
					bandwidthHz: 12_000,
					transitionHz: 2500,
					outputRateHz: 48_000,
					format: "cf32",
				})
			const cf32 = await channelize(iq, requests)
			const p = probe({ inputSampleRate: 48_000, inputIqFormat: "cf32" })
			const command = p.pipeline()
			const stages = command.split(" | ")
			const soxAt = stages.findIndex(s => s.startsWith("sox "))
			// The production command line for channel IQ.
			expect(stages.slice(0, soxAt)).toEqual([
				"csdr agc -f complex -p slow -r 0.7",
				"csdr fmdemod",
				"csdr gain 3",
				"csdr limit",
				"csdr convert -i float -o s16",
			])
			const work = mkdtempSync(join(tmpdir(), "wkc-audio-"))
			const decoded = cf32.map((iqOut, i) => {
				expect(iqOut.length, String(CHANNELS[i])).toBeGreaterThan(8 * 48_000)
				// stdin from a file: sox stops early reading node's stdin socket.
				const file = join(work, `in-${i}`)
				writeFileSync(file, hasCsdr ? iqOut : csdrHead(iqOut))
				const tail = hasCsdr ? command : stages.slice(soxAt).join(" | ")
				const run = spawnSync("/bin/sh", ["-c", `(${tail}) < "${file}"`])
				return run.stdout
					.toString()
					.split("\n")
					.map(line => p.parse(line)?.data)
					.filter(Boolean)
			})
			rmSync(work, { recursive: true, force: true })
			expect(decoded[0]).toEqual([
				expect.objectContaining({
					protocol: "POCSAG1200",
					address: 765_432,
					message: "90210",
				}),
			])
			for (const [i, events] of decoded.entries())
				if (i > 0) expect(events, String(CHANNELS[i])).toEqual([])
		}, 120_000)
	},
)
