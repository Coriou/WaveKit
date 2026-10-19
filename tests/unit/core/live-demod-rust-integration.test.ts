import { existsSync } from "node:fs"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { afterEach, describe, expect, it } from "vitest"
import { LiveDemodConfigSchema, type SourceCaps } from "../../../src/config.js"
import { RustEngine } from "../../../src/core/live-demod/rust-engine.js"
import { createLogger } from "../../../src/utils/logger.js"

const binary = join(
	process.cwd(),
	"native/wavekit-chan/target/release/wavekit-chan",
)

describe("wavekit-chan demod integration", () => {
	const engines: RustEngine[] = []

	afterEach(async () => {
		for (const engine of engines) await engine.stop()
		engines.length = 0
	})

	it.skipIf(!existsSync(binary))(
		"demodulates synthetic cu8 to 48 kHz audio",
		async () => {
			const input = new PassThrough()
			const audio: Buffer[] = []
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
				sampleRate: 48_000,
				format: "U8_IQ",
				centerFreq: 100_000_000,
				exclusive: false,
			}
			const started = await engine.start({
				config: LiveDemodConfigSchema.parse({
					engine: "rust",
					modulation: "nfm",
					bandwidth: 12500,
					squelch: 0,
					audioFormat: "s16le",
				}),
				caps,
				input,
				squelch: { mode: "off" },
				handlers: {
					onAudio: chunk => audio.push(Buffer.from(chunk)),
					onGate: () => undefined,
					onMetrics: () => undefined,
					onDown: () => undefined,
				},
			})
			expect(started).toMatchObject({ ok: true, rate: 48000, format: "s16le" })
			const samples = 48_000 * 2
			const iq = Buffer.alloc(samples * 2)
			for (let i = 0; i < samples; i++) {
				const phase = (2 * Math.PI * 2500 * i) / 48_000
				iq[i * 2] = 127 + Math.round(90 * Math.cos(phase))
				iq[i * 2 + 1] = 127 + Math.round(90 * Math.sin(phase))
			}
			input.write(iq)
			input.end()
			await viWaitForAudio(audio)
			expect(Buffer.concat(audio).length).toBeGreaterThan(0)
		},
		5_000,
	)
})

async function viWaitForAudio(audio: Buffer[]): Promise<void> {
	const deadline = Date.now() + 3000
	while (Buffer.concat(audio).length === 0) {
		if (Date.now() > deadline) throw new Error("no demod audio")
		await new Promise(resolve => setTimeout(resolve, 20))
	}
}
