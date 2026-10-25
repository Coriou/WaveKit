/**
 * Decoder-enablement 3.19 through the real native planner: dumpvdl2's own
 * channel request (default EU list) is opened on wavekit-chan (built from
 * native/ into a tmp target dir; skipped without cargo) at 1.024, 2.048 and
 * 2.4 Msps, and must open and deliver cu8 at its output rate. The 945 kHz
 * request an earlier draft made at 1.024 Msps is shown to be rejected.
 */
import { spawn, spawnSync } from "node:child_process"
import { createConnection } from "node:net"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import pino from "pino"
import { Dumpvdl2Decoder } from "../../src/decoders/builtin/dumpvdl2.js"
import type { DecoderChannelRequest } from "../../src/core/channelizer/types.js"

const EU = [136_650_000, 136_700_000, 136_975_000]
const CENTRE = 136_812_500
const SECONDS = 0.5

const hasCargo =
	spawnSync("cargo", ["--version"], { stdio: "ignore" }).error === undefined
const CRATE = resolve(__dirname, "../../native/wavekit-chan")
let TARGET = ""
let BINARY = ""

const requestAt = (sampleRateHz: number): DecoderChannelRequest => {
	const r = new Dumpvdl2Decoder(
		{
			id: "vdl2",
			type: "dumpvdl2",
			enabled: true,
			options: { frequencies: EU, inputSampleRate: sampleRateHz },
		},
		pino({ level: "silent" }),
	).getChannelRequest({ sampleRateHz, centerHz: CENTRE })
	if (!r || "invalid" in r) throw new Error(`no request: ${JSON.stringify(r)}`)
	return r
}

type Outcome =
	| { opened: true; bytes: number }
	| { opened: false; event: string }

/** Opens one channel, feeds SECONDS of noise cu8, returns what came back. */
async function open(fs: number, req: DecoderChannelRequest): Promise<Outcome> {
	const dir = mkdtempSync("/tmp/wkc-")
	const child = spawn(
		BINARY,
		[
			"--generation",
			"1",
			"--input-format",
			"cu8",
			"--input-rate",
			String(fs),
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
	const chunks: Buffer[] = []
	let lines = ""
	try {
		const first = await new Promise<Outcome | "opened">((done, fail) => {
			child.on("error", fail)
			child.stdout!.on("data", (chunk: Buffer) => {
				lines += chunk.toString()
				let nl: number
				while ((nl = lines.indexOf("\n")) >= 0) {
					const line = lines.slice(0, nl)
					lines = lines.slice(nl + 1)
					const event = JSON.parse(line) as { type: string; socket?: string }
					if (event.type === "ready")
						control.write(
							JSON.stringify({
								v: 1,
								type: "open",
								id: "c0",
								centerHz: req.centerHz,
								bandwidthHz: req.bandwidthHz,
								transitionHz: req.transitionHz,
								outputRateHz: req.outputRateHz,
								format: req.format,
								queueBytes: 16 * 1024 * 1024,
							}) + "\n",
						)
					else if (event.type === "rejected" || event.type === "error")
						done({ opened: false, event: line })
					else if (event.type === "opened") {
						const socket = createConnection(event.socket!)
						socket.on("data", (d: Buffer) => chunks.push(d))
						socket.once("connect", () => {
							const closed = new Promise<void>(end => {
								socket.on("close", () => end())
								socket.on("error", () => end())
							})
							const n = Math.round(fs * SECONDS)
							const iq = Buffer.alloc(2 * n)
							for (let k = 0; k < iq.length; k++)
								iq[k] = 128 + Math.round((Math.random() - 0.5) * 40)
							child.stdin!.end(iq)
							void closed.then(() => done("opened"))
						})
					}
				}
			})
		})
		if (first !== "opened") return first
		return { opened: true, bytes: Buffer.concat(chunks).length }
	} finally {
		child.kill()
		rmSync(dir, { recursive: true, force: true })
	}
}

describe.skipIf(!hasCargo)(
	"dumpvdl2 channel through the native planner (3.19)",
	() => {
		beforeAll(() => {
			TARGET = mkdtempSync(join(tmpdir(), "wavekit-chan-target-"))
			BINARY = join(TARGET, "release", "wavekit-chan")
			const build = spawnSync(
				"cargo",
				["build", "--release", "--offline", "--bin", "wavekit-chan"],
				{
					cwd: CRATE,
					env: { ...process.env, CARGO_TARGET_DIR: TARGET },
					stdio: "ignore",
				},
			)
			if (build.status !== 0 || !existsSync(BINARY))
				throw new Error("wavekit-chan build failed")
		}, 600_000)
		afterAll(() => {
			if (TARGET) rmSync(TARGET, { recursive: true, force: true })
		})

		it.each([1_024_000, 2_048_000, 2_400_000])(
			"opens the default EU request at %i sps",
			async fs => {
				const req = requestAt(fs)
				expect(req.outputRateHz).toBe(fs === 1_024_000 ? 512_000 : 1_050_000)
				const out = await open(fs, req)
				expect(out).toMatchObject({ opened: true })
				if (!out.opened) return
				// cu8: 2 bytes per sample at the output rate, minus filter latency.
				const expected = 2 * req.outputRateHz * SECONDS
				expect(out.bytes).toBeGreaterThan(expected * 0.8)
				expect(out.bytes).toBeLessThanOrEqual(expected * 1.01)
			},
			60_000,
		)

		it("rejects the infeasible 945 kHz request at 1.024 Msps", async () => {
			const out = await open(1_024_000, {
				...requestAt(1_024_000),
				bandwidthHz: 375_000,
				transitionHz: 23_625,
				outputRateHz: 945_000,
			})
			expect(out.opened).toBe(false)
		}, 60_000)
	},
)
