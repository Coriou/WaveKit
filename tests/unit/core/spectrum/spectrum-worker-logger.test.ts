/**
 * The spectrum worker builds its logger once, at module scope (V8): ignored measure-from lines
 * (Q5) and the frame-path line reuse it. The worker entry runs here on a fake parentPort.
 */
import { performance } from "node:perf_hooks"
import { afterEach, describe, expect, it, vi } from "vitest"
import type * as LoggerModule from "../../../../src/utils/logger.js"

const loggers = vi.hoisted(() => ({ built: 0, lines: [] as string[] }))
const port = vi.hoisted(() => ({
	handler: null as ((raw: unknown) => void) | null,
	posted: [] as unknown[],
}))

vi.mock("node:worker_threads", () => ({
	parentPort: {
		on: (_event: string, fn: (raw: unknown) => void) => {
			port.handler = fn
		},
		postMessage: (message: unknown) => port.posted.push(message),
	},
}))

vi.mock("../../../../src/utils/logger.js", async importOriginal => {
	const real = await importOriginal<typeof LoggerModule>()
	return {
		...real,
		createLogger: (...args: Parameters<typeof real.createLogger>) => {
			loggers.built += 1
			const logger = real.createLogger({ ...args[0], level: "fatal" })
			return logger
		},
		createComponentLogger: (
			parent: Parameters<typeof real.createComponentLogger>[0],
			name: string,
		) => {
			const child = real.createComponentLogger(parent, name)
			const info = child.info.bind(child)
			child.info = ((obj: unknown, msg?: string) => {
				loggers.lines.push(msg ?? "")
				return info(obj as object, msg)
			}) as typeof child.info
			return child
		},
	}
})

afterEach(() => {
	vi.restoreAllMocks()
})

describe("the spectrum worker's logger (V8)", () => {
	it("is built once: two ignored measure-from lines a minute apart build no logger", async () => {
		const { MEASURE_FROM_LOG_MS } =
			await import("../../../../src/core/spectrum/worker-protocol.js")
		await import("../../../../src/core/spectrum/spectrum-worker.js")
		const built = loggers.built
		expect(built).toBeLessThanOrEqual(1)
		let now = 1_000
		vi.spyOn(performance, "now").mockImplementation(() => now)
		const bad = { type: "input", input: { kind: "measure-from", trackId: 5 } }
		port.handler!(bad)
		now += MEASURE_FROM_LOG_MS
		port.handler!(bad)
		expect(
			loggers.lines.filter(
				l =>
					l === "Ignored measure-from requests the worker could not validate",
			),
		).toHaveLength(2)
		// No error posted for them, and no logger built per line.
		expect(port.posted).toEqual([])
		expect(loggers.built).toBe(1)
	})
})
