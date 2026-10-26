import { ToneDetector } from "../../../../src/core/audio-tones/tone-detector.js"
import { syntheticTone } from "../scanner/identify-synth.js"
import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { Readable } from "node:stream"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { wholeCaptureShape } from "../../../../src/core/iq-capture/shapes.js"
import {
	captureBandwidthHz,
	createIqCaptureService,
	type IqCaptureServiceOptions,
	type IqReplayShapes,
} from "../../../../src/core/iq-capture/service.js"
import type { IqToolTimers } from "../../../../src/core/iq-capture/process.js"
import type { IqCaptureRequest } from "../../../../src/core/scanner/iq-capture-contract.js"
import {
	fakeSpawner,
	flush,
	logText,
	spyLogger,
	type FakeChild,
} from "./helpers.js"

const SHAPES: IqReplayShapes = {
	"dsd-fme": { bandwidthHz: 12_500, transitionHz: 2_500 },
	"multimon-ng": { bandwidthHz: 16_000, transitionHz: 576 },
	direwolf: { bandwidthHz: 16_000, transitionHz: 576 },
}
const CFG = {
	enabled: true,
	maxTotalMb: 16,
	maxCaptureMs: 4000,
	preRollMs: 500,
	binaryPath: "/opt/wavekit-iqcap",
}
const FS = 2_048_000
const CENTER = 446_000_000
const RF = 446_006_250

let base: string
let n = 0
beforeAll(async () => {
	base = fs.realpathSync(await fsp.mkdtemp(path.join(tmpdir(), "iqcap-svc-")))
})
afterAll(async () => {
	await fsp.rm(base, { recursive: true, force: true })
})

class ManualTimers implements IqToolTimers {
	t = 0
	private q = new Map<number, { at: number; fn: () => void }>()
	private seq = 0
	setTimeout(fn: () => void, ms: number): unknown {
		const h = ++this.seq
		this.q.set(h, { at: this.t + ms, fn })
		return h
	}
	clearTimeout(h: unknown): void {
		this.q.delete(h as number)
	}
	advance(ms: number): void {
		const end = this.t + ms
		for (;;) {
			let next: [number, { at: number; fn: () => void }] | undefined
			for (const e of this.q)
				if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e
			if (!next) break
			this.q.delete(next[0])
			this.t = next[1].at
			next[1].fn()
		}
		this.t = end
	}
}

class FakeEngine {
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
		for (const l of this.listeners) l(this.edge, b)
		this.edge += samples
	}
}

type Behaviour = "write" | "silent"

async function setup(
	over: Partial<IqCaptureServiceOptions> = {},
	opts: {
		behaviour?: Behaviour
		samples?: number
		enoent?: boolean
		noShapes?: boolean
	} = {},
) {
	const root = path.join(base, `r${n++}`)
	await fsp.mkdir(root)
	const timers = new ManualTimers()
	const { logger, lines } = spyLogger()
	let uuidN = 0
	const ids: string[] = []
	const samples = opts.samples ?? 4800
	const sp = fakeSpawner({
		...(opts.enoent ? { enoent: true } : {}),
		onSpawn: child => {
			if (child.args[0] !== "run") return
			queueMicrotask(() => child.event({ type: "ready" }))
			const outDir = child.args[child.args.indexOf("--out-dir") + 1] ?? ""
			child.control.on("data", (b: Buffer) => {
				for (const line of b.toString().split("\n").filter(Boolean)) {
					const cmd = JSON.parse(line) as { type: string; id?: string }
					if (cmd.type !== "capture" || opts.behaviour === "silent") continue
					const id = cmd.id ?? ""
					fs.writeFileSync(
						path.join(outDir, `${id}.cf32`),
						Buffer.alloc(samples * 8),
						{
							mode: 0o600,
						},
					)
					child.event({ type: "captured", id, samples, gapSamples: 0 })
				}
			})
		},
	})
	const svc = createIqCaptureService({
		config: CFG,
		storageRoot: root,
		protectedMode: true,
		logger,
		...(opts.noShapes ? {} : { shapes: SHAPES }),
		now: () => timers.t + 1_000_000,
		spawn: sp.spawn,
		randomUUID: () => {
			const id = `aaaaaaaa-0000-4000-8000-${(uuidN++).toString(16).padStart(12, "0")}`
			ids.push(id)
			return id
		},
		timers,
		env: {},
		...over,
	})
	const engine = new FakeEngine()
	return { svc, root, timers, logger, lines, sp, engine, ids }
}

function req(over: Partial<IqCaptureRequest> = {}): IqCaptureRequest {
	return {
		sourceId: "src",
		observationId: "obs",
		epoch: 3,
		rfHz: RF,
		tuningTrust: "commanded",
		fromSample: 0,
		reason: "detection",
		...over,
	}
}

async function running(s: Awaited<ReturnType<typeof setup>>) {
	s.svc.attachSource("src", {
		sampleRateHz: FS,
		centerHz: CENTER,
		epoch: 3,
		engine: s.engine,
	})
	await s.svc.start()
	await flush()
	s.engine.push(FS) // 1 s of IQ
	return s.sp.children.find(c => c.args[0] === "run") as FakeChild
}

function assertNoSecrets(
	lines: ReturnType<typeof spyLogger>["lines"],
	secrets: string[],
) {
	const text = logText(lines)
	for (const s of secrets) expect(text).not.toContain(s)
}

describe("IqCaptureService off states", () => {
	it("absent or disabled: no process, no directory, no file", async () => {
		for (const config of [undefined, { ...CFG, enabled: false }]) {
			const s = await setup({ config })
			s.svc.attachSource("src", {
				sampleRateHz: FS,
				centerHz: CENTER,
				epoch: 3,
				engine: s.engine,
			})
			await s.svc.start()
			expect(await s.svc.sweep()).toEqual({ removed: 0, left: 0, failed: 0 })
			expect(s.svc.capture(req())).toEqual({ refused: "disabled" })
			expect(s.sp.spawn).not.toHaveBeenCalled()
			expect(s.engine.listeners.size).toBe(0)
			expect(fs.readdirSync(s.root)).toEqual([])
			expect(s.svc.state()).toBe("off")
			expect(s.lines).toEqual([])
			await s.svc.stop()
		}
	})

	it("legacy mode: not started, one info line, no directory", async () => {
		const s = await setup({ protectedMode: false })
		await s.svc.start()
		await s.svc.start()
		expect(s.svc.state()).toBe("not-protected")
		expect(s.lines.filter(l => l.level === "info")).toHaveLength(1)
		expect(s.lines).toHaveLength(1)
		expect(s.svc.capture(req())).toEqual({ refused: "not-protected" })
		expect(fs.readdirSync(s.root)).toEqual([])
		expect(s.sp.spawn).not.toHaveBeenCalled()
	})

	it("missing binary: capture off with one info and no tool failures", async () => {
		const s = await setup({}, { enoent: true })
		s.svc.attachSource("src", {
			sampleRateHz: FS,
			centerHz: CENTER,
			epoch: 3,
			engine: s.engine,
		})
		await s.svc.start()
		await flush()
		expect(s.svc.state()).toBe("unavailable")
		expect(s.lines.filter(l => l.level === "warn")).toHaveLength(0)
		expect(
			s.lines.filter(l => logText([l]).includes("tool not found")),
		).toEqual([
			{
				level: "info",
				args: [
					"IQ capture tool not found; capture is off; build it with make chan-build",
				],
			},
		])
		expect(s.svc.counters().toolFailures).toBe(0)
		expect(s.svc.counters().lastToolFailure).toBeNull()
		expect(s.svc.capture(req())).toEqual({ refused: "unavailable" })
		expect(
			s.svc.near("src", RF, 1000, { observationId: null, limit: 2 }),
		).toEqual([])
		expect(s.svc.openReplay("x", "dsd-fme")).toBeNull()
		s.timers.advance(120_000)
		expect(s.sp.spawn).toHaveBeenCalledTimes(1)
		assertNoSecrets(s.lines, ["/opt/wavekit-iqcap", s.root])
	})

	it("refuses a symlinked capture directory with one warn", async () => {
		const s = await setup()
		const other = path.join(base, `o${n++}`)
		await fsp.mkdir(other, { mode: 0o700 })
		await fsp.symlink(other, path.join(s.root, "iq-captures"))
		await s.svc.start()
		expect(s.svc.state()).toBe("unavailable")
		expect(s.lines.filter(l => l.level === "warn")).toHaveLength(1)
		assertNoSecrets(s.lines, [s.root, other])
	})
})

describe("IqCaptureService capture flow", () => {
	it("captures, proves and queues a file; settle discards it; logs carry no ids/paths/frequencies", async () => {
		const s = await setup()
		const child = await running(s)
		const finished: string[] = []
		s.svc.onFinished(v => finished.push(v.captureId))
		const got = s.svc.capture(req({ fromSample: FS / 2 }))
		expect(got).toHaveProperty("captureId")
		const id = "captureId" in got ? got.captureId : ""
		const cmd = child.commands().find(c => c["type"] === "capture")
		expect(cmd).toMatchObject({ id, offsetHz: RF - CENTER, maxMs: 4000 })
		// pre-roll 500 ms before the track start, mapped to the tool's count.
		expect(cmd?.["fromSample"]).toBeLessThanOrEqual(FS / 2 - FS / 2)
		await flush()
		expect(finished).toEqual([id])
		const near = s.svc.near("src", RF, 1000, { observationId: null, limit: 2 })
		expect(near.map(v => v.captureId)).toEqual([id])
		expect(near[0]?.durationMs).toBe(100)
		expect(s.svc.claim(id, "job-1")).toBe(true)
		s.svc.settle(id, "job-1")
		await flush(10)
		expect(fs.readdirSync(path.join(s.root, "iq-captures"))).toEqual([])
		expect(s.svc.counters().discarded.result).toBe(1)
		await s.svc.stop()
		assertNoSecrets(s.lines, [
			id,
			s.root,
			String(RF),
			"446006250",
			"/opt/wavekit-iqcap",
		])
	})

	it("rate limit 6 vs 7 and concurrency 2 vs 3 through the port", async () => {
		const s = await setup({}, { behaviour: "silent" })
		await running(s)
		expect(s.svc.capture(req())).toHaveProperty("captureId")
		expect(s.svc.capture(req())).toHaveProperty("captureId")
		expect(s.svc.capture(req())).toEqual({ refused: "busy" })
		expect(s.svc.counters().refused.busy).toBe(1)
		await s.svc.stop()
		const r = await setup()
		await running(r)
		for (let i = 0; i < 6; i++) {
			expect(r.svc.capture(req())).toHaveProperty("captureId")
			await flush()
		}
		expect(r.svc.capture(req())).toEqual({ refused: "rate-limited" })
		await r.svc.stop()
	})

	it("refuses invalid requests, an offset outside the span and another epoch", async () => {
		const s = await setup()
		await running(s)
		expect(s.svc.capture(req({ rfHz: Number.NaN }))).toEqual({
			refused: "invalid",
		})
		expect(s.svc.capture(req({ rfHz: CENTER + FS / 2 }))).toEqual({
			refused: "invalid",
		})
		expect(s.svc.capture(req({ epoch: 4 }))).toEqual({
			refused: "epoch-changed",
		})
		expect(s.svc.capture(req({ sourceId: "other" }))).toEqual({
			refused: "unavailable",
		})
		expect(
			s.svc.capture({ ...req(), reason: "x" } as unknown as IqCaptureRequest),
		).toEqual({
			refused: "invalid",
		})
		await s.svc.stop()
	})

	it("refuses a hostile uuid source", async () => {
		const s = await setup({ randomUUID: () => "../../etc/passwd" })
		await running(s)
		expect(s.svc.capture(req())).toEqual({ refused: "invalid" })
		await s.svc.stop()
	})

	it("hostile tool lines never change state", async () => {
		const s = await setup({}, { behaviour: "silent" })
		const child = await running(s)
		const got = s.svc.capture(req())
		const id = "captureId" in got ? got.captureId : ""
		const other = "bbbbbbbb-0000-4000-8000-000000000000"
		child.emitLine("x".repeat(5000))
		child.emitLine("{bad json")
		child.event({ type: "teleport", id })
		child.event({ type: "captured", id: other, samples: 10, gapSamples: 0 })
		child.event({ type: "captured", id: "../x", samples: 10, gapSamples: 0 })
		child.event({ type: "aborted", id: other, reason: "io" })
		child.event({ type: "error", code: "io", id: other })
		await flush()
		// Safety: every event naming an id this process was not asked for (3) is hostile.
		expect(s.svc.counters().hostileEvents).toBe(3)
		expect(s.svc.counters().tool.oversizeLines).toBe(1)
		expect(s.svc.counters().tool.invalidLines).toBe(3)
		// Samples beyond the bound: removed as invalid, the file never queued.
		fs.writeFileSync(
			path.join(s.root, "iq-captures", `${id}.cf32`),
			Buffer.alloc(8),
		)
		child.event({ type: "captured", id, samples: 192_001, gapSamples: 0 })
		await flush(10)
		expect(
			s.svc.near("src", RF, 1e6, { observationId: "obs", limit: 9 }),
		).toEqual([])
		expect(s.svc.counters().discarded.invalid).toBe(1)
		expect(fs.readdirSync(path.join(s.root, "iq-captures"))).toEqual([])
		// A repeat after the tool's final event for the id is hostile too (r7 B2), and ignored.
		child.event({ type: "captured", id, samples: 1, gapSamples: 0 })
		await flush()
		// 3 foreign ids + the out-of-bound count + the repeat.
		expect(s.svc.counters().hostileEvents).toBe(5)
		await s.svc.stop()
	})

	it("a file that does not match the reported size is discarded as invalid", async () => {
		const s = await setup({}, { behaviour: "silent" })
		const child = await running(s)
		const got = s.svc.capture(req())
		const id = "captureId" in got ? got.captureId : ""
		fs.writeFileSync(
			path.join(s.root, "iq-captures", `${id}.cf32`),
			Buffer.alloc(80),
			{
				mode: 0o600,
			},
		)
		child.event({ type: "captured", id, samples: 4801, gapSamples: 0 })
		await flush(10)
		expect(s.svc.counters().discarded.invalid).toBe(1)
		await s.svc.stop()
	})

	it("flush drops open captures, restarts the tool and refuses the old epoch", async () => {
		const s = await setup({}, { behaviour: "silent" })
		await running(s)
		s.svc.capture(req())
		s.svc.flush("src", { epoch: 4 })
		await flush()
		expect(s.svc.counters().failed).toBe(1)
		expect(s.sp.children.filter(c => c.args[0] === "run")).toHaveLength(2)
		s.engine.push(FS)
		expect(s.svc.capture(req())).toEqual({ refused: "epoch-changed" })
		expect(s.svc.capture(req({ epoch: 4 }))).toHaveProperty("captureId")
		s.svc.flush("src")
		await flush()
		s.engine.push(FS)
		expect(s.svc.capture(req({ epoch: 4 }))).toEqual({
			refused: "epoch-changed",
		})
		expect(s.svc.counters().toolRestarts).toBe(0)
		await s.svc.stop()
	})

	it("confirmLive discards unreplayed captures; orphan TTL after 10 min", async () => {
		const s = await setup()
		await running(s)
		const a = s.svc.capture(req())
		await flush()
		const b = s.svc.capture(req({ observationId: "other" }))
		await flush(10)
		expect(s.svc.confirmLive("src", "obs")).toBe(1)
		expect("captureId" in a && s.svc.view(a.captureId)).toBeNull()
		s.timers.advance(599_000)
		expect("captureId" in b && s.svc.view(b.captureId)).not.toBeNull()
		s.timers.advance(11_000)
		expect("captureId" in b && s.svc.view(b.captureId)).toBeNull()
		expect(s.svc.counters().discarded["orphan-ttl"]).toBe(1)
		await s.svc.stop()
	})

	it("orphan TTL is exact: kept at 599 999 ms after its finish, discarded at 600 000 ms", async () => {
		const s = await setup()
		await running(s)
		const a = s.svc.capture(req())
		await flush(10)
		const cid = "captureId" in a ? a.captureId : ""
		expect(s.svc.view(cid)).not.toBeNull()
		s.timers.advance(599_999)
		expect(s.svc.view(cid)).not.toBeNull()
		s.timers.advance(1)
		expect(s.svc.view(cid)).toBeNull()
		expect(s.svc.counters().discarded["orphan-ttl"]).toBe(1)
		await s.svc.stop()
	})

	it("orphan TTL re-arms for a later capture after an earlier one is gone", async () => {
		const s = await setup()
		await running(s)
		const a = s.svc.capture(req())
		await flush(10)
		s.timers.advance(1000)
		const b = s.svc.capture(req({ observationId: "other" }))
		await flush(10)
		const bid = "captureId" in b ? b.captureId : ""
		expect("captureId" in a && s.svc.confirmLive("src", "obs")).toBe(1)
		s.timers.advance(599_999)
		expect(s.svc.view(bid)).not.toBeNull()
		s.timers.advance(1)
		expect(s.svc.view(bid)).toBeNull()
		await s.svc.stop()
	})

	it("confirmLive on a capture still being written ends it and counts it confirmed-live", async () => {
		const s = await setup({}, { behaviour: "silent" })
		const child = await running(s)
		const a = s.svc.capture(req())
		const cid = "captureId" in a ? a.captureId : ""
		expect(s.svc.confirmLive("src", "obs")).toBe(1)
		expect(child.commands()).toContainEqual({ type: "end", id: cid })
		// The tool finishes the file after the end command: discarded, not queued.
		const outDir = child.args[child.args.indexOf("--out-dir") + 1] ?? ""
		fs.writeFileSync(path.join(outDir, `${cid}.cf32`), Buffer.alloc(800), {
			mode: 0o600,
		})
		const finished: string[] = []
		s.svc.onFinished(v => finished.push(v.captureId))
		child.event({ type: "captured", id: cid, samples: 100, gapSamples: 0 })
		await flush(10)
		expect(finished).toEqual([])
		expect(s.svc.view(cid)).toBeNull()
		expect(s.svc.counters().discarded["confirmed-live"]).toBe(1)
		expect(s.svc.counters().failed).toBe(0)
		expect(fs.readdirSync(outDir)).toEqual([])
		// An aborted one counts the same.
		const b = s.svc.capture(req({ reason: "identify" }))
		const bid = "captureId" in b ? b.captureId : ""
		expect(s.svc.confirmLive("src", "obs")).toBe(1)
		child.event({ type: "aborted", id: bid, reason: "bound" })
		await flush(10)
		expect(s.svc.counters().discarded["confirmed-live"]).toBe(2)
		expect(s.svc.counters().failed).toBe(0)
		await s.svc.stop()
	})

	it("shapes may be set after construction, before start; without them capture is off", async () => {
		const late = await setup({}, { noShapes: true })
		late.svc.setShapes(SHAPES)
		await running(late)
		expect(late.svc.state()).toBe("on")
		expect(late.svc.capture(req())).toHaveProperty("captureId")
		await late.svc.stop()
		const none = await setup({}, { noShapes: true })
		await running(none)
		expect(none.svc.state()).toBe("unavailable")
		expect(none.sp.children).toEqual([])
		await none.svc.stop()
	})

	it("a capture shorter than 100 ms (4 799 samples) is invalid and never queued; 4 800 is kept", async () => {
		for (const [samples, kept] of [
			[4799, false],
			[4800, true],
		] as const) {
			const s = await setup({}, { samples })
			await running(s)
			const finished: string[] = []
			s.svc.onFinished(v => finished.push(v.captureId))
			const got = s.svc.capture(req())
			await flush(10)
			const cid = "captureId" in got ? got.captureId : ""
			expect(finished).toEqual(kept ? [cid] : [])
			expect(s.svc.view(cid) !== null).toBe(kept)
			expect(s.svc.counters().discarded.invalid).toBe(kept ? 0 : 1)
			expect(s.svc.counters().hostileEvents).toBe(0)
			await s.svc.stop()
		}
	})

	it("the tool's late final event for a capture Node already ended is not hostile; a repeat and unknown ids are", async () => {
		const s = await setup({}, { behaviour: "silent" })
		const child = await running(s)
		const got = s.svc.capture(req())
		const cid = "captureId" in got ? got.captureId : ""
		s.timers.advance(4000 + 10_000) // dropped after bound plus grace
		expect(s.svc.counters().failed).toBe(1)
		child.event({ type: "captured", id: cid, samples: 4800, gapSamples: 0 })
		child.event({ type: "aborted", id: cid, reason: "bound" })
		child.event({
			type: "aborted",
			id: "bbbbbbbb-0000-4000-8000-000000000001",
			reason: "io",
		})
		await flush()
		// The repeat (aborted after captured) and the unknown id (r7 B2).
		expect(s.svc.counters().hostileEvents).toBe(2)
		expect(s.svc.counters().failed).toBe(1)
		await s.svc.stop()
	})

	it("after a gap the capture start is never older than the gap's end", async () => {
		const s = await setup({}, { behaviour: "silent" })
		const child = await running(s) // tool samples 0 .. FS
		s.engine.edge += 1000 // 1000 engine samples lost
		s.engine.push(FS / 10)
		const got = s.svc.capture(req({ fromSample: 0 }))
		expect(got).toHaveProperty("captureId")
		const cmd = child.commands().find(c => c["type"] === "capture")
		expect(child.commands()).toContainEqual({ type: "gap", samples: 1000 })
		expect(cmd?.["fromSample"]).toBe(FS + 1000)
		await s.svc.stop()
	})

	it("sweep refuses while capture is on (a live file is no leftover)", async () => {
		const s = await setup({}, { behaviour: "silent" })
		await running(s)
		const got = s.svc.capture(req())
		const cid = "captureId" in got ? got.captureId : ""
		const file = path.join(s.root, "iq-captures", `${cid}.cf32.tmp`)
		fs.writeFileSync(file, Buffer.alloc(8), { mode: 0o600 })
		expect(await s.svc.sweep()).toEqual({ removed: 0, left: 0, failed: 0 })
		expect(fs.existsSync(file)).toBe(true)
		await s.svc.stop()
	})

	it("a capture with no tool answer is dropped after its bound plus grace", async () => {
		const s = await setup({}, { behaviour: "silent" })
		await running(s)
		s.svc.capture(req())
		s.timers.advance(4000 + 10_000)
		expect(s.svc.counters().failed).toBe(1)
		await s.svc.stop()
	})
})

describe("IqCaptureService supervision", () => {
	it("restarts with backoff 1 s, 2 s, 4 s, 8 s and gives up after 5 failures in 10 min (one warn)", async () => {
		const s = await setup()
		await running(s)
		const runs = () => s.sp.children.filter(c => c.args[0] === "run")
		const crash = async () => {
			runs().at(-1)?.exit(101)
			await flush()
		}
		await crash()
		s.timers.advance(999)
		expect(runs()).toHaveLength(1)
		s.timers.advance(1)
		expect(runs()).toHaveLength(2)
		await flush()
		await crash()
		s.timers.advance(2000)
		expect(runs()).toHaveLength(3)
		await flush()
		await crash()
		s.timers.advance(4000)
		expect(runs()).toHaveLength(4)
		await flush()
		await crash()
		s.timers.advance(8000)
		expect(runs()).toHaveLength(5)
		await flush()
		await crash()
		s.timers.advance(600_000)
		expect(runs()).toHaveLength(5)
		expect(s.svc.counters().toolGiveUps).toBe(1)
		expect(s.lines.filter(l => l.level === "warn")).toHaveLength(1)
		expect(s.svc.capture(req())).toEqual({ refused: "unavailable" })
		await s.svc.stop()
	})

	it("reports one bounded diagnostic per failed spawn and preserves startup arguments", async () => {
		const s = await setup()
		try {
			const child = await running(s)
			expect(child.args).toEqual([
				"run",
				"--sample-rate",
				"2048000",
				"--ring-ms",
				"2000",
				"--out-dir",
				path.join(s.root, "iq-captures"),
				"--max-ms",
				"4000",
				"--bandwidth",
				"16000",
				"--anchor",
				s.root,
			])
			child.stderr.write("control fd 3 is not open; secret-native-output")
			await flush()
			child.exit(2)
			child.emit("close", 2, null)
			expect(s.svc.counters().toolFailures).toBe(1)
			expect(s.svc.counters().lastToolFailure).toEqual({
				exitCode: 2,
				signal: null,
				phase: "exit-after-ready",
				reason: "control-fd",
			})
			expect(
				s.lines.filter(line => line.args[1] === "IQ capture tool failed"),
			).toHaveLength(1)
			expect(logText(s.lines)).not.toContain("secret-native-output")
		} finally {
			await s.svc.stop()
		}
	})

	it("stop shuts the tools down and discards everything", async () => {
		const s = await setup()
		const child = await running(s)
		s.svc.capture(req())
		await flush(10)
		await s.svc.stop()
		expect(child.commands().at(-1)).toEqual({ type: "shutdown" })
		expect(s.svc.counters().discarded.shutdown).toBe(1)
		expect(fs.readdirSync(path.join(s.root, "iq-captures"))).toEqual([])
		expect(s.engine.listeners.size).toBe(0)
	})

	it("start sweeps leftovers of an earlier run", async () => {
		const s = await setup()
		const dir = path.join(s.root, "iq-captures")
		await fsp.mkdir(dir, { mode: 0o700 })
		fs.writeFileSync(
			path.join(dir, "aaaaaaaa-0000-4000-8000-00000000ffff.cf32.tmp"),
			"x",
		)
		fs.writeFileSync(path.join(dir, "notes.txt"), "x")
		await s.svc.start()
		expect(fs.readdirSync(dir)).toEqual(["notes.txt"])
		expect(s.svc.counters().sweep).toEqual({ removed: 1, left: 1, failed: 0 })
		await s.svc.stop()
	})
})

describe("IqCaptureService openReplay", () => {
	async function ready() {
		const s = await setup()
		await running(s)
		const got = s.svc.capture(req())
		await flush(10)
		const id = "captureId" in got ? got.captureId : ""
		return { s, id }
	}
	function lastReplay(s: Awaited<ReturnType<typeof setup>>) {
		return s.sp.children.filter(c => c.args[0] === "replay").at(-1) as FakeChild
	}
	async function readAll(
		r: Readable,
	): Promise<{ bytes: number; error: unknown }> {
		let bytes = 0
		return new Promise(resolve => {
			r.on("data", (b: Buffer) => (bytes += b.length))
			r.on("end", () => resolve({ bytes, error: null }))
			r.on("error", error => resolve({ bytes, error }))
		})
	}

	it("refuses rtl433 without its shape, unknown and unready captures", async () => {
		const { s, id } = await ready()
		expect(s.svc.openReplay(id, "rtl433")).toBeNull()
		expect(s.svc.openReplay("nope", "dsd-fme")).toBeNull()
		await s.svc.stop()
	})

	it("replays into rtl433 with the whole-capture shape when it is given", async () => {
		const rtl433 = wholeCaptureShape(captureBandwidthHz(SHAPES))
		expect(rtl433).toEqual({ bandwidthHz: 16_000, transitionHz: 16_000 })
		const s = await setup({
			shapes: { ...SHAPES, ...(rtl433 ? { rtl433 } : {}) },
		})
		await running(s)
		const got = s.svc.capture(req())
		await flush(10)
		const id = "captureId" in got ? got.captureId : ""
		const out = s.svc.openReplay(id, "rtl433")
		expect(out).not.toBeNull()
		expect(lastReplay(s).args).toEqual([
			"replay",
			"--in",
			"/dev/fd/3",
			"--bandwidth",
			"16000",
			"--transition",
			"16000",
		])
		await s.svc.stop()
	})

	it("hands the proven fd to the tool as /dev/fd/3 with the decoder shape; ends on clean EOF", async () => {
		const { s, id } = await ready()
		const out = s.svc.openReplay(id, "multimon-ng")
		expect(out).not.toBeNull()
		const child = lastReplay(s)
		expect(child.args).toEqual([
			"replay",
			"--in",
			"/dev/fd/3",
			"--bandwidth",
			"16000",
			"--transition",
			"576",
		])
		const stdio = child.options.stdio as unknown[]
		expect(stdio.slice(0, 3)).toEqual(["ignore", "pipe", "pipe"])
		expect(typeof stdio[3]).toBe("number")
		// Claim is refused once its replay started; confirmLive skips it; a discard waits.
		expect(s.svc.claim(id, "job")).toBe(false)
		expect(s.svc.confirmLive("src", "obs")).toBe(0)
		s.svc.discard(id, "result")
		expect(fs.existsSync(path.join(s.root, "iq-captures", `${id}.cf32`))).toBe(
			true,
		)
		const done = readAll(out as Readable)
		child.stdout.write(Buffer.alloc(4800 * 8))
		child.exit(0)
		expect(await done).toEqual({ bytes: 4800 * 8, error: null })
		await flush(10)
		expect(fs.existsSync(path.join(s.root, "iq-captures", `${id}.cf32`))).toBe(
			false,
		)
		await s.svc.stop()
	})

	it("a failing replay ends the stream with an error; more bytes than the file is a failure", async () => {
		const { s, id } = await ready()
		const out = s.svc.openReplay(id, "dsd-fme") as Readable
		const done = readAll(out)
		lastReplay(s).exit(2)
		expect((await done).error).toBeInstanceOf(Error)
		const out2 = s.svc.openReplay(id, "dsd-fme") as Readable
		const done2 = readAll(out2)
		lastReplay(s).stdout.write(Buffer.alloc(4800 * 8 + 8))
		expect((await done2).error).toBeInstanceOf(Error)
		expect(s.svc.counters().replayFailures).toBe(2)
		await s.svc.stop()
	})

	it("a swapped or tampered file is never replayed and is discarded", async () => {
		const { s, id } = await ready()
		const file = path.join(s.root, "iq-captures", `${id}.cf32`)
		fs.unlinkSync(file)
		fs.symlinkSync("/etc/hosts", file)
		expect(s.svc.openReplay(id, "dsd-fme")).toBeNull()
		expect(s.svc.counters().discarded.invalid).toBe(1)
		await flush(10)
		expect(fs.existsSync("/etc/hosts")).toBe(true)
		await s.svc.stop()
	})
})

describe("IqCaptureService Main review 1 (m1, m2, m4, M2)", () => {
	const PER_CAPTURE = 4000 * 48 * 8

	it("m4: a capture Node timed out keeps its concurrency slot until the tool's final event", async () => {
		const s = await setup({}, { behaviour: "silent" })
		const child = await running(s)
		const a = s.svc.capture(req())
		const b = s.svc.capture(req())
		expect("captureId" in a && "captureId" in b).toBe(true)
		s.timers.advance(4000 + 10_000)
		expect(s.svc.counters().failed).toBe(2)
		// The tool still holds both: a third request would be answered `busy` by the tool.
		expect(s.svc.capture(req())).toEqual({ refused: "busy" })
		child.event({
			type: "aborted",
			id: "captureId" in a ? a.captureId : "",
			reason: "bound",
		})
		await flush(10)
		expect(s.svc.capture(req())).toHaveProperty("captureId")
		await s.svc.stop()
	})

	it("m2: cap bytes stay held until the tool's final event; a late `captured` file is unlinked", async () => {
		const s = await setup({}, { behaviour: "silent" })
		const child = await running(s)
		const got = s.svc.capture(req())
		const id = "captureId" in got ? got.captureId : ""
		s.timers.advance(4000 + 10_000)
		await flush(10)
		expect(s.svc.heldBytes()).toBe(PER_CAPTURE)
		const file = path.join(s.root, "iq-captures", `${id}.cf32`)
		fs.writeFileSync(file, Buffer.alloc(4800 * 8), { mode: 0o600 })
		child.event({ type: "captured", id, samples: 4800, gapSamples: 0 })
		await flush(10)
		expect(fs.existsSync(file)).toBe(false)
		expect(s.svc.heldBytes()).toBe(0)
		expect(s.svc.counters().hostileEvents).toBe(0)
		await s.svc.stop()
	})

	it("m2 / r7 B2: a `captured` after the tool's final event for the id is hostile and touches nothing", async () => {
		const s = await setup({}, { behaviour: "silent" })
		const child = await running(s)
		const got = s.svc.capture(req())
		const id = "captureId" in got ? got.captureId : ""
		s.timers.advance(4000 + 10_000)
		child.event({ type: "aborted", id, reason: "io" })
		await flush(10)
		expect(s.svc.heldBytes()).toBe(0)
		const file = path.join(s.root, "iq-captures", `${id}.cf32`)
		fs.writeFileSync(file, Buffer.alloc(4800 * 8), { mode: 0o600 })
		const hostile = s.svc.counters().hostileEvents
		child.event({ type: "captured", id, samples: 4800, gapSamples: 0 })
		await flush(10)
		// Not this process's own open or abandoned capture any more: ignored (the startup sweep
		// removes such a leftover); the store and the cap are untouched.
		expect(fs.existsSync(file)).toBe(true)
		expect(s.svc.counters().hostileEvents).toBe(hostile + 1)
		expect(s.svc.heldBytes()).toBe(0)
		await s.svc.stop()
	})

	it("m2: bytes of captures dropped by a flush are released when the old tool exits", async () => {
		const s = await setup({}, { behaviour: "silent" })
		const child = await running(s)
		child.autoExit = false
		s.svc.capture(req())
		s.svc.flush("src", { epoch: 4 })
		await flush(10)
		expect(s.svc.heldBytes()).toBe(PER_CAPTURE)
		child.exit(0)
		await flush(10)
		expect(s.svc.heldBytes()).toBe(0)
		await s.svc.stop()
	})

	it("m1: a gap aborts the open captures (ended in the tool, never queued)", async () => {
		const s = await setup({}, { behaviour: "silent" })
		const child = await running(s)
		const got = s.svc.capture(req())
		const id = "captureId" in got ? got.captureId : ""
		const finished: string[] = []
		s.svc.onFinished(v => finished.push(v.captureId))
		// 1000 samples lost upstream, then the stream goes on.
		s.engine.edge += 1000
		s.engine.push(100)
		await flush(10)
		expect(s.svc.counters().failed).toBe(1)
		expect(child.commands()).toContainEqual({ type: "end", id })
		const file = path.join(s.root, "iq-captures", `${id}.cf32`)
		fs.writeFileSync(file, Buffer.alloc(4800 * 8), { mode: 0o600 })
		child.event({ type: "captured", id, samples: 4800, gapSamples: 1000 })
		await flush(10)
		expect(finished).toEqual([])
		expect(fs.existsSync(file)).toBe(false)
		await s.svc.stop()
	})

	it("M2: captureFor reserves the capture for its requester: held when finished, claim idempotent, hidden from near", async () => {
		const s = await setup()
		await running(s)
		const finished: string[] = []
		s.svc.onFinished(v => finished.push(v.captureId))
		const got = s.svc.captureFor(req({ reason: "identify" }), "job-1")
		const id = "captureId" in got ? got.captureId : ""
		await flush(10)
		expect(finished).toEqual([id])
		expect(s.svc.holderOf(id)).toBe("job-1")
		expect(s.svc.view(id)).not.toBeNull()
		expect(s.svc.claim(id, "iq-replay-queue")).toBe(false)
		expect(s.svc.claim(id, "job-1")).toBe(true)
		expect(
			s.svc.near("src", RF, 1000, { observationId: "obs", limit: 2 }),
		).toEqual([])
		s.svc.settle(id, "job-1")
		await flush(10)
		expect(s.svc.holderOf(id)).toBeUndefined()
		await s.svc.stop()
	})

	it("M2: settling a reserved capture still being written ends it in the tool", async () => {
		const s = await setup({}, { behaviour: "silent" })
		const child = await running(s)
		const got = s.svc.captureFor(req({ reason: "identify" }), "job-1")
		const id = "captureId" in got ? got.captureId : ""
		s.svc.settle(id, "job-1")
		expect(child.commands()).toContainEqual({ type: "end", id })
		expect(s.svc.holderOf(id)).toBeUndefined()
		await s.svc.stop()
	})
})

describe("IqCaptureService review", () => {
	it("BLOCKING: discard refuses a swapped capture directory (nothing outside is unlinked, capture off)", async () => {
		const s = await setup()
		await running(s)
		const got = s.svc.capture(req())
		const id = "captureId" in got ? got.captureId : ""
		await flush(10)
		const dir = path.join(s.root, "iq-captures")
		const outside = path.join(base, `outside-${n++}`)
		await fsp.mkdir(outside, { mode: 0o700 })
		const victim = path.join(outside, `${id}.cf32`)
		await fsp.writeFile(victim, "must stay", { mode: 0o600 })
		await fsp.rename(dir, `${dir}.old`)
		await fsp.symlink(outside, dir)
		s.svc.discard(id, "result")
		await flush(10)
		const preserved = fs.existsSync(victim)
		const state = s.svc.state()
		const refusals = s.svc.counters().dirRefusals
		await s.svc.stop()
		expect(preserved).toBe(true)
		expect(state).toBe("unavailable")
		expect(refusals).toBeGreaterThanOrEqual(1)
	})

	it("BLOCKING: a directory replaced by another real directory (other inode) is refused too", async () => {
		const s = await setup()
		await running(s)
		const got = s.svc.capture(req())
		const id = "captureId" in got ? got.captureId : ""
		await flush(10)
		const dir = path.join(s.root, "iq-captures")
		await fsp.rename(dir, `${dir}.old`)
		await fsp.mkdir(dir, { mode: 0o700 })
		const victim = path.join(dir, `${id}.cf32`)
		await fsp.writeFile(victim, "must stay", { mode: 0o600 })
		s.svc.discard(id, "result")
		await flush(10)
		const preserved = fs.existsSync(victim)
		await s.svc.stop()
		expect(preserved).toBe(true)
	})

	it("MAJOR d: detach holds bytes until the old writer exits and removes its late publication", async () => {
		const s = await setup({}, { behaviour: "silent" })
		const child = await running(s)
		child.autoExit = false
		const got = s.svc.capture(req())
		const id = "captureId" in got ? got.captureId : ""
		s.svc.detachSource("src")
		await flush(10)
		const heldBeforeExit = s.svc.heldBytes()
		const file = path.join(s.root, "iq-captures", `${id}.cf32`)
		fs.writeFileSync(file, Buffer.alloc(4800 * 8), { mode: 0o600 })
		child.event({ type: "captured", id, samples: 4800, gapSamples: 0 })
		child.exit(0)
		await flush(10)
		const leftAfterExit = fs.existsSync(file)
		const heldAfterExit = s.svc.heldBytes()
		await s.svc.stop()
		expect({ heldBeforeExit, leftAfterExit, heldAfterExit }).toEqual({
			heldBeforeExit: 4000 * 48 * 8,
			leftAfterExit: false,
			heldAfterExit: 0,
		})
	})

	it("MAJOR d: replacing a writer (flush) does not free its still-open concurrency slots", async () => {
		const s = await setup({}, { behaviour: "silent" })
		const child = await running(s)
		child.autoExit = false
		s.svc.capture(req())
		s.svc.capture(req())
		s.svc.flush("src", { epoch: 4 })
		await flush(10)
		s.engine.push(1000)
		const third = s.svc.capture(req({ epoch: 4 }))
		child.exit(0)
		await flush(10)
		const fourth = s.svc.capture(req({ epoch: 4 }))
		await s.svc.stop()
		expect(third).toEqual({ refused: "busy" })
		expect(fourth).toHaveProperty("captureId")
	})
})

describe("IqCaptureService sweep before the storage root exists", () => {
	it("a missing root is nothing to sweep and does not disable capture; start then creates the dir", async () => {
		const s = await setup()
		const missing = path.join(base, `late-root-${n++}`)
		const svc = createIqCaptureService({
			config: CFG,
			storageRoot: missing,
			protectedMode: true,
			logger: s.logger,
			shapes: SHAPES,
			now: () => s.timers.t,
			spawn: s.sp.spawn,
			timers: s.timers,
			env: {},
		})
		expect(await svc.sweep()).toEqual({ removed: 0, left: 0, failed: 0 })
		expect(svc.state()).toBe("idle")
		await fsp.mkdir(missing)
		await svc.start()
		expect(svc.state()).toBe("on")
		expect(fs.statSync(path.join(missing, "iq-captures")).isDirectory()).toBe(
			true,
		)
		await svc.stop()
	})
})

describe("IqCaptureService canonical storage root", () => {
	async function aliased() {
		const s = await setup()
		const outside = path.join(base, `outside-root-${n++}`)
		await fsp.mkdir(outside)
		const alias = path.join(base, `alias-${n++}`)
		await fsp.symlink(outside, alias)
		const svc = createIqCaptureService({
			config: CFG,
			storageRoot: path.join(alias, "new-root"),
			protectedMode: true,
			logger: s.logger,
			shapes: SHAPES,
			now: () => s.timers.t,
			spawn: s.sp.spawn,
			timers: s.timers,
			env: {},
		})
		const canonical = path.join(fs.realpathSync(outside), "new-root")
		return { s, svc, outside, alias, canonical }
	}
	const outDirOf = (s: Awaited<ReturnType<typeof setup>>) => {
		const run = s.sp.children.find(c => c.args[0] === "run")
		return run?.args[run.args.indexOf("--out-dir") + 1]
	}

	it("a symlinked ancestor (operator territory, like /tmp) works: everything happens under the canonical root", async () => {
		const { s, svc, canonical } = await aliased()
		svc.attachSource("src", {
			sampleRateHz: FS,
			centerHz: CENTER,
			epoch: 3,
			engine: s.engine,
		})
		await svc.start()
		await flush()
		expect(svc.state()).toBe("on")
		expect(outDirOf(s)).toBe(path.join(canonical, "iq-captures"))
		expect(fs.lstatSync(canonical).isDirectory()).toBe(true)
		expect(fs.statSync(canonical).mode & 0o777).toBe(0o700)
		await svc.stop()
	})

	it("a later swap of the canonical root for a symlink is refused (nothing outside unlinked, capture off)", async () => {
		const { s, svc, canonical } = await aliased()
		svc.attachSource("src", {
			sampleRateHz: FS,
			centerHz: CENTER,
			epoch: 3,
			engine: s.engine,
		})
		await svc.start()
		await flush()
		s.engine.push(FS)
		const got = svc.capture(req())
		const id = "captureId" in got ? got.captureId : ""
		await flush(10)
		const elsewhere = path.join(base, `elsewhere-${n++}`)
		await fsp.mkdir(path.join(elsewhere, "iq-captures"), {
			recursive: true,
			mode: 0o700,
		})
		const victim = path.join(elsewhere, "iq-captures", `${id}.cf32`)
		await fsp.writeFile(victim, "must stay", { mode: 0o600 })
		await fsp.rename(canonical, `${canonical}.old`)
		await fsp.symlink(elsewhere, canonical)
		svc.discard(id, "result")
		await flush(10)
		expect(fs.existsSync(victim)).toBe(true)
		expect(svc.state()).toBe("unavailable")
		await svc.stop()
	})

	it("a later swap of the canonical root for another real directory is refused", async () => {
		const { s, svc, canonical } = await aliased()
		svc.attachSource("src", {
			sampleRateHz: FS,
			centerHz: CENTER,
			epoch: 3,
			engine: s.engine,
		})
		await svc.start()
		await flush()
		s.engine.push(FS)
		const got = svc.capture(req())
		const id = "captureId" in got ? got.captureId : ""
		await flush(10)
		await fsp.rename(canonical, `${canonical}.old`)
		await fsp.mkdir(path.join(canonical, "iq-captures"), {
			recursive: true,
			mode: 0o700,
		})
		const victim = path.join(canonical, "iq-captures", `${id}.cf32`)
		await fsp.writeFile(victim, "must stay", { mode: 0o600 })
		svc.discard(id, "result")
		await flush(10)
		expect(fs.existsSync(victim)).toBe(true)
		expect(svc.state()).toBe("unavailable")
		await svc.stop()
	})
})

describe("IqCaptureService re-proves the anchored chain before commands and spawns", () => {
	it("root swapped for a symlink to the moved root: no capture command is sent, capture off", async () => {
		const s = await setup({}, { behaviour: "silent" })
		const child = await running(s)
		const moved = `${s.root}-moved`
		await fsp.rename(s.root, moved)
		await fsp.symlink(moved, s.root)
		const got = s.svc.capture(req())
		const sent = child.commands().filter(c => c["type"] === "capture")
		const state = s.svc.state()
		await s.svc.stop()
		expect(got).toEqual({ refused: "unavailable" })
		expect(sent).toEqual([])
		expect(state).toBe("unavailable")
	})

	it("passes the canonical anchor to the tool", async () => {
		const s = await setup()
		const child = await running(s)
		const args = child.args
		expect(args[args.indexOf("--anchor") + 1]).toBe(s.root)
		await s.svc.stop()
	})

	it("a tool restart after the root was swapped is refused (no spawn)", async () => {
		const s = await setup()
		const child = await running(s)
		const runs = () => s.sp.children.filter(c => c.args[0] === "run").length
		const moved = `${s.root}-moved`
		await fsp.rename(s.root, moved)
		await fsp.symlink(moved, s.root)
		child.exit(101)
		await flush()
		s.timers.advance(1000)
		const n = runs()
		await s.svc.stop()
		expect(n).toBe(1)
	})
})

describe("IqCaptureService: a process speaks only for its own captures", () => {
	it("a detached source's live tool naming another source's capture touches nothing (hostile)", async () => {
		const s = await setup({}, { behaviour: "silent" })
		const childA = await running(s)
		childA.autoExit = false
		const engineB = new (s.engine.constructor as new () => typeof s.engine)()
		s.svc.attachSource("srcB", {
			sampleRateHz: FS,
			centerHz: CENTER,
			epoch: 3,
			engine: engineB,
		})
		await flush()
		const childB = s.sp.children.filter(c => c.args[0] === "run").at(-1)!
		expect(childB).not.toBe(childA)
		engineB.push(FS)
		const got = s.svc.capture(req({ sourceId: "srcB" }))
		const idB = "captureId" in got ? got.captureId : ""
		const fileB = path.join(s.root, "iq-captures", `${idB}.cf32`)
		fs.writeFileSync(fileB, Buffer.alloc(4800 * 8), { mode: 0o600 })
		childB.event({ type: "captured", id: idB, samples: 4800, gapSamples: 0 })
		await flush(10)
		expect(s.svc.view(idB)).not.toBeNull()
		const hostile = s.svc.counters().hostileEvents
		s.svc.detachSource("src")
		await flush()
		childA.event({ type: "captured", id: idB, samples: 4800, gapSamples: 0 })
		childA.event({ type: "aborted", id: idB, reason: "io" })
		await flush(10)
		const kept = fs.existsSync(fileB)
		const view = s.svc.view(idB)
		const hostileAfter = s.svc.counters().hostileEvents
		childA.exit(0)
		await s.svc.stop()
		expect(kept).toBe(true)
		expect(view).not.toBeNull()
		expect(hostileAfter - hostile).toBe(2)
	})
})

describe("IqCaptureService removal events", () => {
	it("every removal (settle, discard, failure) is announced once with the capture's observation", async () => {
		const s = await setup()
		await running(s)
		const removed: [string, string | null][] = []
		const off = s.svc.onRemoved((id, observationId) =>
			removed.push([id, observationId]),
		)
		const a = s.svc.capture(req({ observationId: "o_a" }))
		const b = s.svc.capture(req({ observationId: "o_b", reason: "identify" }))
		await flush(10)
		const ida = "captureId" in a ? a.captureId : ""
		const idb = "captureId" in b ? b.captureId : ""
		s.svc.claim(ida, "j")
		s.svc.settle(ida, "j")
		s.svc.discard(idb, "result")
		await flush(10)
		off()
		const c = s.svc.capture(req({ observationId: "o_c", reason: "identify" }))
		const idc = "captureId" in c ? c.captureId : ""
		await flush(10)
		s.svc.discard(idc, "result")
		await s.svc.stop()
		expect(removed).toEqual([
			[ida, "o_a"],
			[idb, "o_b"],
		])
	})
})

const trialResult = {
	outcome: "carrier-only" as const,
	mode: "nfm" as const,
	voice: false,
	tones: { ctcssHz: null, dcs: null, audioSeconds: 1 },
	stats: null,
}

async function trialTicks(s: Awaited<ReturnType<typeof setup>>, count = 5) {
	for (let i = 0; i < count; i++) {
		await flush(1)
		s.engine.push(FS / 100)
		s.timers.advance(10)
	}
	await flush()
}

describe("private analog capture leases", () => {
	it.each(["success", "failure", "abort", "throw"])(
		"deletes private files and stops the cold ring on %s",
		async end => {
			const s = await setup({
				config: { ...CFG, enabled: false },
				trialOnly: true,
			})
			await running(s)
			expect(s.sp.children).toHaveLength(0)
			expect(s.engine.listeners.size).toBe(0)
			expect(s.svc.capture(req())).toEqual({ refused: "disabled" })
			const events: string[] = []
			s.svc.onFinished(v => events.push(v.captureId))
			s.svc.onRemoved(id => events.push(id))
			const ac = new AbortController()
			let called = false
			const pending = s.svc
				.withTrial(req({ reason: "identify" }), ac.signal, async id => {
					called = true
					expect(
						fs.existsSync(path.join(s.root, "iq-captures", `${id}.cf32`)),
					).toBe(true)
					expect(s.svc.view(id)).toBeNull()
					expect(
						s.svc.near("src", RF, 1000, { observationId: "obs", limit: 10 }),
					).toEqual([])
					expect(s.svc.openReplay(id, "dsd-fme")).toBeNull()
					if (end === "throw") throw new TypeError("private trial failed")
					if (end === "abort") ac.abort()
					return end === "failure"
						? { ...trialResult, error: "analyze-failed" as const }
						: trialResult
				})
				.catch(() => null)
			await trialTicks(s)
			await pending
			expect(called).toBe(true)
			expect(events).toEqual([])
			expect(await fsp.readdir(path.join(s.root, "iq-captures"))).toEqual([])
			expect(s.svc.heldBytes()).toBe(0)
			expect(s.engine.listeners.size).toBe(0)
			expect(s.svc.counters().trialCaptures).toMatchObject({
				started: 1,
				completed: end === "success" ? 1 : 0,
				failed: end === "success" ? 0 : 1,
			})
			await s.svc.stop()
		},
	)

	it("sweeps private leftovers at startup with the usual file proofs", async () => {
		const s = await setup({
			config: { ...CFG, enabled: false },
			trialOnly: true,
		})
		const dir = path.join(s.root, "iq-captures")
		await fsp.mkdir(dir, { mode: 0o700 })
		await fsp.writeFile(
			path.join(dir, "aaaaaaaa-0000-4000-8000-000000000001.cf32"),
			Buffer.alloc(8),
			{ mode: 0o600 },
		)
		await s.svc.start()
		expect(await fsp.readdir(dir)).toEqual([])
		expect(s.svc.counters().trialCaptures?.swept).toBe(1)
		expect(s.sp.children).toHaveLength(0)
		await s.svc.stop()
	})

	it("fails closed in legacy mode without creating a tool or directory", async () => {
		const s = await setup({
			config: { ...CFG, enabled: false },
			trialOnly: true,
			protectedMode: false,
		})
		await running(s)
		expect(
			await s.svc.withTrial(req(), new AbortController().signal, () =>
				Promise.resolve(trialResult),
			),
		).toBe("not-protected")
		expect(s.sp.children).toHaveLength(0)
		expect(await fsp.readdir(s.root)).toEqual([])
		await s.svc.stop()
	})

	it("admits two per source and declines a third until a lease ends", async () => {
		const s = await setup({
			trialOnly: true,
			config: { ...CFG, enabled: false },
		})
		await running(s)
		const releases: (() => void)[] = []
		const run = () =>
			new Promise<typeof trialResult>(resolve =>
				releases.push(() => resolve(trialResult)),
			)
		const one = s.svc.withTrial(req(), new AbortController().signal, run)
		const two = s.svc.withTrial(req(), new AbortController().signal, run)
		await trialTicks(s)
		expect(releases).toHaveLength(2)
		expect(
			await s.svc.withTrial(req(), new AbortController().signal, run),
		).toBe("busy")
		await trialTicks(s, 10)
		expect(
			await s.svc.withTrial(req(), new AbortController().signal, run),
		).toBe("busy")
		releases.shift()?.()
		await one
		const three = s.svc.withTrial(req(), new AbortController().signal, () =>
			Promise.resolve(trialResult),
		)
		await trialTicks(s)
		expect(await three).toEqual(trialResult)
		releases.shift()?.()
		await two
		expect(s.engine.listeners.size).toBe(0)
		await s.svc.stop()
	})

	it("a swapped directory refuses a private lease", async () => {
		const s = await setup({
			trialOnly: true,
			config: { ...CFG, enabled: false },
		})
		await running(s)
		const dir = path.join(s.root, "iq-captures")
		await fsp.rename(dir, `${dir}-old`)
		await fsp.mkdir(dir, { mode: 0o700 })
		let called = false
		const pending = s.svc.withTrial(req(), new AbortController().signal, () => {
			called = true
			return Promise.resolve(trialResult)
		})
		await trialTicks(s)
		expect(await pending).toBe("unavailable")
		expect(called).toBe(false)
		expect(await fsp.readdir(dir)).toEqual([])
		await s.svc.stop()
	})
})

describe("private capture resource failures", () => {
	it("applies the same disk cap while normal captures occupy it", async () => {
		const s = await setup({}, { samples: 192000 })
		await running(s)
		for (let i = 0; i < 10; i++) {
			expect(s.svc.capture(req({ reason: "identify" }))).toHaveProperty(
				"captureId",
			)
			await flush()
		}
		let called = false
		expect(
			await s.svc.withTrial(
				req({ reason: "identify" }),
				new AbortController().signal,
				() => {
					called = true
					return Promise.resolve(trialResult)
				},
			),
		).toBe("full")
		expect(called).toBe(false)
		await s.svc.stop()
	})

	it("abort during capture reaps the unfinished writer and its files", async () => {
		const s = await setup(
			{ trialOnly: true, config: { ...CFG, enabled: false } },
			{ behaviour: "silent" },
		)
		await running(s)
		const ac = new AbortController()
		let called = false
		const pending = s.svc.withTrial(req(), ac.signal, () => {
			called = true
			return Promise.resolve(trialResult)
		})
		await trialTicks(s)
		ac.abort()
		await pending
		expect(called).toBe(false)
		expect(s.svc.heldBytes()).toBe(0)
		expect(await fsp.readdir(path.join(s.root, "iq-captures"))).toEqual([])
		expect(s.engine.listeners.size).toBe(0)
		await s.svc.stop()
	})
})

it("retains a short DCS keyup before gate, admission and trial startup delays", async () => {
	const s = await setup({ trialOnly: true, config: { ...CFG, enabled: false } })
	await running(s)
	s.svc.detachSource("src")
	s.engine.edge = 0
	s.svc.attachSource("src", {
		sampleRateHz: 24000,
		centerHz: RF,
		epoch: 3,
		engine: s.engine,
	})
	const release = s.svc.leaseSession("src")
	await flush()
	// Native startup completes before the next keyup, while the session is listening.
	s.timers.advance(150)
	const child = s.sp.children[0]!
	const { iq } = syntheticTone({
		kind: "dcs",
		rate: 24000,
		deviation: 2500,
		snr: 40,
		seed: 42,
	})
	const samples = iq.length / 2
	const transmission = Buffer.alloc(samples * 2)
	for (let i = 0; i < transmission.length; i++)
		transmission[i] = Math.max(
			0,
			Math.min(255, Math.round(127.5 + 80 * (iq[i] ?? 0))),
		)
	// Feed the source tap, not the capture file stub. Model the tool's two-second ring
	// from only the bytes that actually reached its stdin.
	for (const listener of s.engine.listeners)
		listener(s.engine.edge, transmission)
	s.engine.edge += samples
	s.timers.advance(250) // detector gate
	s.engine.push(24000 / 4)
	s.timers.advance(250) // admission delay
	s.engine.push(24000 / 4)
	s.timers.advance(150) // trial setup
	s.engine.push(24000 * 0.15)
	await flush()
	const retained = Buffer.concat(child.stdinBytes).subarray(-24000 * 2 * 2)
	expect(retained.indexOf(transmission)).toBeGreaterThanOrEqual(0)
	const offset = retained.indexOf(transmission)
	const saved = retained.subarray(offset, offset + transmission.length)
	const pcm = Buffer.alloc(Math.floor(samples / 3) * 4)
	let sum = 0
	for (let i = 1; i < samples; i++) {
		const re = (saved[i * 2] ?? 0) - 127.5
		const im = (saved[i * 2 + 1] ?? 0) - 127.5
		const prevRe = (saved[(i - 1) * 2] ?? 0) - 127.5
		const prevIm = (saved[(i - 1) * 2 + 1] ?? 0) - 127.5
		sum += Math.atan2(im * prevRe - re * prevIm, re * prevRe + im * prevIm)
		if (i % 3 === 2) {
			pcm.writeFloatLE(
				(sum * 24000) / (3 * 2 * Math.PI * 5000),
				Math.floor(i / 3) * 4,
			)
			sum = 0
		}
	}
	const detector = new ToneDetector()
	detector.push(pcm, { rate: 8000, format: "f32le" })
	expect(detector.result().dcs).toMatchObject({ code: "025" })
	expect(saved.length / 2 / 24000).toBeGreaterThanOrEqual(0.75)
	const pending = s.svc.withTrial(
		req({ reason: "identify" }),
		new AbortController().signal,
		async () => trialResult,
	)
	await trialTicks(s)
	await pending
	expect(s.engine.listeners.size).toBe(1)
	release()
	release()
	expect(s.engine.listeners.size).toBe(0)
	await s.svc.stop()
})

it("refcounts session leases and clears them at shutdown", async () => {
	const s = await setup({ trialOnly: true, config: { ...CFG, enabled: false } })
	await running(s)
	const first = s.svc.leaseSession("src")
	const second = s.svc.leaseSession("src")
	expect(s.sp.children).toHaveLength(1)
	first()
	expect(s.engine.listeners.size).toBe(1)
	await s.svc.stop()
	second()
	second()
	expect(s.engine.listeners.size).toBe(0)
	expect(s.svc.leaseSession("src")()).toBeUndefined()
})

it("starts the session ring when its source attaches after session admission", async () => {
	const s = await setup({ trialOnly: true, config: { ...CFG, enabled: false } })
	await s.svc.start()
	const release = s.svc.leaseSession("src")
	expect(s.sp.children).toHaveLength(0)
	s.svc.attachSource("src", {
		sampleRateHz: FS,
		centerHz: CENTER,
		epoch: 3,
		engine: s.engine,
	})
	await flush()
	expect(s.sp.children).toHaveLength(1)
	expect(s.engine.listeners.size).toBe(1)
	release()
	expect(s.engine.listeners.size).toBe(0)
	await s.svc.stop()
})
