/**
 * Shared harness of the synthetic-frame chain tests (synthetic-frames.test.ts):
 * wavekit-chan channelizing, the csdr FM head done in-process when csdr is
 * not installed, and a shell runner for the adapters' production command
 * lines.
 *
 * Runner: by default every command runs here with /bin/sh. With
 * WAVEKIT_SYNTH_IMAGE=<core image> each command runs inside that image
 * instead (`docker run --rm --network none`, the work directory mounted at
 * the same path), so dsd-fme, multimon-ng, direwolf and csdr are the image's
 * own builds; the host only channelizes and parses.
 */
import { spawn, spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { createConnection } from "node:net"
import { join } from "node:path"
import type { DecoderChannelRequest } from "../../src/core/channelizer/types.js"

/** The core image to run commands in, when set. */
export const SYNTH_IMAGE = process.env["WAVEKIT_SYNTH_IMAGE"] ?? ""

const hostHas = (cmd: string, args: string[]) =>
	spawnSync(cmd, args, { stdio: "ignore" }).error === undefined

/** Whether `cmd` can run where commands run (always true in the image). */
export function toolAvailable(cmd: string, args: string[] = ["--help"]): boolean {
	return SYNTH_IMAGE !== "" || hostHas(cmd, args)
}

/** csdr is in the image; on the host only if installed. */
export const HAS_CSDR = toolAvailable("csdr", ["--help"])

export interface ShellResult {
	lines: string[]
	status: number | null
}

/**
 * Runs `command` with stdin from `inputFile`; stdout and stderr lines
 * together (dsd-fme prints on stderr, multimon-ng on stdout).
 */
export function runShell(
	command: string,
	inputFile: string,
	workDir: string,
	timeoutMs = 60_000,
): ShellResult {
	// A file on stdin: sox stops early when it reads node's stdin socket.
	const script = `(${command}) < "${inputFile}" 2>&1`
	const run =
		SYNTH_IMAGE === ""
			? spawnSync("/bin/sh", ["-c", script], {
					cwd: workDir,
					timeout: timeoutMs,
					maxBuffer: 64 * 1024 * 1024,
				})
			: spawnSync(
					"docker",
					[
						"run",
						"--rm",
						"--network",
						"none",
						"-v",
						`${workDir}:${workDir}`,
						"-w",
						workDir,
						"--entrypoint",
						"/bin/sh",
						SYNTH_IMAGE,
						"-c",
						script,
					],
					{ timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
				)
	return {
		lines: run.stdout
			.toString("latin1")
			.split("\n")
			.map(line => line.replace(/\r$/, "")),
		status: run.status,
	}
}

/**
 * The csdr head `fmdemod | gain G | limit | convert -i float -o s16` done
 * here (csdr fmdemod: phase step / pi), for hosts without csdr. AGC stages
 * in front are amplitude-only and do not change an FM discriminator.
 */
export function csdrFmHead(cf32: Buffer, gain: number): Buffer {
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
		const v = Math.max(-1, Math.min(1, gain * d))
		pcm.writeInt16LE(Math.round(v * 32_767), 2 * k)
	}
	return pcm
}

/** Opens every request on one wavekit-chan run, feeds `iq`, returns each channel's cf32. */
export async function channelize(
	binary: string,
	iq: Buffer,
	input: { rateHz: number; centerHz: number },
	requests: DecoderChannelRequest[],
): Promise<Buffer[]> {
	const dir = mkdtempSync("/tmp/wkc-")
	const child = spawn(
		binary,
		[
			"--generation",
			"1",
			"--input-format",
			"cu8",
			"--input-rate",
			String(input.rateHz),
			"--input-center",
			String(input.centerHz),
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
			const open = (i: number) => {
				const r = requests[i]!
				control.write(
					JSON.stringify({
						v: 1,
						type: "open",
						id: `c${i}`,
						centerHz: r.centerHz,
						bandwidthHz: r.bandwidthHz,
						transitionHz: r.transitionHz,
						outputRateHz: r.outputRateHz,
						format: r.format,
						queueBytes: 64 * 1024 * 1024,
					}) + "\n",
				)
			}
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

/** A fresh work directory (the docker runner mounts it). */
export function workDir(root: string, name: string): string {
	return mkdtempSync(join(root, `${name}-`))
}
