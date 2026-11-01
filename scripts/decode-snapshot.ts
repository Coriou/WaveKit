/**
 * Offline decode of a stored wideband CU8 snapshot through WaveKit's own replay chain:
 *
 *   decode file F (cu8) at rate R, centre C, channel(s) F1.. with decoder D (acarsdec | dumpvdl2)
 *
 * Per 4 s window and channel, `wavekit-iqcap run` cuts the 48 kHz capture the scanner would
 * (channel shifted to DC by the tool), `wavekit-iqcap replay` filters it to the decoder's channel
 * (acarsdec: cf32 48 kHz; dumpvdl2: U8 105 kHz), and the decoder runs with the scanner replay
 * transport's configuration. Every decoder output line is printed with the scanner's verdict
 * (CRC-clean or not, identity). Plan: src/core/scanner/replay-snapshot.ts.
 *
 * Build and run (no tsx in the image): `node scripts/build-file.mjs scripts/decode-snapshot.ts`
 * writes dist/decode-snapshot.js, then
 *   node dist/decode-snapshot.js --file /cap/iq0.cu8 --rate 1024000 --centre 131600000 \
 *     --channel 131550000 --channel 131725000 --decoder acarsdec
 *
 * Exit codes: 0 done (decoded or not), 1 a step failed, 2 bad arguments, 3 a binary is missing.
 */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { PassThrough, type Readable } from "node:stream"
import { pathToFileURL } from "node:url"
import pino from "pino"
import { z } from "zod"
import {
	BoundedLineReader,
	encodeToolCommand,
	parseToolEvent,
	type IqToolCommand,
	type IqToolEvent,
} from "../src/core/iq-capture/protocol.js"
import { IQ_CAPTURE_CONTROL_LINE_MAX_BYTES } from "../src/core/scanner/iq-capture-contract.js"
import { createInterpreterState } from "../src/core/scanner/probes/confirm/double-match.js"
import {
	REPLAY_PROBE_PRIORITY,
	buildProbeConfig,
	replayContext,
	type ProbeMode,
	type ProbeRequest,
} from "../src/core/scanner/probes/probe-pool.js"
import { interpretRasterReplay } from "../src/core/scanner/probes/replay-interpret.js"
import { createReplayTransport } from "../src/core/scanner/probes/replay-transport.js"
import {
	ACARS_REPLAY_MODE,
	IQ_REPLAY_WIDEBAND_MODES,
} from "../src/core/scanner/replay-plan.js"
import {
	SNAPSHOT_DECODERS,
	planSnapshotDecode,
	type SnapshotChannel,
	type SnapshotDecodePlan,
	type SnapshotWindow,
} from "../src/core/scanner/replay-snapshot.js"
import { AcarsdecDecoder } from "../src/decoders/builtin/acarsdec.js"
import { Dumpvdl2Decoder } from "../src/decoders/builtin/dumpvdl2.js"
import type { DecoderOutput } from "../src/decoders/types.js"

export const USAGE = `usage: decode-snapshot --file <abs .cu8> --rate <S/s> --centre <Hz> --channel <Hz> [--channel <Hz> ...] --decoder acarsdec|dumpvdl2 [--iqcap <path>] [--plan-only]
  --channel takes one Hz value; repeat it (or give a comma list) for several channels.
  --plan-only prints the windows, offsets and tool arguments and runs nothing.`

/** wavekit-iqcap holds at most this many open captures (engine.rs MAX_OPEN). */
export const IQCAP_MAX_OPEN_CAPTURES = 2
/**
 * One step (a window's capture run, a replay, a decoder run) may take 60 s: 15 × the 4 s it covers
 * in real time, the margin an overloaded host needs. Past it the step fails (exit 1).
 */
export const STEP_TIMEOUT_MS = 60_000

const hz = z.coerce.number().int().positive()

export const ArgsSchema = z
	.object({
		file: z
			.string()
			.min(1)
			.refine(p => path.isAbsolute(p), "--file must be an absolute path"),
		rate: hz,
		centre: hz,
		channels: z.array(hz).min(1, "give at least one --channel"),
		decoder: z.enum(SNAPSHOT_DECODERS),
		iqcap: z.string().min(1).default("wavekit-iqcap"),
		planOnly: z.boolean().default(false),
	})
	.strict()
export type DecodeSnapshotArgs = z.infer<typeof ArgsSchema>

const VALUE_FLAGS: Readonly<Record<string, keyof DecodeSnapshotArgs>> = {
	"--file": "file",
	"--rate": "rate",
	"--centre": "centre",
	"--center": "centre",
	"--decoder": "decoder",
	"--iqcap": "iqcap",
}

/** argv (after the script) → validated arguments, or an error message. */
export function parseArgs(
	argv: readonly string[],
): { ok: true; args: DecodeSnapshotArgs } | { ok: false; message: string } {
	const raw: Record<string, unknown> = { channels: [] as string[] }
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i]!
		if (flag === "--plan-only") {
			raw["planOnly"] = true
			continue
		}
		const value = argv[i + 1]
		if (flag === "--channel") {
			if (value === undefined)
				return { ok: false, message: "--channel needs a value" }
			;(raw["channels"] as string[]).push(
				...value.split(",").filter(v => v !== ""),
			)
			i++
			continue
		}
		const key = VALUE_FLAGS[flag]
		if (key === undefined)
			return { ok: false, message: `unknown argument ${flag}` }
		if (value === undefined)
			return { ok: false, message: `${flag} needs a value` }
		if (raw[key] !== undefined)
			return { ok: false, message: `${flag} given twice` }
		raw[key] = value
		i++
	}
	const parsed = ArgsSchema.safeParse(raw)
	if (!parsed.success)
		return {
			ok: false,
			message: parsed.error.issues
				.map(i => `${i.path.join(".") || "arguments"}: ${i.message}`)
				.join("; "),
		}
	return { ok: true, args: parsed.data }
}

export type SpawnLike = (
	command: string,
	args: readonly string[],
	options: { stdio: ("pipe" | "ignore")[] },
) => ChildProcess

export interface DecodeSnapshotDeps {
	spawn: SpawnLike
	/** Absolute path of `name` when it is an executable on PATH (or an executable absolute path). */
	which(name: string): string | null
	stat(file: string): Promise<{ size: number; isFile: boolean }>
	out(line: string): void
	err(line: string): void
}

/** An executable on PATH (or an absolute executable path), else null. */
export function whichOnPath(
	name: string,
	envPath: string | undefined = process.env["PATH"],
): string | null {
	const executable = (p: string): boolean => {
		try {
			fs.accessSync(p, fs.constants.X_OK)
			return fs.statSync(p).isFile()
		} catch {
			return false
		}
	}
	if (path.isAbsolute(name)) return executable(name) ? name : null
	for (const dir of (envPath ?? "").split(path.delimiter)) {
		if (dir === "") continue
		const candidate = path.join(dir, name)
		if (executable(candidate)) return candidate
	}
	return null
}

/** The programs a decoder's replay chain runs: acarsdec's audio tail runs csdr and sox. */
export function requiredPrograms(
	args: Pick<DecodeSnapshotArgs, "decoder" | "iqcap">,
): string[] {
	return args.decoder === "acarsdec"
		? [args.iqcap, "csdr", "sox", "acarsdec"]
		: [args.iqcap, "dumpvdl2"]
}

/** The plan as text lines (--plan-only, and the head of every run). */
export function describePlan(plan: SnapshotDecodePlan, file: string): string[] {
	const lines = [
		`PLAN decoder=${plan.decoder} protocol=${plan.protocol} rate=${plan.rateHz} centre=${plan.centreHz} captureBandwidth=${plan.captureBandwidthHz} maxOffset=±${plan.maxOffsetHz}`,
		...plan.channels.map(
			c => `PLAN channel=${c.channelHz} offsetHz=${c.offsetHz}`,
		),
		...plan.windows.map(
			w =>
				`PLAN window=${w.index} startByte=${w.startByte} bytes=${w.bytes} maxMs=${w.maxMs}`,
		),
		`PLAN run: ${plan.runArgs("<work>/iq-captures", "<work>").join(" ")}`,
		`PLAN replay: ${plan.replayArgs("<capture>.cf32").join(" ")}`,
	]
	if (plan.skippedTailBytes > 0)
		lines.push(
			`PLAN skipped tail bytes=${plan.skippedTailBytes} (under 100 ms)`,
		)
	lines.push(`PLAN file=${file}`)
	return lines
}

function withTimeout<T>(
	promise: Promise<T>,
	what: string,
	onTimeout: () => void,
): Promise<T> {
	let timer: NodeJS.Timeout | undefined
	return Promise.race([
		promise.finally(() => clearTimeout(timer)),
		new Promise<T>((_, reject) => {
			timer = setTimeout(() => {
				onTimeout()
				reject(new Error(`${what} took longer than ${STEP_TIMEOUT_MS} ms`))
			}, STEP_TIMEOUT_MS)
		}),
	])
}

/**
 * One `wavekit-iqcap run` for one window and up to IQCAP_MAX_OPEN_CAPTURES channels. Order: ready,
 * the capture commands (fromSample 0), then an `end` for an id never opened; its `out-range`
 * answer proves every earlier command was handled before any sample is written (commands are
 * handled in order). Then the window's bytes go to stdin and each capture completes by its
 * `maxMs` budget. Resolves the capture file paths, in channel order.
 */
export async function captureWindow(
	deps: Pick<DecodeSnapshotDeps, "spawn">,
	opts: {
		iqcap: string
		plan: SnapshotDecodePlan
		window: SnapshotWindow
		channels: readonly SnapshotChannel[]
		input: () => Readable
		outDir: string
		anchor: string
		newId?: () => string
	},
): Promise<string[]> {
	if (
		opts.channels.length < 1 ||
		opts.channels.length > IQCAP_MAX_OPEN_CAPTURES
	)
		throw new Error(
			`a capture run holds 1..${IQCAP_MAX_OPEN_CAPTURES} channels`,
		)
	const newId = opts.newId ?? randomUUID
	const ids = opts.channels.map(() => newId())
	const sentinel = newId()
	const child = deps.spawn(
		opts.iqcap,
		opts.plan.runArgs(opts.outDir, opts.anchor),
		{
			stdio: ["pipe", "pipe", "pipe", "pipe"],
		},
	)
	const control = child.stdio[3] as NodeJS.WritableStream | null | undefined
	const send = (cmd: IqToolCommand): void => {
		const line = encodeToolCommand(cmd)
		if (line === null || !control)
			throw new Error("capture control line refused")
		control.write(line)
	}
	const done = new Set<string>()
	const run = new Promise<string[]>((resolve, reject) => {
		const fail = (message: string): void => {
			child.kill("SIGKILL")
			reject(new Error(message))
		}
		child.once("error", err =>
			fail(`wavekit-iqcap could not start: ${err.message}`),
		)
		child.once("exit", code => {
			if (done.size !== ids.length)
				fail(`wavekit-iqcap exited (${code}) before its captures finished`)
		})
		child.stderr?.resume()
		child.stdin?.on("error", () => undefined)
		const onEvent = (ev: IqToolEvent): void => {
			if (ev.type === "ready") {
				opts.channels.forEach((c, k) =>
					send({
						type: "capture",
						id: ids[k]!,
						offsetHz: c.offsetHz,
						fromSample: 0,
						maxMs: opts.window.maxMs,
					}),
				)
				send({ type: "end", id: sentinel })
				return
			}
			if (
				ev.type === "error" &&
				ev.id === sentinel &&
				ev.code === "out-of-range"
			) {
				const input = opts.input()
				input.on("error", err => fail(`snapshot read failed: ${err.message}`))
				input.pipe(child.stdin!, { end: false })
				return
			}
			if (ev.type === "captured" && ids.includes(ev.id)) {
				done.add(ev.id)
				if (done.size === ids.length) {
					send({ type: "shutdown" })
					child.stdin?.end()
					resolve(ids.map(id => path.join(opts.outDir, `${id}.cf32`)))
				}
				return
			}
			if (ev.type === "aborted" || ev.type === "error")
				fail(
					`wavekit-iqcap ${ev.type}: ${ev.type === "error" ? ev.code : ev.reason}`,
				)
		}
		const reader = new BoundedLineReader(
			IQ_CAPTURE_CONTROL_LINE_MAX_BYTES,
			line => {
				const ev = parseToolEvent(line)
				if (ev) onEvent(ev)
			},
			() => undefined,
		)
		child.stdout?.on("data", (chunk: Buffer) => reader.push(chunk))
	})
	return withTimeout(run, "a capture run", () => child.kill("SIGKILL"))
}

/** The scanner's replay mode for the decoder (replay-plan.ts). */
function replayModeOf(decoder: DecodeSnapshotArgs["decoder"]): ProbeMode {
	const mode =
		decoder === "acarsdec" ? ACARS_REPLAY_MODE : IQ_REPLAY_WIDEBAND_MODES.vdl2
	return { ...mode, covers: [...mode.covers], options: { ...mode.options } }
}

/**
 * The replay probe request the scanner's replay queue builds for a capture at `channelHz`
 * (pool-adapter.ts), and the decoder configuration the probe pool derives from it.
 */
export function replayDecoderConfig(
	plan: SnapshotDecodePlan,
	channelHz: number,
	captureId: string,
	replay: () => Readable,
) {
	const mode = replayModeOf(plan.decoder)
	const req: ProbeRequest & { replay: { captureId: string } } = {
		jobId: "decode-snapshot",
		priority: REPLAY_PROBE_PRIORITY,
		sourceId: "snapshot",
		trackId: `replay-${captureId}`,
		observationId: "",
		discoveryId: null,
		targetHz: channelHz,
		epoch: 0,
		cls: "unknown",
		protocols: [plan.protocol],
		preRollFromSample: null,
		holdMs: mode.holdMs,
		record: false,
		admission: { kind: "undecoded", snrDb: 0 },
		modes: [mode],
		replay: { captureId },
	}
	const outRate = plan.replayOutput(0).rateHz
	const transport = createReplayTransport({
		openReplay: () => replay(),
		replayRateOf: () => outRate,
	})
	const config = buildProbeConfig({
		probeId: `snapshot-${captureId}`,
		req,
		mode,
		transport,
		ctx: replayContext(req),
		recordDir: null,
		ports: null,
	})
	return { req, mode, transport, config }
}

/** One verdict line per evidence the scanner reads from a decoder output line. */
export function verdictLines(
	plan: SnapshotDecodePlan,
	channelHz: number,
	window: number,
	out: DecoderOutput,
	state: ReturnType<typeof createInterpreterState>,
): { lines: string[]; identities: string[] } {
	const evidence = interpretRasterReplay(plan.decoder, out, state, channelHz)
	const identities: string[] = []
	const lines =
		evidence.length === 0
			? [
					`VERDICT channel=${channelHz} window=${window} no evidence (CRC not clean or unknown, another channel, or malformed)`,
				]
			: evidence.map(ev => {
					const id = ev.identity
						? `${ev.identity.kind}:${ev.identity.value}`
						: "none"
					if (ev.identity) identities.push(id)
					return `VERDICT channel=${channelHz} window=${window} crcClean=${ev.crcClean} identity=${id}`
				})
	return { lines, identities }
}

/**
 * The adapters with their child process in reach: BaseDecoder emits `exit` when the process
 * exits, which can be before its stdout has drained; the child's `close` comes after every
 * stdio stream ended, so after the last output line was parsed.
 */
class SnapshotAcarsdec extends AcarsdecDecoder {
	child(): ChildProcess | null {
		return this.process
	}
}
class SnapshotDumpvdl2 extends Dumpvdl2Decoder {
	child(): ChildProcess | null {
		return this.process
	}
}

/** A decoder run that did not end with exit 0: the step fails. */
export function decoderFailure(
	decoder: DecodeSnapshotArgs["decoder"],
	code: number | null,
	signal: NodeJS.Signals | null,
): string | null {
	if (code === 0) return null
	// 126/127: the shell could not run the decoder (or a pipeline program).
	if (code === 126 || code === 127)
		return `${decoder} could not run (exit ${code}): is it installed?`
	return code === null
		? `${decoder} was terminated by ${signal ?? "a signal"}`
		: `${decoder} exited ${code}`
}

/**
 * Replay one capture into the decoder; prints every output line and its verdict. Resolves once
 * the decoder's output is complete (its child closed) and the replay delivered every byte;
 * rejects when either did not end cleanly.
 */
async function decodeCapture(
	deps: DecodeSnapshotDeps,
	args: DecodeSnapshotArgs,
	plan: SnapshotDecodePlan,
	capturePath: string,
	channelHz: number,
	window: number,
): Promise<string[]> {
	const size = (await deps.stat(capturePath)).size
	const expected = plan.replayOutput(size).bytes
	const replay = deps.spawn(args.iqcap, plan.replayArgs(capturePath), {
		stdio: ["ignore", "pipe", "pipe"],
	})
	replay.stderr?.resume()
	const input = new PassThrough()
	let bytes = 0
	const replayDone = new Promise<void>((resolve, reject) => {
		replay.once("error", err =>
			reject(new Error(`replay could not start: ${err.message}`)),
		)
		replay.stdout?.on("data", (chunk: Buffer) => {
			bytes += chunk.length
		})
		replay.once("close", code => {
			if (code === 0 && bytes === expected) resolve()
			else
				reject(
					new Error(
						`replay exited ${code} after ${bytes} of ${expected} bytes`,
					),
				)
		})
	})
	replay.stdout?.pipe(input)
	const captureId = path.basename(capturePath, ".cf32")
	const { config } = replayDecoderConfig(
		plan,
		channelHz,
		captureId,
		() => input,
	)
	const logger = pino({ level: "silent" })
	const decoder =
		plan.decoder === "acarsdec"
			? new SnapshotAcarsdec(config, logger)
			: new SnapshotDumpvdl2(config, logger)
	const state = createInterpreterState({
		epoch: 0,
		origin: "probe",
		probeId: config.id,
		decoderId: config.id,
	})
	const identities: string[] = []
	decoder.on("output", (out: DecoderOutput) => {
		deps.out(
			`OUTPUT channel=${channelHz} window=${window} ${JSON.stringify(out.data)}`,
		)
		const v = verdictLines(plan, channelHz, window, out, state)
		for (const line of v.lines) deps.out(line)
		identities.push(...v.identities)
	})
	// "started" is emitted inside start() while the child is set, before any of its events.
	const closed = new Promise<string | null>((resolve, reject) => {
		decoder.once("started", () => {
			const child = decoder.child()
			if (!child) {
				reject(new Error(`${plan.decoder} started without a process`))
				return
			}
			child.once(
				"close",
				(code: number | null, signal: NodeJS.Signals | null) =>
					resolve(decoderFailure(plan.decoder, code, signal)),
			)
		})
	})
	await decoder.start()
	decoder.attachInput(input)
	const stopAll = (): void => {
		replay.kill("SIGKILL")
		void decoder.stop()
	}
	let failure: string | null
	try {
		;[failure] = await withTimeout(
			Promise.all([closed, replayDone]),
			"a decoder run",
			stopAll,
		)
	} catch (err: unknown) {
		stopAll()
		throw err
	}
	if (failure !== null) throw new Error(failure)
	return identities
}

export async function runDecodeSnapshot(
	argv: readonly string[],
	deps: DecodeSnapshotDeps,
): Promise<number> {
	const parsed = parseArgs(argv)
	if (!parsed.ok) {
		deps.err(`decode-snapshot: ${parsed.message}`)
		deps.err(USAGE)
		return 2
	}
	const args = parsed.args
	let plan: SnapshotDecodePlan
	try {
		const st = await deps.stat(args.file)
		if (!st.isFile) throw new Error(`${args.file} is not a regular file`)
		plan = planSnapshotDecode({
			fileBytes: st.size,
			rateHz: args.rate,
			centreHz: args.centre,
			channelsHz: args.channels,
			decoder: args.decoder,
		})
	} catch (err: unknown) {
		deps.err(
			`decode-snapshot: ${err instanceof Error ? err.message : String(err)}`,
		)
		return 2
	}
	for (const line of describePlan(plan, args.file)) deps.out(line)
	if (args.planOnly) return 0
	const missing = requiredPrograms(args).filter(p => deps.which(p) === null)
	if (missing.length > 0) {
		deps.err(
			`decode-snapshot: missing program(s) on PATH: ${missing.join(", ")}`,
		)
		return 3
	}
	const work = await fsp.realpath(
		await fsp.mkdtemp(path.join(os.tmpdir(), "wk-decode-")),
	)
	const outDir = path.join(work, "iq-captures")
	const decoded = new Map<number, Set<string>>()
	try {
		await fsp.mkdir(outDir, { mode: 0o700 })
		for (const window of plan.windows) {
			for (let k = 0; k < plan.channels.length; k += IQCAP_MAX_OPEN_CAPTURES) {
				const batch = plan.channels.slice(k, k + IQCAP_MAX_OPEN_CAPTURES)
				const files = await captureWindow(deps, {
					iqcap: args.iqcap,
					plan,
					window,
					channels: batch,
					outDir,
					anchor: work,
					input: () =>
						fs.createReadStream(args.file, {
							start: window.startByte,
							end: window.startByte + window.bytes - 1,
						}),
				})
				for (const [j, file] of files.entries()) {
					const channel = batch[j]!
					const ids = await decodeCapture(
						deps,
						args,
						plan,
						file,
						channel.channelHz,
						window.index,
					)
					const set = decoded.get(channel.channelHz) ?? new Set<string>()
					for (const id of ids) set.add(id)
					decoded.set(channel.channelHz, set)
					await fsp.rm(file, { force: true })
				}
			}
		}
	} catch (err: unknown) {
		deps.err(
			`decode-snapshot: ${err instanceof Error ? err.message : String(err)}`,
		)
		return 1
	} finally {
		await fsp.rm(work, { recursive: true, force: true })
	}
	for (const c of plan.channels) {
		const ids = [...(decoded.get(c.channelHz) ?? [])]
		deps.out(
			ids.length > 0
				? `RESULT channel=${c.channelHz} decoded ${plan.protocol} identities=${ids.join(",")}`
				: `RESULT channel=${c.channelHz} not decoded`,
		)
	}
	return 0
}

const isMain =
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) {
	runDecodeSnapshot(process.argv.slice(2), {
		spawn: (command, args, options) => nodeSpawn(command, [...args], options),
		which: name => whichOnPath(name),
		stat: async file => {
			const st = await fsp.stat(file)
			return { size: st.size, isFile: st.isFile() }
		},
		out: line => process.stdout.write(`${line}\n`),
		err: line => process.stderr.write(`${line}\n`),
	}).then(
		code => {
			process.exitCode = code
		},
		(err: unknown) => {
			process.stderr.write(`decode-snapshot: ${String(err)}\n`)
			process.exitCode = 1
		},
	)
}
