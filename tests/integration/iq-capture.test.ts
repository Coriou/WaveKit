/**
 * WG11 lane IQ: the capture service with the real `wavekit-iqcap` binary (built by
 * `make chan-build`) fed from a fake engine tap of synthetic CU8; skipped when the binary is absent.
 */
import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { Readable } from "node:stream"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createIqCaptureService } from "../../src/core/iq-capture/service.js"
import { probeReplayShapes } from "../../src/core/iq-capture/shapes.js"
import { spyLogger } from "../unit/core/iq-capture/helpers.js"

const BINARY = fileURLToPath(
	new URL(
		"../../native/wavekit-chan/target/release/wavekit-iqcap",
		import.meta.url,
	),
)
const present = fs.existsSync(BINARY)
if (!present)
	console.warn(
		`iq-capture integration skipped: ${BINARY} is absent (run make chan-build)`,
	)

const FS = 2_048_000
const CENTER = 446_000_000
const OFFSET = 25_000

class ToneEngine {
	listeners = new Set<(s: number, b: Uint8Array) => void>()
	edge = 0
	tap(l: (s: number, b: Uint8Array) => void) {
		this.listeners.add(l)
		return () => this.listeners.delete(l)
	}
	liveEdge() {
		return this.edge
	}
	push(samples: number) {
		const b = new Uint8Array(samples * 2)
		for (let i = 0; i < samples; i++) {
			const ph = (2 * Math.PI * OFFSET * (this.edge + i)) / FS
			b[2 * i] = Math.round(127.5 + 60 * Math.cos(ph))
			b[2 * i + 1] = Math.round(127.5 + 60 * Math.sin(ph))
		}
		for (const l of this.listeners) l(this.edge, b)
		this.edge += samples
	}
}

let root: string
beforeAll(async () => {
	root = fs.realpathSync(await fsp.mkdtemp(path.join(tmpdir(), "iqcap-int-")))
})
afterAll(async () => {
	await fsp.rm(root, { recursive: true, force: true })
})

const until = async (cond: () => boolean, ms: number) => {
	const end = Date.now() + ms
	while (!cond() && Date.now() < end) await new Promise(r => setTimeout(r, 20))
}

describe.skipIf(!present)("iq capture with the real wavekit-iqcap", () => {
	it("captures a tone on request, replays it to a decoder shape, discards at settle", async () => {
		const { logger, lines } = spyLogger()
		const svc = createIqCaptureService({
			config: {
				enabled: true,
				maxTotalMb: 16,
				maxCaptureMs: 1000,
				preRollMs: 200,
				binaryPath: BINARY,
			},
			storageRoot: root,
			protectedMode: true,
			logger,
			shapes: probeReplayShapes(),
		})
		const engine = new ToneEngine()
		svc.attachSource("src", {
			sampleRateHz: FS,
			centerHz: CENTER,
			epoch: 1,
			engine,
		})
		await svc.start()
		await until(() => svc.state() === "on", 2000)
		// Feed until the tool is ready and holds about 0.5 s.
		for (let i = 0; i < 40; i++) {
			engine.push(FS / 40)
			await new Promise(r => setTimeout(r, 25))
		}
		const views: string[] = []
		svc.onFinished(v => views.push(v.captureId))
		const got = svc.capture({
			sourceId: "src",
			observationId: "obs",
			epoch: 1,
			rfHz: CENTER + OFFSET,
			tuningTrust: "commanded",
			fromSample: engine.edge,
			reason: "detection",
		})
		expect(got).toHaveProperty("captureId")
		const id = "captureId" in got ? got.captureId : ""
		for (let i = 0; i < 60 && views.length === 0; i++) {
			engine.push(FS / 40)
			await new Promise(r => setTimeout(r, 25))
		}
		await until(() => views.length > 0, 5000)
		expect(views).toEqual([id])
		const file = path.join(root, "iq-captures", `${id}.cf32`)
		const size = fs.statSync(file).size
		expect(size).toBeGreaterThan(0)
		expect(size).toBeLessThanOrEqual(1000 * 48 * 8)
		expect(fs.statSync(file).mode & 0o777).toBe(0o600)
		// The tone sits at the requested channel's centre: shifted to DC, a near-constant phasor.
		const raw = fs.readFileSync(file)
		const f = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4)
		let si = 0
		let sq = 0
		let mag = 0
		const skip = 2000
		for (let k = skip; k < f.length / 2; k++) {
			const i = f[2 * k] ?? 0
			const q = f[2 * k + 1] ?? 0
			si += i
			sq += q
			mag += Math.hypot(i, q)
		}
		expect(Math.hypot(si, sq) / mag).toBeGreaterThan(0.8)
		const out = svc.openReplay(id, "dsd-fme") as Readable
		expect(out).not.toBeNull()
		const replayed = await new Promise<number>((resolve, reject) => {
			let n = 0
			out.on("data", (b: Buffer) => (n += b.length))
			out.on("end", () => resolve(n))
			out.on("error", reject)
		})
		expect(replayed).toBe(size)
		expect(svc.claim(id, "job")).toBe(false)
		svc.discard(id, "result")
		await until(() => !fs.existsSync(file), 2000)
		expect(fs.existsSync(file)).toBe(false)
		await svc.stop()
		expect(fs.readdirSync(path.join(root, "iq-captures"))).toEqual([])
		const text = JSON.stringify(lines)
		expect(text).not.toContain(id)
		expect(text).not.toContain(root)
	}, 20_000)
})
