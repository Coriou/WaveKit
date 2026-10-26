import type { ChildProcess, SpawnOptions } from "node:child_process"
import { EventEmitter } from "node:events"
import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { PassThrough, type Readable } from "node:stream"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import {
	ANALYZE_GAP_MAX_SAMPLES,
	parseAnalyzeEvent,
} from "../../../../src/core/iq-capture/protocol.js"
import {
	createIqCaptureService,
	type IqCaptureServiceOptions,
	type IqReplayShapes,
} from "../../../../src/core/iq-capture/service.js"
import type { IqToolTimers } from "../../../../src/core/iq-capture/process.js"
import type { IqCaptureRequest } from "../../../../src/core/scanner/iq-capture-contract.js"
import { ANALYZE_EVENT_MAX_BYTES } from "../../../../src/core/scanner/scanner-redesign-contract.js"
import { WaveKitError } from "../../../../src/utils/errors.js"
import { flush, logText, spyLogger } from "./helpers.js"

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
const FS_HZ = 2_048_000
const CENTER = 446_000_000
const RF = 446_006_250
const AUDIO_MAX = 32_000 * 2
const SAMPLES = 4800

let base: string
let n = 0
beforeAll(async () => {
	base = fs.realpathSync(await fsp.mkdtemp(path.join(tmpdir(), "iqcap-an-")))
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

class PipeChild extends EventEmitter {
	readonly stdio: unknown[]
	stdin: PassThrough | null = null
	stdout: PassThrough | null = null
	stderr: PassThrough | null = null
	pid: number | undefined = undefined
	exitCode: number | null = null
	signalCode: NodeJS.Signals | null = null
	constructor(
		readonly command: string,
		readonly args: readonly string[],
		readonly options: SpawnOptions,
	) {
		super()
		const spec = Array.isArray(options.stdio) ? options.stdio : []
		this.stdio = spec.map(slot =>
			slot === "pipe" ? new PassThrough() : slot === "ignore" ? null : slot,
		)
		const stdin = this.stdio[0]
		const stdout = this.stdio[1]
		const stderr = this.stdio[2]
		this.stdin = stdin instanceof PassThrough ? stdin : null
		this.stdout = stdout instanceof PassThrough ? stdout : null
		this.stderr = stderr instanceof PassThrough ? stderr : null
	}
	eventFd(): PassThrough | null {
		const fd = this.stdio[4]
		return fd instanceof PassThrough ? fd : null
	}
	event(obj: unknown): void {
		this.stdout?.write(`${JSON.stringify(obj)}\n`)
	}
	exit(code: number | null, signal: NodeJS.Signals | null = null): void {
		if (this.exitCode !== null || this.signalCode !== null) return
		this.exitCode = code
		this.signalCode = signal
		this.stdout?.end()
		this.eventFd()?.end()
		this.emit("exit", code, signal)
		this.emit("close", code, signal)
	}
	kill(sig?: NodeJS.Signals): boolean {
		this.exit(null, sig ?? "SIGTERM")
		return true
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

function wireRun(child: PipeChild): void {
	queueMicrotask(() => child.event({ type: "ready" }))
	const outDir = child.args[child.args.indexOf("--out-dir") + 1] ?? ""
	const control = child.stdio[3]
	if (!(control instanceof PassThrough)) return
	let pending = ""
	control.on("data", (b: Buffer) => {
		pending += b.toString("utf8")
		let nl = pending.indexOf("\n")
		while (nl !== -1) {
			const line = pending.slice(0, nl)
			pending = pending.slice(nl + 1)
			nl = pending.indexOf("\n")
			if (line.includes('"type":"shutdown"')) {
				queueMicrotask(() => child.exit(0))
				continue
			}
			const cmd = JSON.parse(line) as {
				type: string
				id?: string
				rateHz?: number
			}
			if (cmd.type !== "capture") continue
			const id = cmd.id ?? ""
			// 100 ms at the capture's rate
			const samples = (SAMPLES * (cmd.rateHz ?? 48_000)) / 48_000
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
}

async function setup(
	over: Partial<IqCaptureServiceOptions> = {},
	opts: { failAnalyze?: boolean } = {},
) {
	const root = path.join(base, `r${n++}`)
	await fsp.mkdir(root)
	const timers = new ManualTimers()
	const { logger, lines } = spyLogger()
	let uuidN = 0
	const children: PipeChild[] = []
	const spawn = vi.fn(
		(command: string, args: readonly string[], options: SpawnOptions) => {
			if (args[0] === "analyze" && opts.failAnalyze) {
				throw Object.assign(new Error("spawn failed"), {
					path: "/tmp/secret-path",
					code: "ENOENT",
				})
			}
			const child = new PipeChild(command, args, options)
			children.push(child)
			if (args[0] === "run") wireRun(child)
			return child as unknown as ChildProcess
		},
	)
	const svc = createIqCaptureService({
		config: CFG,
		storageRoot: root,
		protectedMode: true,
		logger,
		shapes: SHAPES,
		now: () => timers.t + 1_000_000,
		spawn,
		randomUUID: () =>
			`aaaaaaaa-0000-4000-8000-${(uuidN++).toString(16).padStart(12, "0")}`,
		timers,
		env: {},
		...over,
	})
	const engine = new FakeEngine()
	return { svc, root, timers, lines, children, engine }
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

async function ready(opts: { failAnalyze?: boolean; rateHz?: 96_000 } = {}) {
	const s = await setup({}, opts)
	s.svc.attachSource("src", {
		sampleRateHz: FS_HZ,
		centerHz: CENTER,
		epoch: 3,
		engine: s.engine,
	})
	await s.svc.start()
	await flush()
	s.engine.push(FS_HZ)
	const got = s.svc.capture(opts.rateHz ? req({ rateHz: opts.rateHz }) : req())
	await flush(10)
	const id = "captureId" in got ? got.captureId : ""
	return { ...s, id }
}

function openAnalyze(
	svc: ReturnType<typeof createIqCaptureService>,
	captureId: string,
	mode: "nfm" | "am",
) {
	const open = svc.openAnalyze
	if (!open) throw new Error("openAnalyze is absent")
	return open.call(svc, captureId, mode)
}

function analyzeChild(children: PipeChild[]): PipeChild {
	const child = children.filter(c => c.args[0] === "analyze").at(-1)
	if (!child) throw new Error("no analyze child")
	return child
}

function readAll(r: Readable): Promise<{ bytes: number; error: unknown }> {
	let bytes = 0
	return new Promise(resolve => {
		r.on("data", (b: Buffer) => {
			bytes += b.length
		})
		r.on("end", () => resolve({ bytes, error: null }))
		r.on("error", error => resolve({ bytes, error }))
	})
}

const FRAME = {
	carrierDb: -12.5,
	hfNoiseDb: -9,
	audioDb: -20,
	syllabic: 0.4,
	cluster: 0.1,
}

function analysisLine(frames = 1, gapSamples = 0): string {
	return JSON.stringify({
		event: "analysis",
		frames: Array.from({ length: frames }, () => ({ ...FRAME })),
		gapSamples,
	})
}

describe("parseAnalyzeEvent", () => {
	it("accepts 80 frames and gap at the cap, and rejects one past each", () => {
		expect(
			parseAnalyzeEvent(analysisLine(80, ANALYZE_GAP_MAX_SAMPLES)),
		).toEqual({
			event: "analysis",
			frames: Array.from({ length: 80 }, () => ({ ...FRAME })),
			gapSamples: ANALYZE_GAP_MAX_SAMPLES,
		})
		expect(parseAnalyzeEvent(analysisLine(81, 0))).toBeNull()
		expect(
			parseAnalyzeEvent(analysisLine(80, ANALYZE_GAP_MAX_SAMPLES + 1)),
		).toBeNull()
	})

	it("rejects malformed JSON, non-finite numbers and extra fields", () => {
		expect(parseAnalyzeEvent("{")).toBeNull()
		expect(parseAnalyzeEvent("null")).toBeNull()
		expect(
			parseAnalyzeEvent(
				'{"event":"analysis","frames":[{"carrierDb":1e309,"hfNoiseDb":0,"audioDb":0,"syllabic":0,"cluster":0}],"gapSamples":0}',
			),
		).toBeNull()
		expect(
			parseAnalyzeEvent(
				'{"event":"error","code":"io","path":"/tmp/secret-path"}',
			),
		).toBeNull()
		expect(
			parseAnalyzeEvent(
				'{"event":"analysis","frames":[],"gapSamples":0,"x":1}',
			),
		).toBeNull()
		expect(parseAnalyzeEvent('{"event":"error","code":"nope"}')).toBeNull()
	})
})

describe("IqCaptureService openAnalyze", () => {
	it("a 96 kHz capture is analysed with --rate 96000", async () => {
		const s = await ready({ rateHz: 96_000 })
		const opened = openAnalyze(s.svc, s.id, "am")
		expect(opened).not.toBeNull()
		expect(analyzeChild(s.children).args).toEqual([
			"analyze",
			"--in",
			"/dev/fd/3",
			"--mode",
			"am",
			"--rate",
			"96000",
		])
		opened!.kill()
		await s.svc.stop()
	})

	it("argv is analyze --in … --mode nfm, stdio fd 4 pipe", async () => {
		const s = await ready()
		const opened = openAnalyze(s.svc, s.id, "nfm")
		expect(opened).not.toBeNull()
		const child = analyzeChild(s.children)
		expect(child.args).toEqual([
			"analyze",
			"--in",
			"/dev/fd/3",
			"--mode",
			"nfm",
		])
		const stdio = child.options.stdio as unknown[]
		expect(stdio[0]).toBe("ignore")
		expect(stdio[1]).toBe("pipe")
		expect(stdio[2]).toBe("pipe")
		expect(typeof stdio[3]).toBe("number")
		expect(stdio[4]).toBe("pipe")
		const audio = readAll(opened!.audio)
		const event = opened!.event
		child.stdout?.write(Buffer.alloc(AUDIO_MAX, 1))
		child.eventFd()?.write(`${analysisLine(80, 0)}\n`)
		child.exit(0)
		await expect(event).resolves.toEqual(parseAnalyzeEvent(analysisLine(80, 0)))
		expect(await audio).toEqual({ bytes: AUDIO_MAX, error: null })
		expect(s.svc.counters().replayFailures).toBe(0)
		await s.svc.stop()
	})

	it("A malformed or over-16384-byte event → error analyze-failed", async () => {
		const s = await ready()
		const opened = openAnalyze(s.svc, s.id, "nfm")
		const child = analyzeChild(s.children)
		child.eventFd()?.write("{not-json\n")
		child.exit(0)
		await expect(opened!.event).rejects.toMatchObject({
			code: "ANALYZE_FAILED",
		})
		expect(s.svc.counters().replayFailures).toBe(1)

		const again = openAnalyze(s.svc, s.id, "am")
		const child2 = analyzeChild(s.children)
		expect(child2.args.at(-1)).toBe("am")
		child2.eventFd()?.write(Buffer.alloc(ANALYZE_EVENT_MAX_BYTES, 0x78))
		child2.eventFd()?.write(Buffer.from("\n"))
		child2.exit(0)
		await expect(again!.event).rejects.toBeInstanceOf(WaveKitError)
		expect(
			(await again!.event.catch((err: unknown) => err)) as WaveKitError,
		).toMatchObject({
			message: "IQ analyze failed",
			code: "ANALYZE_FAILED",
		})
		expect(logText(s.lines)).not.toContain(s.id)
		await s.svc.stop()
	})

	it("an event line of 16384 bytes parses and one more byte fails", async () => {
		const s = await ready()
		const payload = JSON.stringify({ event: "error", code: "io" })
		const atBound = payload.padStart(ANALYZE_EVENT_MAX_BYTES - 1, " ")
		expect(Buffer.byteLength(atBound) + 1).toBe(ANALYZE_EVENT_MAX_BYTES)
		const opened = openAnalyze(s.svc, s.id, "nfm")
		const child = analyzeChild(s.children)
		child.eventFd()?.write(`${atBound}\n`)
		child.exit(2)
		await expect(opened!.event).resolves.toEqual({ event: "error", code: "io" })

		const past = payload.padStart(ANALYZE_EVENT_MAX_BYTES, " ")
		expect(Buffer.byteLength(past) + 1).toBe(ANALYZE_EVENT_MAX_BYTES + 1)
		const again = openAnalyze(s.svc, s.id, "nfm")
		const child2 = analyzeChild(s.children)
		child2.eventFd()?.write(`${past}\n`)
		child2.exit(0)
		await expect(again!.event).rejects.toMatchObject({ code: "ANALYZE_FAILED" })
		await s.svc.stop()
	})

	it("audio of 64000 bytes is kept and one more byte fails", async () => {
		const s = await ready()
		const opened = openAnalyze(s.svc, s.id, "nfm")
		if (!opened) throw new Error("open")
		const child = analyzeChild(s.children)
		const audio = readAll(opened.audio)
		child.stdout?.write(Buffer.alloc(AUDIO_MAX, 2))
		child.eventFd()?.write(`${analysisLine(80)}\n`)
		child.exit(0)
		await expect(opened.event).resolves.toMatchObject({ event: "analysis" })
		expect(await audio).toEqual({ bytes: AUDIO_MAX, error: null })

		const again = openAnalyze(s.svc, s.id, "nfm")
		if (!again) throw new Error("open")
		const child2 = analyzeChild(s.children)
		const audio2 = readAll(again.audio)
		child2.stdout?.write(Buffer.alloc(AUDIO_MAX + 1, 2))
		child2.eventFd()?.write(`${analysisLine()}\n`)
		child2.exit(0)
		await expect(again.event).rejects.toMatchObject({ code: "ANALYZE_FAILED" })
		expect((await audio2).error).toBeInstanceOf(WaveKitError)
		await s.svc.stop()
	})

	it("A gone capture → null", async () => {
		const s = await ready()
		expect(openAnalyze(s.svc, "nope", "nfm")).toBeNull()
		expect(openAnalyze(s.svc, s.id, "nfm")).not.toBeNull()
		const off = await setup({ config: { ...CFG, enabled: false } })
		expect(openAnalyze(off.svc, s.id, "am")).toBeNull()
		await s.svc.stop()
	})

	it("Abort kills the child", async () => {
		const s = await ready()
		const opened = openAnalyze(s.svc, s.id, "nfm")
		const child = analyzeChild(s.children)
		const failed = opened!.event.then(
			() => null,
			(err: unknown) => err,
		)
		opened!.kill()
		expect(child.signalCode).toBe("SIGKILL")
		await expect(failed).resolves.toMatchObject({ code: "ANALYZE_FAILED" })
		expect(s.svc.counters().replayFailures).toBe(0)
		await s.svc.stop()
	})

	it("a non-zero exit without an error event rejects, and an error event resolves", async () => {
		const s = await ready()
		const opened = openAnalyze(s.svc, s.id, "nfm")
		const child = analyzeChild(s.children)
		child.exit(2)
		await expect(opened!.event).rejects.toMatchObject({
			code: "ANALYZE_FAILED",
		})

		const again = openAnalyze(s.svc, s.id, "nfm")
		const child2 = analyzeChild(s.children)
		child2
			.eventFd()
			?.write(`${JSON.stringify({ event: "error", code: "bad-file" })}\n`)
		child2.exit(2)
		await expect(again!.event).resolves.toEqual({
			event: "error",
			code: "bad-file",
		})

		const third = openAnalyze(s.svc, s.id, "nfm")
		const child3 = analyzeChild(s.children)
		child3.eventFd()?.write(`${analysisLine()}\n`)
		child3.exit(1)
		await expect(third!.event).rejects.toMatchObject({ code: "ANALYZE_FAILED" })

		const zero = openAnalyze(s.svc, s.id, "nfm")
		const child4 = analyzeChild(s.children)
		child4
			.eventFd()
			?.write(`${JSON.stringify({ event: "error", code: "io" })}\n`)
		child4.exit(0)
		await expect(zero!.event).rejects.toMatchObject({ code: "ANALYZE_FAILED" })
		await s.svc.stop()
	})

	it("a child that never writes fd 4 rejects", async () => {
		const s = await ready()
		const opened = openAnalyze(s.svc, s.id, "nfm")
		analyzeChild(s.children).exit(0)
		await expect(opened!.event).rejects.toMatchObject({
			code: "ANALYZE_FAILED",
		})
		await s.svc.stop()
	})

	it("a child that never exits is killed at the replay timeout", async () => {
		const s = await ready()
		const opened = openAnalyze(s.svc, s.id, "nfm")
		const child = analyzeChild(s.children)
		const failed = opened!.event.then(
			() => null,
			(err: unknown) => err,
		)
		s.timers.advance(30_000)
		expect(child.signalCode).toBe("SIGKILL")
		await expect(failed).resolves.toMatchObject({ code: "ANALYZE_FAILED" })
		expect(s.svc.counters().replayFailures).toBe(1)
		await s.svc.stop()
	})

	it("a spawn failure returns null and does not log the path or capture id", async () => {
		const s = await ready({ failAnalyze: true })
		expect(openAnalyze(s.svc, s.id, "nfm")).toBeNull()
		expect(s.svc.counters().replayFailures).toBe(1)
		const text = logText(s.lines)
		expect(text).not.toContain("/tmp/secret-path")
		expect(text).not.toContain(s.id)
		expect(text).toContain("IQ analyze could not start")
		await s.svc.stop()
	})

	it("a valid analysis line followed by trailing bytes without a newline is analyze-failed", async () => {
		const s = await ready()
		const opened = openAnalyze(s.svc, s.id, "nfm")
		const child = analyzeChild(s.children)
		child.eventFd()?.write(`${analysisLine()}\n{"event":"error"`)
		child.exit(0)
		await expect(opened!.event).rejects.toMatchObject({
			code: "ANALYZE_FAILED",
		})
		await s.svc.stop()
	})

	it("non-finite analysis JSON from the child is analyze-failed", async () => {
		const s = await ready()
		const opened = openAnalyze(s.svc, s.id, "nfm")
		const child = analyzeChild(s.children)
		child
			.eventFd()
			?.write(
				'{"event":"analysis","frames":[{"carrierDb":1e309,"hfNoiseDb":0,"audioDb":0,"syllabic":0,"cluster":0}],"gapSamples":0}\n',
			)
		child.exit(0)
		await expect(opened!.event).rejects.toMatchObject({
			code: "ANALYZE_FAILED",
		})
		expect(logText(s.lines)).not.toContain("1e309")
		await s.svc.stop()
	})

	it("odd-length audio is analyze-failed", async () => {
		const s = await ready()
		const opened = openAnalyze(s.svc, s.id, "nfm")
		const child = analyzeChild(s.children)
		child.stdout?.write(Buffer.alloc(801, 1))
		child.eventFd()?.write(`${analysisLine(1)}\n`)
		child.exit(0)
		await expect(opened!.event).rejects.toMatchObject({
			code: "ANALYZE_FAILED",
		})
		await s.svc.stop()
	})

	it("audio that does not match the frame count is analyze-failed", async () => {
		const s = await ready()
		const opened = openAnalyze(s.svc, s.id, "nfm")
		const child = analyzeChild(s.children)
		// One frame is 400 samples. 200 samples is a short frame.
		child.stdout?.write(Buffer.alloc(400, 1))
		child.eventFd()?.write(`${analysisLine(1)}\n`)
		child.exit(0)
		await expect(opened!.event).rejects.toMatchObject({
			code: "ANALYZE_FAILED",
		})
		await s.svc.stop()
	})

	it("audio length is frames*400 + ceil(gapSamples/6), at the bound and off by one", async () => {
		const s = await ready()
		const accept = async (samples: number, gapSamples: number) => {
			const opened = openAnalyze(s.svc, s.id, "nfm")
			if (!opened) throw new Error("open")
			const child = analyzeChild(s.children)
			const audio = readAll(opened.audio)
			child.stdout?.write(Buffer.alloc(samples * 2, 2))
			child.eventFd()?.write(`${analysisLine(1, gapSamples)}\n`)
			child.exit(0)
			await expect(opened.event).resolves.toMatchObject({
				event: "analysis",
				gapSamples,
			})
			expect(await audio).toEqual({ bytes: samples * 2, error: null })
		}
		const reject = async (samples: number, gapSamples: number) => {
			const opened = openAnalyze(s.svc, s.id, "nfm")
			if (!opened) throw new Error("open")
			const child = analyzeChild(s.children)
			child.stdout?.write(Buffer.alloc(samples * 2, 2))
			child.eventFd()?.write(`${analysisLine(1, gapSamples)}\n`)
			child.exit(0)
			await expect(opened.event).rejects.toMatchObject({
				code: "ANALYZE_FAILED",
			})
		}
		// One frame, no gap: 400 samples. Off by one on either side fails.
		await accept(400, 0)
		await reject(399, 0)
		await reject(401, 0)
		// ceil(6/6) = 1 and ceil(7/6) = 2.
		await accept(401, 6)
		await reject(400, 6)
		await reject(402, 6)
		await accept(402, 7)
		await reject(401, 7)
		await reject(403, 7)
		await s.svc.stop()
	})
})
