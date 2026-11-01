/**
 * scripts/decode-snapshot.ts without any binary: argument parsing (Zod), the plan it prints, the
 * missing-program refusal, the capture-tool conversation against a fake child, the replay
 * decoder configuration, the per-line verdict, and a whole run against fake tool, replay and
 * decoder children (the adapters' own spawn is the mocked node:child_process one). Synthetic
 * numbers and text only.
 */
import { EventEmitter } from "node:events"
import { PassThrough, Readable } from "node:stream"
import type { ChildProcess } from "node:child_process"
import type * as childProcess from "node:child_process"
import { afterEach, describe, expect, it, vi } from "vitest"

/** The adapters spawn through node:child_process: a test sets `next` to hand them a fake. */
const decoderSpawn = vi.hoisted(() => ({
	next: null as null | (() => unknown),
	calls: [] as unknown[][],
}))
vi.mock("node:child_process", async importOriginal => {
	const actual = await importOriginal<typeof childProcess>()
	return {
		...actual,
		spawn: (...args: unknown[]) => {
			const next = decoderSpawn.next
			if (next === null) throw new Error("no decoder spawn in this test")
			decoderSpawn.calls.push(args)
			return next()
		},
	}
})

import {
	IQCAP_MAX_OPEN_CAPTURES,
	captureWindow,
	decoderFailure,
	parseArgs,
	replayDecoderConfig,
	requiredPrograms,
	runDecodeSnapshot,
	verdictLines,
	whichOnPath,
	type DecodeSnapshotDeps,
} from "../../../scripts/decode-snapshot.js"
import { planSnapshotDecode } from "../../../src/core/scanner/replay-snapshot.js"
import { createInterpreterState } from "../../../src/core/scanner/probes/confirm/double-match.js"

const ARGS = [
	"--file",
	"/cap/iq0.cu8",
	"--rate",
	"1024000",
	"--centre",
	"131600000",
	"--channel",
	"131550000",
	"--decoder",
	"acarsdec",
]

function deps(over: Partial<DecodeSnapshotDeps> = {}) {
	const out: string[] = []
	const err: string[] = []
	const spawn = vi.fn(() => {
		throw new Error("no spawn in this test")
	})
	const d: DecodeSnapshotDeps = {
		spawn: spawn as never,
		which: () => "/usr/local/bin/x",
		stat: () => Promise.resolve({ size: 10 * 1_024_000 * 2, isFile: true }),
		out: l => out.push(l),
		err: l => err.push(l),
		...over,
	}
	return { d, out, err, spawn }
}

describe("parseArgs", () => {
	it("reads every flag, repeated and comma channels, and the centre alias", () => {
		const r = parseArgs([
			...ARGS.slice(0, 4),
			"--center",
			"131600000",
			"--channel",
			"131550000,131725000",
			"--channel",
			"131825000",
			"--decoder",
			"dumpvdl2",
			"--iqcap",
			"/opt/wavekit-iqcap",
			"--plan-only",
		])
		expect(r).toEqual({
			ok: true,
			args: {
				file: "/cap/iq0.cu8",
				rate: 1_024_000,
				centre: 131_600_000,
				channels: [131_550_000, 131_725_000, 131_825_000],
				decoder: "dumpvdl2",
				iqcap: "/opt/wavekit-iqcap",
				planOnly: true,
			},
		})
		expect(parseArgs(ARGS)).toMatchObject({
			ok: true,
			args: { iqcap: "wavekit-iqcap", planOnly: false },
		})
	})

	it.each([
		[["--file", "rel.cu8", ...ARGS.slice(2)], "absolute path"],
		[ARGS.slice(0, 8), "decoder"],
		[[...ARGS.slice(0, 9), "readsb"], "decoder"],
		[[...ARGS.slice(0, 3), "fast", ...ARGS.slice(4)], "rate"],
		[[...ARGS.slice(0, 3), "1.5", ...ARGS.slice(4)], "rate"],
		[[...ARGS, "--rate", "1"], "--rate given twice"],
		[[...ARGS, "--bogus"], "unknown argument --bogus"],
		[[...ARGS, "--channel"], "--channel needs a value"],
		[[...ARGS.slice(0, 6), ...ARGS.slice(8)], "at least one --channel"],
	])("refuses %j (%s)", (argv, message) => {
		const r = parseArgs(argv)
		expect(r.ok).toBe(false)
		if (!r.ok) expect(r.message).toContain(message)
	})
})

describe("runDecodeSnapshot", () => {
	it("bad arguments: exit 2 with the usage, nothing spawned", async () => {
		const { d, err, spawn } = deps()
		expect(await runDecodeSnapshot(["--rate", "x"], d)).toBe(2)
		expect(err.join("\n")).toContain("usage: decode-snapshot")
		expect(spawn).not.toHaveBeenCalled()
	})

	it("a plan the capture cannot hold: exit 2 naming the bound", async () => {
		const { d, err } = deps()
		const argv = [...ARGS]
		argv[5] = "130000000" // the channel 1.55 MHz from the centre
		expect(await runDecodeSnapshot(argv, d)).toBe(2)
		expect(err[0]).toContain("the capture reaches ±488288 Hz")
		const notFile = deps({
			stat: () => Promise.resolve({ size: 2, isFile: false }),
		})
		expect(await runDecodeSnapshot(ARGS, notFile.d)).toBe(2)
		expect(notFile.err[0]).toContain("is not a regular file")
	})

	it("--plan-only prints windows, offsets and tool argv and runs nothing", async () => {
		const { d, out, spawn } = deps({ which: () => null })
		expect(await runDecodeSnapshot([...ARGS, "--plan-only"], d)).toBe(0)
		expect(out).toContain("PLAN channel=131550000 offsetHz=-50000")
		expect(out.filter(l => l.startsWith("PLAN window="))).toHaveLength(3)
		expect(out.find(l => l.startsWith("PLAN run:"))).toContain(
			"run --sample-rate 1024000 --ring-ms 2000",
		)
		expect(out.find(l => l.startsWith("PLAN replay:"))).toContain(
			"--bandwidth 15200 --transition 4000",
		)
		expect(spawn).not.toHaveBeenCalled()
	})

	it("a missing decoder or tool: exit 3 listing them, nothing spawned", async () => {
		const { d, err, spawn } = deps({
			which: name =>
				name === "acarsdec" || name === "sox" ? null : `/bin/${name}`,
		})
		expect(await runDecodeSnapshot(ARGS, d)).toBe(3)
		expect(err[0]).toBe(
			"decode-snapshot: missing program(s) on PATH: sox, acarsdec",
		)
		expect(spawn).not.toHaveBeenCalled()
		expect(
			requiredPrograms({ decoder: "dumpvdl2", iqcap: "wavekit-iqcap" }),
		).toEqual(["wavekit-iqcap", "dumpvdl2"])
	})

	it("whichOnPath finds only executables", () => {
		expect(whichOnPath("node")).not.toBeNull()
		expect(whichOnPath("wk-no-such-program-xyz", "/nonexistent")).toBeNull()
		expect(whichOnPath("/nonexistent/acarsdec")).toBeNull()
	})
})

class FakeChild extends EventEmitter {
	readonly stdin = new PassThrough()
	readonly stdout = new PassThrough()
	readonly stderr = new PassThrough()
	readonly control = new PassThrough()
	readonly stdio = [this.stdin, this.stdout, this.stderr, this.control]
	readonly kill = vi.fn(() => true)
	emitEvent(ev: unknown): void {
		this.stdout.write(`${JSON.stringify(ev)}\n`)
	}
}

const tick = () => new Promise<void>(resolve => setImmediate(resolve))

describe("captureWindow", () => {
	const plan = planSnapshotDecode({
		fileBytes: 10 * 1_024_000 * 2,
		rateHz: 1_024_000,
		centreHz: 131_600_000,
		channelsHz: [131_550_000, 131_725_000, 131_825_000],
		decoder: "acarsdec",
	})
	const ID = (n: number) => `00000000-0000-4000-8000-00000000000${n}`

	it("opens each capture before any sample, proves it with a sentinel, then feeds the window", async () => {
		const child = new FakeChild()
		const spawn = vi.fn(() => child as unknown as ChildProcess)
		let n = 0
		const window = plan.windows[2]!
		const commands: unknown[] = []
		child.control.on("data", (b: Buffer) => {
			for (const l of b.toString().split("\n").filter(Boolean))
				commands.push(JSON.parse(l))
		})
		const fed: Buffer[] = []
		child.stdin.on("data", (b: Buffer) => fed.push(b))
		const input = vi.fn(() => Readable.from([Buffer.from([1, 2, 3, 4])]))
		const done = captureWindow(
			{ spawn: spawn as never },
			{
				iqcap: "/bin/wavekit-iqcap",
				plan,
				window,
				channels: plan.channels.slice(0, 2),
				input,
				outDir: "/w/iq-captures",
				anchor: "/w",
				newId: () => ID(++n),
			},
		)
		expect(spawn).toHaveBeenCalledWith(
			"/bin/wavekit-iqcap",
			plan.runArgs("/w/iq-captures", "/w"),
			{ stdio: ["pipe", "pipe", "pipe", "pipe"] },
		)
		child.emitEvent({ type: "ready", rates: [48000], wideband: true })
		await tick()
		expect(commands).toEqual([
			{
				type: "capture",
				id: ID(1),
				offsetHz: -50_000,
				fromSample: 0,
				maxMs: 2000,
			},
			{
				type: "capture",
				id: ID(2),
				offsetHz: 125_000,
				fromSample: 0,
				maxMs: 2000,
			},
			{ type: "end", id: ID(3) },
		])
		expect(input).not.toHaveBeenCalled()
		child.emitEvent({ type: "error", code: "out-of-range", id: ID(3) })
		await tick()
		expect(input).toHaveBeenCalledOnce()
		expect(Buffer.concat(fed)).toEqual(Buffer.from([1, 2, 3, 4]))
		child.emitEvent({
			type: "captured",
			id: ID(1),
			samples: 96_000,
			gapSamples: 0,
		})
		child.emitEvent({
			type: "captured",
			id: ID(2),
			samples: 96_000,
			gapSamples: 0,
		})
		await expect(done).resolves.toEqual([
			`/w/iq-captures/${ID(1)}.cf32`,
			`/w/iq-captures/${ID(2)}.cf32`,
		])
		expect(commands.at(-1)).toEqual({ type: "shutdown" })
	})

	it("a refused capture, or an exit before the captures, fails the run", async () => {
		const child = new FakeChild()
		let n = 0
		const done = captureWindow(
			{ spawn: (() => child as unknown as ChildProcess) as never },
			{
				iqcap: "wavekit-iqcap",
				plan,
				window: plan.windows[0]!,
				channels: plan.channels.slice(0, 1),
				input: () => Readable.from([]),
				outDir: "/w/iq-captures",
				anchor: "/w",
				newId: () => ID(++n),
			},
		)
		child.emitEvent({ type: "ready" })
		child.emitEvent({ type: "error", code: "out-of-range", id: ID(1) })
		await expect(done).rejects.toThrow("wavekit-iqcap error: out-of-range")
		expect(child.kill).toHaveBeenCalledWith("SIGKILL")
		await expect(
			captureWindow(
				{ spawn: (() => child as unknown as ChildProcess) as never },
				{
					iqcap: "x",
					plan,
					window: plan.windows[0]!,
					channels: plan.channels.slice(0, IQCAP_MAX_OPEN_CAPTURES + 1),
					input: () => Readable.from([]),
					outDir: "/w",
					anchor: "/",
				},
			),
		).rejects.toThrow("a capture run holds 1..2 channels")
	})
})

describe("replay decoder configuration and verdicts", () => {
	it("is the scanner replay transport's: dumpvdl2 decodes its raster channel at 105 kHz", () => {
		const plan = planSnapshotDecode({
			fileBytes: 2_048_000,
			rateHz: 1_024_000,
			centreHz: 136_800_000,
			channelsHz: [136_975_000],
			decoder: "dumpvdl2",
		})
		const { config, req } = replayDecoderConfig(
			plan,
			136_975_000,
			"cap",
			() => new PassThrough(),
		)
		expect(req).toMatchObject({
			targetHz: 136_975_000,
			replay: { captureId: "cap" },
		})
		expect(config).toMatchObject({
			type: "dumpvdl2",
			useChannelizer: false,
			frequencies: [136_975_000],
			options: {
				inputSampleRate: 105_000,
				targetSampleRate: 105_000,
				inputCenterFreq: 136_975_000,
				followCenter: true,
			},
		})
	})

	it("prints one verdict per evidence, with identity only for checked content", () => {
		const plan = planSnapshotDecode({
			fileBytes: 2_048_000,
			rateHz: 1_024_000,
			centreHz: 131_600_000,
			channelsHz: [131_550_000],
			decoder: "acarsdec",
		})
		const state = createInterpreterState({ epoch: 0, origin: "probe" })
		const out = (error: number) => ({
			timestamp: new Date(1_000),
			decoder: "p",
			type: "acars" as const,
			data: { frequency: 0, error, errorKnown: true, tail: ".TEST01" },
		})
		expect(verdictLines(plan, 131_550_000, 0, out(0), state)).toEqual({
			lines: [
				"VERDICT channel=131550000 window=0 crcClean=true identity=acars-reg:TEST01",
			],
			identities: ["acars-reg:TEST01"],
		})
		expect(
			verdictLines(plan, 131_550_000, 1, out(3), state).identities,
		).toEqual([])
		expect(
			verdictLines(plan, 131_550_000, 1, out(3), state).lines[0],
		).toContain("no evidence")
	})
})

/** A decoder child: stdin drained, `spawn` on the next tick, exit and close driven by the test. */
class FakeDecoderChild extends EventEmitter {
	readonly stdin = new PassThrough()
	readonly stdout = new PassThrough()
	readonly stderr = new PassThrough()
	readonly pid = undefined
	exitCode: number | null = null
	signalCode: NodeJS.Signals | null = null
	killed = false
	readonly kill = vi.fn(() => true)
	constructor() {
		super()
		this.stdin.resume()
		setImmediate(() => this.emit("spawn"))
	}
	/** Exit first, then (after `lateMs`) the remaining output, the stdout end and close. */
	finish(
		code: number | null,
		signal: NodeJS.Signals | null,
		lateLines: string[] = [],
		lateMs = 0,
	): void {
		this.exitCode = code
		this.signalCode = signal
		this.emit("exit", code, signal)
		setTimeout(() => {
			for (const l of lateLines) this.stdout.write(`${l}\n`)
			this.stdout.end()
			this.stderr.end()
			this.stdout.once("close", () => this.emit("close", code, signal))
		}, lateMs)
	}
}

/** One clean ACARS block as acarsdec prints it from replay audio (synthetic registration). */
const CLEAN_ACARS =
	'{"timestamp":1793016607.877815,"station_id":"test","channel":0,"freq":0.000,"level":-8.0,"noise":-inf,"error":0,"mode":"2","label":"H1","block_id":"1","ack":false,"tail":".TEST01","flight":"XX0001","msgno":"M01A","text":"SYNTHETIC","app":{"name":"acarsdec","ver":"test"}}'

describe("a whole run against fake children", () => {
	// One 1 s window at 1.024 Msps: one capture run, one replay, one decoder run.
	const FILE_BYTES = 1_024_000 * 2
	const CAPTURE_BYTES = 8 * 4_800
	const plan = planSnapshotDecode({
		fileBytes: FILE_BYTES,
		rateHz: 1_024_000,
		centreHz: 131_600_000,
		channelsHz: [131_550_000],
		decoder: "acarsdec",
	})

	afterEach(() => {
		decoderSpawn.next = null
		decoderSpawn.calls = []
	})

	/** The capture tool answers every capture once its sentinel arrives; the replay sends its bytes. */
	function rig(drive: (decoder: FakeDecoderChild) => void) {
		expect(plan.windows).toHaveLength(1)
		const spawn = vi.fn((_cmd: string, argv: readonly string[]) => {
			const child = new FakeChild()
			if (argv[0] === "run") {
				const ids: string[] = []
				child.control.on("data", (b: Buffer) => {
					for (const l of b.toString().split("\n").filter(Boolean)) {
						const cmd = JSON.parse(l) as { type: string; id?: string }
						if (cmd.type === "capture") ids.push(cmd.id!)
						if (cmd.type === "end")
							for (const id of ids)
								child.emitEvent({
									type: "captured",
									id,
									samples: 1,
									gapSamples: 0,
								})
					}
				})
				setImmediate(() => child.emitEvent({ type: "ready" }))
			} else {
				setImmediate(() => {
					child.stdout.end(Buffer.alloc(plan.replayOutput(CAPTURE_BYTES).bytes))
					child.stdout.once("end", () =>
						setImmediate(() => child.emit("close", 0, null)),
					)
				})
			}
			return child as unknown as ChildProcess
		})
		decoderSpawn.next = () => {
			const child = new FakeDecoderChild()
			setImmediate(() => drive(child))
			return child
		}
		return deps({
			spawn: spawn as never,
			stat: file =>
				Promise.resolve({
					size: file.endsWith(".cf32") ? CAPTURE_BYTES : FILE_BYTES,
					isFile: true,
				}),
		})
	}

	it("output the decoder prints after it exited still counts: results wait for its close", async () => {
		const { d, out, err } = rig(child =>
			child.finish(0, null, [CLEAN_ACARS], 200),
		)
		expect(await runDecodeSnapshot(ARGS, d)).toBe(0)
		expect(err).toEqual([])
		expect(decoderSpawn.calls).toHaveLength(1)
		expect(out).toContain(
			"VERDICT channel=131550000 window=0 crcClean=true identity=acars-reg:TEST01",
		)
		expect(out.at(-1)).toBe(
			"RESULT channel=131550000 decoded acars identities=acars-reg:TEST01",
		)
	})

	it.each([
		[1, null, "acarsdec exited 1"],
		[127, null, "acarsdec could not run (exit 127): is it installed?"],
		[null, "SIGSEGV", "acarsdec was terminated by SIGSEGV"],
	] as const)(
		"a decoder that ends with exit %s (signal %s) fails the run: exit 1, no result",
		async (code, signal, message) => {
			const { d, out, err } = rig(child =>
				child.finish(code, signal, [CLEAN_ACARS]),
			)
			expect(await runDecodeSnapshot(ARGS, d)).toBe(1)
			expect(err).toEqual([`decode-snapshot: ${message}`])
			expect(out.filter(l => l.startsWith("RESULT"))).toEqual([])
		},
	)

	it("names every way a decoder run can end", () => {
		expect(decoderFailure("dumpvdl2", 0, null)).toBeNull()
		expect(decoderFailure("dumpvdl2", 2, null)).toBe("dumpvdl2 exited 2")
		expect(decoderFailure("dumpvdl2", 126, null)).toContain("could not run")
		expect(decoderFailure("dumpvdl2", null, "SIGTERM")).toBe(
			"dumpvdl2 was terminated by SIGTERM",
		)
		expect(decoderFailure("dumpvdl2", null, null)).toBe(
			"dumpvdl2 was terminated by a signal",
		)
	})
})
