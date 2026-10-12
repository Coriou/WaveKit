import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { afterAll, describe, expect, it } from "vitest"
import {
	ActivityQueryError,
	ActivityQueryTimeoutError,
} from "../../../../../src/core/activity/query/errors.js"
import type { ReadRequest } from "../../../../../src/core/activity/query/read.js"
import {
	ReaderHost,
	type ReaderHostEvent,
} from "../../../../../src/core/activity/query/reader-host.js"
import { DEFAULT_ACTIVITY_QUERY_LIMITS } from "../../../../../src/core/activity/query/service.js"
import { normaliseQuery } from "../../../../../src/core/activity/query/validate.js"

const query = normaliseQuery({}, DEFAULT_ACTIVITY_QUERY_LIMITS)

function searchRequest(high: string): ReadRequest {
	return {
		op: "search",
		query,
		order: "asc",
		limit: 1,
		low: "0",
		high,
		before: null,
		after: null,
	}
}

describe("activity reader host", () => {
	let directory: string | undefined

	afterAll(async () => {
		if (directory) await rm(directory, { recursive: true, force: true })
	})

	async function worker(name: string, source: string): Promise<URL> {
		if (!directory) {
			const repository = fileURLToPath(new URL("../../../../../", import.meta.url))
			const cache = join(repository, "node_modules", ".cache")
			await mkdir(cache, { recursive: true })
			directory = await mkdtemp(join(cache, "wk-reader-host-"))
		}
		const file = join(directory, name)
		await writeFile(file, source)
		return pathToFileURL(file)
	}

	it("drops a reader that never becomes ready and opens a new one", async () => {
		const url = await worker(
			"hang.js",
			[
				'import { parentPort } from "node:worker_threads"',
				'parentPort?.on("message", () => {})',
				"setInterval(() => {}, 60_000)",
				"",
			].join("\n"),
		)
		const events: ReaderHostEvent[] = []
		if (!directory) throw new Error("reader host directory was not created")
		const host = new ReaderHost(
			join(directory, "missing.db"),
			"worker",
			url,
			event => {
				events.push(event)
			},
			40,
		)
		try {
			await expect(host.execute(searchRequest("1"), 0, {})).rejects.toBeInstanceOf(
				ActivityQueryTimeoutError,
			)
			await expect(host.execute(searchRequest("1"), 0, {})).rejects.toBeInstanceOf(
				ActivityQueryTimeoutError,
			)
			expect(events.filter(event => event.type === "spawn")).toHaveLength(2)
		} finally {
			await host.close()
		}
	})

	it("rebuilds worker failures as query errors with status 500", async () => {
		const url = await worker(
			"fail.js",
			[
				'import { parentPort } from "node:worker_threads"',
				'parentPort?.postMessage({ type: "ready" })',
				'parentPort?.on("message", message => {',
				'  if (!message || message.type !== "query") return',
				'  const code = message.request?.high === "2"',
				'    ? "ACTIVITY_RECORD_CORRUPT"',
				'    : "ACTIVITY_QUERY_FAILED"',
				"  parentPort.postMessage({",
				'    type: "result",',
				"    id: message.id,",
				"    generation: message.generation,",
				"    ok: false,",
				"    code,",
				'    message: "from worker",',
				"  })",
				"})",
				"",
			].join("\n"),
		)
		if (!directory) throw new Error("reader host directory was not created")
		const host = new ReaderHost(
			join(directory, "missing.db"),
			"worker",
			url,
			undefined,
		)
		try {
			const failed: unknown = await host
				.execute(searchRequest("1"), 0, {})
				.then(
					() => null,
					(error: unknown) => error,
				)
			expect(failed).toBeInstanceOf(ActivityQueryError)
			expect(failed).toMatchObject({
				code: "ACTIVITY_QUERY_FAILED",
				statusCode: 500,
			})
			const corrupt: unknown = await host
				.execute(searchRequest("2"), 0, {})
				.then(
					() => null,
					(error: unknown) => error,
				)
			expect(corrupt).toBeInstanceOf(ActivityQueryError)
			expect(corrupt).toMatchObject({
				code: "ACTIVITY_RECORD_CORRUPT",
				statusCode: 500,
			})
		} finally {
			await host.close()
		}
	})
})
