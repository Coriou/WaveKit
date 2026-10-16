import { describe, expect, it } from "vitest"
import {
	ActivityQueryBusyError,
	ActivityQueryTimeoutError,
} from "../../../../../src/core/activity/query/errors.js"
import { withActivityClient } from "../../../../../src/core/activity/query/service.js"
import type { ReaderHostEvent } from "../../../../../src/core/activity/query/reader-host.js"
import { createFixture, openQueryService } from "./fixture.js"

describe("activity query admission", () => {
	it("refuses a second in-flight read from the same client", async () => {
		const fixture = await createFixture()
		let calls = 0
		const service = openQueryService(fixture, {
			readerDelayMs: () => {
				calls += 1
				return calls === 1 ? 80 : 0
			},
		})
		try {
			const first = withActivityClient("same", () => service.search({ query: {} }))
			await expect(
				withActivityClient("same", () => service.search({ query: {} })),
			).rejects.toBeInstanceOf(ActivityQueryBusyError)
			await first
		} finally {
			await service.close()
			await fixture.close()
		}
	})

	it("keeps one executing reader and four queued readers", async () => {
		const fixture = await createFixture()
		const service = openQueryService(fixture, {
			readerDelayMs: 40,
			limits: { deadlineMs: 2_000 },
		})
		try {
			const jobs = []
			for (let index = 0; index < 5; index += 1) {
				jobs.push(withActivityClient(`c${index}`, () => service.search({ query: {} })))
			}
			await expect(
				withActivityClient("c5", () => service.search({ query: {} })),
			).rejects.toBeInstanceOf(ActivityQueryBusyError)
			const settled = await Promise.allSettled(jobs)
			expect(settled.every(result => result.status === "fulfilled")).toBe(true)
		} finally {
			await service.close()
			await fixture.close()
		}
	})

	it("terminates a slow inline read at the deadline and serves the next one", async () => {
		const fixture = await createFixture()
		fixture.insert({ eventId: "kept" })
		const events: ReaderHostEvent[] = []
		let calls = 0
		const service = openQueryService(fixture, {
			readerDelayMs: () => {
				calls += 1
				return calls === 1 ? 300 : 0
			},
			onReaderEvent: event => {
				events.push(event)
			},
			limits: { deadlineMs: 50 },
		})
		try {
			await expect(
				withActivityClient("one", () => service.search({ query: {} })),
			).rejects.toBeInstanceOf(ActivityQueryTimeoutError)
			expect(events.some(event => event.type === "terminate")).toBe(true)
			const page = await withActivityClient("two", () => service.search({ query: {} }))
			expect(page.items.map(item => item.eventId)).toEqual(["kept"])
		} finally {
			await service.close()
			await fixture.close()
		}
	})
})
