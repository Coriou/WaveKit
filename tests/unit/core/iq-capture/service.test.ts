import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { Readable } from "node:stream"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
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

	it("missing binary: capture off with one warn, the port keeps answering", async () => {
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
		expect(s.lines.filter(l => l.level === "warn")).toHaveLength(1)
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
		expect(s.svc.counters().hostileEvents).toBe(2)
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
		// A second captured for the same id is hostile too.
		child.event({ type: "captured", id, samples: 1, gapSamples: 0 })
		await flush()
		// 2 unknown ids + the out-of-bound count + the repeat.
		expect(s.svc.counters().hostileEvents).toBe(4)
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
		child.event({ type: "captured", id, samples: 11, gapSamples: 0 })
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

	it("refuses rtl433, unknown and unready captures", async () => {
		const { s, id } = await ready()
		expect(s.svc.openReplay(id, "rtl433")).toBeNull()
		expect(s.svc.openReplay("nope", "dsd-fme")).toBeNull()
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
