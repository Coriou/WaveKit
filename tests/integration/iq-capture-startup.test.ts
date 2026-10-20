import { spawn } from "node:child_process"
import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"
import { createIqCaptureService } from "../../src/core/iq-capture/service.js"
import { probeReplayShapes } from "../../src/core/iq-capture/shapes.js"
import { spyLogger } from "../unit/core/iq-capture/helpers.js"

const binary = fileURLToPath(
	new URL(
		"../../native/wavekit-chan/target/release/wavekit-iqcap",
		import.meta.url,
	),
)

it.skipIf(!fs.existsSync(binary))(
	"starts with the inherited Node control socket before any tap data",
	async () => {
		const root = fs.realpathSync(
			await fsp.mkdtemp(path.join(tmpdir(), "iqcap-start-")),
		)
		const { logger, lines } = spyLogger()
		let ready: (() => void) | undefined
		let rejectReady: ((err: Error) => void) | undefined
		const readyEvent = new Promise<void>((resolve, reject) => {
			ready = resolve
			rejectReady = reject
		})
		let received = ""
		let runArgs: readonly string[] = []
		let runStdio: unknown
		let feed: ((start: number, bytes: Uint8Array) => void) | undefined
		const service = createIqCaptureService({
			config: {
				enabled: true,
				maxTotalMb: 256,
				maxCaptureMs: 4000,
				preRollMs: 500,
				binaryPath: binary,
			},
			storageRoot: root,
			protectedMode: true,
			logger,
			spawn: (command, args, options) => {
				runArgs = args
				runStdio = options.stdio
				const child = spawn(command, args, options)
				child.stdout?.on("data", (chunk: Buffer) => {
					received += chunk.toString()
					if (received.includes('"type":"ready"')) ready?.()
				})
				child.once("error", () => rejectReady?.(new Error("tool spawn failed")))
				child.once("close", () =>
					rejectReady?.(new Error("tool exited before ready")),
				)
				return child
			},
		})
		try {
			// index.ts sweeps first; scanner construction sets shapes and attaches sources;
			// index.ts then starts capture. No samples may be needed to announce ready.
			await service.sweep()
			service.setShapes(probeReplayShapes())
			service.attachSource("source", {
				sampleRateHz: 1_024_000,
				centerHz: 446_000_000,
				epoch: 1,
				engine: {
					tap: listener => {
						feed = listener
						return () => {
							feed = undefined
						}
					},
					liveEdge: () => 0,
				},
			})
			await service.start()
			let deadline: ReturnType<typeof setTimeout> | undefined
			try {
				await Promise.race([
					readyEvent,
					new Promise<never>((_, reject) => {
						deadline = setTimeout(
							() => reject(new Error("tool readiness deadline exceeded")),
							2000,
						)
					}),
				])
			} finally {
				clearTimeout(deadline)
			}
			expect(runArgs).toContain("1024000")
			expect(runArgs[runArgs.indexOf("--bandwidth") + 1]).toBe(
				String(
					Math.max(
						...Object.values(probeReplayShapes()).map(
							shape => shape.bandwidthHz,
						),
					),
				),
			)
			expect(runStdio).toEqual(["pipe", "pipe", "pipe", "pipe"])
			feed?.(0, new Uint8Array(8192))
			expect(service.counters().toolFailures).toBe(0)
		} finally {
			await service.stop()
			await fsp.rm(root, { recursive: true, force: true })
		}
		expect(lines.filter(line => line.level === "warn")).toEqual([])
	},
	10_000,
)
