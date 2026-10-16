import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Writable } from "node:stream"
import { fileURLToPath, pathToFileURL } from "node:url"
import pino from "pino"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { ActivityReaderFailedError } from "../../../../../src/core/activity/query/errors.js"
import type { ReaderHostEvent } from "../../../../../src/core/activity/query/reader-host.js"
import type { ActivityQueryService } from "../../../../../src/core/activity/storage/contract.js"
import type { Logger } from "../../../../../src/utils/logger.js"
import { createFixture, delay, openQueryService, type ActivityFixture } from "./fixture.js"

function captureLogger(): { logger: Logger; text: () => string } {
	let body = ""
	const stream = new Writable({
		write(chunk, _encoding, callback) {
			body += String(chunk)
			callback()
		},
	})
	return { logger: pino({ level: "info" }, stream), text: () => body }
}

function observedLiteral(fixture: ActivityFixture): string {
	const identity = fixture.store.identity()
	return JSON.stringify({
		storeUuid: identity.storeUuid,
		restoreGeneration: identity.restoreGeneration,
		pruneWatermark: identity.pruneWatermark,
	})
}

function answerSearch(observed: string): string {
	return [
		'parentPort?.on("message", message => {',
		'  if (!message || message.type !== "query") return',
		"  parentPort.postMessage({",
		'    type: "result",',
		"    id: message.id,",
		"    generation: message.generation,",
		"    ok: true,",
		`    value: { op: "search", rows: [], observed: ${observed} },`,
		"  })",
		"})",
	].join("\n")
}

describe("activity reader startup", () => {
	let directory: string
	let fixture: ActivityFixture
	let service: ActivityQueryService | undefined

	beforeAll(async () => {
		const repository = fileURLToPath(new URL("../../../../../", import.meta.url))
		const cache = join(repository, "node_modules", ".cache")
		await mkdir(cache, { recursive: true })
		directory = await mkdtemp(join(cache, "wk-reader-start-"))
		fixture = await createFixture()
	})

	afterAll(async () => {
		await service?.close()
		await fixture.close()
		await rm(directory, { recursive: true, force: true })
	})

	async function worker(name: string, source: string): Promise<URL> {
		const file = join(directory, name)
		await writeFile(file, source)
		return pathToFileURL(file)
	}

	it("waits out a slow ready past the query deadline and reuses that reader", async () => {
		const observed = observedLiteral(fixture)
		const url = await worker(
			"slow-ready.js",
			[
				'import { parentPort } from "node:worker_threads"',
				answerSearch(observed),
				"setTimeout(() => {",
				'  parentPort?.postMessage({ type: "ready" })',
				"}, 180)",
				"setInterval(() => {}, 60_000)",
				"",
			].join("\n"),
		)
		const events: ReaderHostEvent[] = []
		service = openQueryService(fixture, {
			logger: captureLogger().logger,
			execution: "worker",
			workerUrl: url,
			readyTimeoutMs: 2_000,
			onReaderEvent: event => {
				events.push(event)
			},
			limits: { deadlineMs: 40 },
		})
		const spawns = () => events.filter(event => event.type === "spawn")
		try {
			expect(spawns()).toHaveLength(1)
			const started = Date.now()
			const page = await service.search({ query: {} })
			expect(Date.now() - started).toBeGreaterThan(100)
			expect(page.items).toEqual([])
			expect(spawns()).toHaveLength(1)
			expect(events.some(event => event.type === "terminate")).toBe(false)
			const again = await service.search({ query: {} })
			expect(again.items).toEqual([])
			expect(spawns()).toHaveLength(1)
		} finally {
			await service.close()
		}
	})

	it("logs a failed prewarm and retries that reader on the next query", async () => {
		const observed = observedLiteral(fixture)
		const marker = join(directory, "starts.txt")
		const url = await worker(
			"fail-once.js",
			[
				'import { readFileSync, writeFileSync } from "node:fs"',
				'import { parentPort } from "node:worker_threads"',
				`const marker = ${JSON.stringify(marker)}`,
				"let count = 0",
				"try { count = Number(readFileSync(marker, 'utf8')) } catch {}",
				"writeFileSync(marker, String(count + 1))",
				'if (count === 0) throw new Error("sqlite missing")',
				answerSearch(observed),
				'parentPort?.postMessage({ type: "ready" })',
				"setInterval(() => {}, 60_000)",
				"",
			].join("\n"),
		)
		const events: ReaderHostEvent[] = []
		const logs = captureLogger()
		service = openQueryService(fixture, {
			logger: logs.logger,
			execution: "worker",
			workerUrl: url,
			onReaderEvent: event => {
				events.push(event)
			},
			limits: { deadlineMs: 40 },
		})
		try {
			const deadline = Date.now() + 1_000
			while (!logs.text().includes("Activity reader prewarm failed")) {
				if (Date.now() > deadline) {
					throw new Error(`prewarm was not logged: ${logs.text()}`)
				}
				await delay(10)
			}
			expect(logs.text()).toContain("sqlite missing")
			expect(events.filter(event => event.type === "spawn")).toHaveLength(1)
			const page = await service.search({ query: {} })
			expect(page.items).toEqual([])
			expect(events.filter(event => event.type === "spawn")).toHaveLength(2)
		} finally {
			await service.close()
		}
	})

	it("reports a reader that cannot start as ACTIVITY_QUERY_FAILED", async () => {
		const url = await worker(
			"hang.js",
			[
				'import { parentPort } from "node:worker_threads"',
				'parentPort?.on("message", () => {})',
				"setInterval(() => {}, 60_000)",
				"",
			].join("\n"),
		)
		const logs = captureLogger()
		service = openQueryService(fixture, {
			logger: logs.logger,
			execution: "worker",
			workerUrl: url,
			readyTimeoutMs: 80,
			limits: { deadlineMs: 30 },
		})
		try {
			const started = Date.now()
			const failed: unknown = await service.search({ query: {} }).then(
				() => null,
				(error: unknown) => error,
			)
			expect(Date.now() - started).toBeGreaterThan(50)
			expect(failed).toBeInstanceOf(ActivityReaderFailedError)
			expect(failed).toMatchObject({
				code: "ACTIVITY_QUERY_FAILED",
				statusCode: 500,
				message: "Activity reader did not start",
			})
			expect(logs.text()).toContain("Activity reader prewarm failed")
		} finally {
			await service.close()
		}
	})
})
