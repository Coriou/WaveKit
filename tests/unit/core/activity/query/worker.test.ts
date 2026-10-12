import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { build } from "esbuild"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { ActivityQueryTimeoutError } from "../../../../../src/core/activity/query/errors.js"
import type { ReaderHostEvent } from "../../../../../src/core/activity/query/reader-host.js"
import type { ActivityQueryService } from "../../../../../src/core/activity/storage/contract.js"
import { createFixture, openQueryService, type ActivityFixture } from "./fixture.js"

describe("activity query worker", () => {
	let directory: string
	let workerUrl: URL
	let fixture: ActivityFixture
	let service: ActivityQueryService | undefined

	beforeAll(async () => {
		// Repository-local so Node can resolve external packages the same way
		// scripts/build-file.mjs does. os.tmpdir() cannot see this workspace.
		const repository = fileURLToPath(
			new URL("../../../../../", import.meta.url),
		)
		const cache = join(repository, "node_modules", ".cache")
		await mkdir(cache, { recursive: true })
		directory = await mkdtemp(join(cache, "wk-query-worker-"))
		const outfile = join(directory, "activity-query-worker.js")
		await build({
			absWorkingDir: repository,
			entryPoints: ["src/core/activity/query/activity-query-worker.ts"],
			bundle: true,
			outfile,
			platform: "node",
			format: "esm",
			packages: "external",
			logLevel: "silent",
		})
		workerUrl = pathToFileURL(outfile)
		fixture = await createFixture()
	})

	afterAll(async () => {
		await service?.close()
		await fixture.close()
		await rm(directory, { recursive: true, force: true })
	})

	it("reads committed rows through a real worker and sees a later commit", async () => {
		fixture.insert({ eventId: "first", text: "alpha" })
		service = openQueryService(fixture, {
			execution: "worker",
			workerUrl,
			limits: { deadlineMs: 5_000 },
		})
		try {
			const first = await service.search({ query: { text: "alpha" } })
			expect(first.items.map(item => item.eventId)).toEqual(["first"])
			fixture.insert({ eventId: "second", text: "alpha" })
			const second = await service.search({ query: { text: "alpha" } })
			expect(second.items.map(item => item.eventId)).toEqual([
				"second",
				"first",
			])
		} finally {
			await service.close()
		}
	}, 15_000)

	it("terminates the worker when a read passes the deadline and then reads again", async () => {
		const events: ReaderHostEvent[] = []
		let calls = 0
		service = openQueryService(fixture, {
			execution: "worker",
			workerUrl,
			readerDelayMs: () => {
				calls += 1
				return calls === 1 ? 2_000 : 0
			},
			onReaderEvent: event => {
				events.push(event)
			},
			limits: { deadlineMs: 800 },
		})
		try {
			await expect(service.search({ query: {} })).rejects.toBeInstanceOf(
				ActivityQueryTimeoutError,
			)
			expect(events.some(event => event.type === "terminate")).toBe(true)
			const page = await service.search({ query: {} })
			expect(page.items.length).toBeGreaterThan(0)
			expect(
				events.filter(event => event.type === "spawn").length,
			).toBeGreaterThanOrEqual(2)
		} finally {
			await service.close()
		}
	}, 15_000)
})
