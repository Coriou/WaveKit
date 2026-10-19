/**
 * End-to-end checks against the release `wavekit-chan` binary.
 * Skip reason when it is absent: native/wavekit-chan/target/release/wavekit-chan
 * is missing. Build with
 * `cargo build --release --locked --offline --manifest-path native/wavekit-chan/Cargo.toml`.
 */
import { existsSync } from "node:fs"
import http from "node:http"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { afterEach, describe, expect, it, vi } from "vitest"
import { LiveDemodConfigSchema, type SourceCaps } from "../../../src/config.js"
import type { LiveDemodulator as LiveDemodulatorType } from "../../../src/core/live-demodulator.js"
import { LiveDemodulator } from "../../../src/core/live-demodulator.js"
import { RustEngine } from "../../../src/core/live-demod/rust-engine.js"
import {
	encodeOpen,
	encodeRetune,
	encodeSquelch,
} from "../../../src/core/live-demod/rust-protocol.js"
import { createLogger } from "../../../src/utils/logger.js"
import {
	capturingLogger,
	createFakeFanout,
	createFakeSourceManager,
} from "./live-demodulator-continuity-fakes.js"

const binary = join(
	process.cwd(),
	"native/wavekit-chan/target/release/wavekit-chan",
)
const binaryMissing = !existsSync(binary)
const FORBIDDEN_PORTS = new Set([15555, 15556, 18080, 9000, 5173, 8081, 8082])

const LiveDemodulatorClass = LiveDemodulator as unknown as new (
	...args: unknown[]
) => LiveDemodulatorType

async function freePort(): Promise<number> {
	for (let attempt = 0; attempt < 20; attempt++) {
		const port = await new Promise<number>((resolve, reject) => {
			const server = http.createServer()
			server.once("error", reject)
			server.listen(0, "127.0.0.1", () => {
				const address = server.address()
				if (address === null || typeof address === "string") {
					server.close()
					reject(new Error("no port"))
					return
				}
				const found = address.port
				server.close(err => (err ? reject(err) : resolve(found)))
			})
		})
		if (!FORBIDDEN_PORTS.has(port)) return port
	}
	throw new Error("no ephemeral port")
}

function cu8Nfm(samples: number, sampleRate: number): Buffer {
	const iq = Buffer.alloc(samples * 2)
	const toneHz = 1_000
	const deviationHz = 3_000
	let carrier = 0
	let tone = 0
	for (let i = 0; i < samples; i++) {
		tone += (2 * Math.PI * toneHz) / sampleRate
		carrier += (2 * Math.PI * deviationHz * Math.sin(tone)) / sampleRate
		iq[i * 2] = 127 + Math.round(90 * Math.cos(carrier))
		iq[i * 2 + 1] = 127 + Math.round(90 * Math.sin(carrier))
	}
	return iq
}

describe.skipIf(binaryMissing)(
	binaryMissing
		? "rust demod wire skipped: release binary native/wavekit-chan/target/release/wavekit-chan is absent"
		: "rust demod wire against the release binary",
	() => {
		const engines: RustEngine[] = []
		let demod: LiveDemodulatorType | undefined

		afterEach(async () => {
			try {
				await demod?.stop()
			} catch {
				// cleanup only
			}
			demod = undefined
			for (const engine of engines) await engine.stop()
			engines.length = 0
		})

		it("accepts every open, retune and squelch shape the TS encoder sends", async () => {
			const openSquelch = {
				mode: "power" as const,
				thresholdDbfs: -40,
				hysteresisDb: 2,
				hangMs: 250,
				noiseFloorDbfs: null,
			}
			const openLine = encodeOpen({
				config: LiveDemodConfigSchema.parse({
					modulation: "nfm",
					bandwidth: 12_500,
					squelch: -40,
					audioFormat: "s16le",
					gain: 2,
				}),
				centerHz: 100_000_000,
				squelch: openSquelch,
			})
			const open = JSON.parse(openLine) as {
				squelch: Record<string, unknown>
			}
			expect(Object.hasOwn(open.squelch, "noiseFloorDbfs")).toBe(false)
			const clearFloor = encodeSquelch({
				mode: "power",
				thresholdDbfs: -55,
				hysteresisDb: 2,
				hangMs: 250,
				noiseFloorDbfs: null,
			})
			expect(JSON.parse(clearFloor)["noiseFloorDbfs"]).toBeNull()
			expect(encodeRetune({ centerHz: 100_012_500 })).toContain(
				'"type":"retune"',
			)

			const rejected: string[] = []
			const down: string[] = []
			const engine = new RustEngine({
				binaryPath: binary,
				logger: createLogger({ level: "fatal" }),
				probeTimeoutMs: 2000,
				openTimeoutMs: 2000,
				stopKillMs: 2000,
			})
			engines.push(engine)
			const caps: SourceCaps = {
				kind: "iq",
				sampleRate: 2_048_000,
				format: "U8_IQ",
				centerFreq: 100_000_000,
				exclusive: false,
			}
			const started = await engine.start({
				config: LiveDemodConfigSchema.parse({
					engine: "rust",
					modulation: "nfm",
					bandwidth: 12_500,
					squelch: -40,
					audioFormat: "s16le",
					gain: 2,
				}),
				caps,
				input: new PassThrough(),
				squelch: openSquelch,
				handlers: {
					onAudio: () => undefined,
					onGate: () => undefined,
					onMetrics: () => undefined,
					onDown: reason => down.push(reason),
					onRejected: code => rejected.push(code),
				},
			})
			expect(started).toMatchObject({ ok: true, rate: 48000, format: "s16le" })
			engine.applyRetune({ centerHz: 100_012_500 })
			engine.applyRetune({ bandwidthHz: 15_000 })
			engine.applyRetune({
				audio: {
					gain: 3,
					deviationHz: 5_000,
					deEmphasisUs: 75,
					lowPassHz: 3_000,
					highPassHz: 200,
				},
			})
			engine.applyRetune({
				modulation: "am",
				audio: { deEmphasisUs: null, gain: 2 },
			})
			engine.applyRetune({
				audio: { lowPassHz: null, highPassHz: null },
			})
			engine.applySquelch({
				mode: "power",
				thresholdDbfs: -55,
				hysteresisDb: 2,
				hangMs: 250,
				noiseFloorDbfs: -90,
			})
			engine.applySquelch({
				mode: "power",
				thresholdDbfs: -55,
				hysteresisDb: 2,
				hangMs: 250,
				noiseFloorDbfs: null,
			})
			engine.applySquelch({
				mode: "noise",
				quietingDb: 8,
				hysteresisDb: 2,
				hangMs: 250,
			})
			engine.applySquelch({ mode: "off" })
			await new Promise(resolve => setTimeout(resolve, 200))
			expect(rejected).toEqual([])
			expect(down).toEqual([])
		}, 10_000)

		it("runs LiveDemodulator on rust for synthetic 2.048 Msps NFM", async () => {
			const port = await freePort()
			const fanout = createFakeFanout()
			const source = createFakeSourceManager(2_048_000)
			const captured = capturingLogger()
			const config = LiveDemodConfigSchema.parse({
				enabled: true,
				sourceId: "rtl-pi",
				httpPort: port,
				engine: "rust",
				chanBinaryPath: binary,
				modulation: "nfm",
				bandwidth: 12_500,
				squelch: 0,
				audioFormat: "s16le",
			})
			demod = new LiveDemodulatorClass(
				captured.logger,
				source,
				fanout,
				config,
				{ httpHost: "127.0.0.1" },
			)
			await demod.start()
			expect(demod.getStatus().engine).toBe("rust")
			expect(demod.getStatus().engineFallback).toBeUndefined()
			expect(demod.getStatus().effectiveSampleRate).toBe(48_000)

			const headers = await new Promise<http.IncomingHttpHeaders>(
				(resolve, reject) => {
					const req = http.get(
						{ host: "127.0.0.1", port, path: "/stream" },
						res => {
							resolve(res.headers)
							res.destroy()
						},
					)
					req.on("error", reject)
				},
			)
			expect(headers["x-sample-rate"]).toBe("48000")

			const chunks: Buffer[] = []
			demod.on("pcm", (chunk: Buffer) => {
				chunks.push(Buffer.from(chunk))
			})
			const samples = Math.floor(2_048_000 * 0.5)
			fanout.branch.write(cu8Nfm(samples, 2_048_000))
			await vi.waitFor(
				() => {
					const audio = Buffer.concat(chunks)
					expect(audio.length).toBeGreaterThan(0)
					expect(audio.length % 2).toBe(0)
				},
				{ timeout: 8_000 },
			)

			await demod.reconfigure({ squelch: -35 })
			expect(demod.getStatus().engine).toBe("rust")
			expect(demod.getStatus().engineFallback).toBeUndefined()
			await demod.reconfigure({ squelchMode: "auto", autoMarginDb: 8 })
			expect(demod.getStatus().engine).toBe("rust")
			expect(demod.getStatus().engineFallback).toBeUndefined()
			await demod.reconfigure({ offsetHz: 25_000 })
			expect(demod.getStatus().engine).toBe("rust")
			expect(demod.getStatus().engineFallback).toBeUndefined()
			expect(demod.getStatus().effectiveSampleRate).toBe(48_000)
		}, 15_000)
	},
)
