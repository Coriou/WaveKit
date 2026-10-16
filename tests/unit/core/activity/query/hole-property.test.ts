import fc from "fast-check"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
	ActivityCursorGapError,
	ActivitySnapshotResetError,
} from "../../../../../src/core/activity/query/errors.js"
import type {
	ActivityQueryService,
	ActivityReplayFrame,
} from "../../../../../src/core/activity/storage/contract.js"
import { fixtureClock } from "../storage/helpers.js"
import {
	collectReplay,
	createFixture,
	openQueryService,
	type ActivityFixture,
} from "./fixture.js"

type Step =
	| { op: "commit"; count: number }
	| { op: "prune"; pick: number }
	| { op: "hole"; mask: number }
	| { op: "page" }
	| { op: "replay" }
	| { op: "hole-below"; mask: number }

const stepArb: fc.Arbitrary<Step> = fc.oneof(
	{
		arbitrary: fc.record({
			op: fc.constant("commit" as const),
			count: fc.integer({ min: 1, max: 3 }),
		}),
		weight: 3,
	},
	{
		arbitrary: fc.record({
			op: fc.constant("prune" as const),
			pick: fc.nat(16),
		}),
		weight: 1,
	},
	{
		arbitrary: fc.record({
			op: fc.constant("hole" as const),
			mask: fc.integer({ min: 1, max: 255 }),
		}),
		weight: 2,
	},
	{ arbitrary: fc.record({ op: fc.constant("page" as const) }), weight: 3 },
	{ arbitrary: fc.record({ op: fc.constant("replay" as const) }), weight: 3 },
)

interface PageClient {
	token: string | null
	expected: string[]
	delivered: string[]
}

interface ReplayClient {
	cursor: string
	start: bigint
	position: bigint
	delivered: string[]
}

function isReset(frames: readonly ActivityReplayFrame[]): boolean {
	return frames.some(frame => frame.type === "reset")
}

/** Writer and both clients over the real fixture, cursor, replay and service. */
class Harness {
	readonly existing = new Set<string>()
	readonly committed: string[] = []
	watermark = 0n
	page: PageClient | null = null
	replay: ReplayClient | null = null
	resets = 0
	/** Page resets with no hole opened since that page started (4.8). */
	pageResetsWithoutHole = 0
	replayResets = 0
	private holeSincePage = false
	private next = 0

	constructor(
		private readonly store: ActivityFixture,
		private readonly query: ActivityQueryService,
	) {}

	commit(count: number): void {
		for (let index = 0; index < count; index += 1) {
			const seq = this.store.insert({ eventId: `r${this.next}` })
			this.next += 1
			this.existing.add(seq)
			this.committed.push(seq)
		}
		this.store.notify()
	}

	/** Rows above the prune watermark, ascending. */
	private live(): string[] {
		return [...this.existing]
			.filter(seq => BigInt(seq) > this.watermark)
			.sort((left, right) => (BigInt(left) < BigInt(right) ? -1 : 1))
	}

	prune(pick: number): void {
		const live = this.live()
		if (live.length === 0) return
		const through = live[pick % live.length] ?? "0"
		this.store.pruneThrough(through)
		this.watermark = BigInt(through)
		for (const seq of [...this.existing]) {
			if (BigInt(seq) <= this.watermark) this.existing.delete(seq)
		}
	}

	/** The writer removes rows above W: HW = max(HW, max deleted), HG + 1. */
	hole(mask: number): void {
		const live = this.live()
		const chosen = live.filter((_seq, index) => (mask >> (index % 8)) & 1)
		if (chosen.length === 0) return
		this.store.openHole(chosen)
		this.store.notify()
		this.holeSincePage = true
		for (const seq of chosen) this.existing.delete(seq)
	}

	/** A hole only among rows the replay client already has (or anywhere when idle). */
	holeBelow(mask: number): void {
		const limit = this.replay?.position
		const live = this.live().filter(
			seq => limit === undefined || BigInt(seq) <= limit,
		)
		const chosen = live.filter((_seq, index) => (mask >> (index % 8)) & 1)
		if (chosen.length === 0) return
		this.store.openHole(chosen)
		this.store.notify()
		this.holeSincePage = true
		for (const seq of chosen) this.existing.delete(seq)
	}

	async pageStep(): Promise<void> {
		try {
			if (this.page === null) {
				const expected = this.live()
				this.holeSincePage = false
				const first = await this.query.search({
					query: {},
					order: "asc",
					limit: 1,
				})
				this.page = {
					token: first.nextPageToken,
					expected,
					delivered: first.items.map(item => item.commitSeq),
				}
			} else {
				const token = this.page.token
				if (token === null) throw new Error("finished page client kept")
				const next = await this.query.search({
					query: {},
					order: "asc",
					limit: 1,
					pageToken: token,
				})
				this.page.delivered.push(...next.items.map(item => item.commitSeq))
				this.page.token = next.nextPageToken
			}
		} catch (error) {
			if (
				error instanceof ActivitySnapshotResetError ||
				error instanceof ActivityCursorGapError
			) {
				this.resets += 1
				if (!this.holeSincePage) this.pageResetsWithoutHole += 1
				this.page = null
				return
			}
			throw error
		}
		if (this.page.token === null) {
			// No reset: every row of the snapshot was delivered (none silently skipped).
			expect(this.page.delivered).toEqual(this.page.expected)
			this.page = null
		}
	}

	async replayStep(): Promise<void> {
		if (this.replay === null) {
			const page = await this.query.search({ query: {}, limit: 1 })
			this.replay = {
				cursor: page.replayCursor,
				start: BigInt(page.snapshot.highWater),
				position: BigInt(page.snapshot.highWater),
				delivered: [],
			}
		}
		const client = this.replay
		const head = this.store.store.identity().committedMax
		const { frames, handle } = await collectReplay(
			this.query,
			{ query: {}, cursor: client.cursor },
			collected =>
				isReset(collected) ||
				collected.some(
					frame => frame.type !== "reset" && frame.scannedThrough === head,
				),
		)
		handle.stop()
		if (isReset(frames)) {
			expect(frames.at(-1)).toMatchObject({
				type: "reset",
				reason: "cursor-gap",
			})
			this.resets += 1
			this.replayResets += 1
			this.replay = null
			return
		}
		for (const frame of frames) {
			if (frame.type === "reset") continue
			if (frame.type === "records") {
				client.delivered.push(...frame.items.map(item => item.commitSeq))
			}
			client.cursor = frame.cursor
			client.position = BigInt(frame.scannedThrough)
		}
		// Every row committed after the replay's start, whether or not it was
		// deleted later, reached the client.
		const expected = this.committed.filter(
			seq => BigInt(seq) > client.start && BigInt(seq) <= BigInt(head),
		)
		expect(client.delivered).toEqual(expected)
	}

	async run(step: Step): Promise<void> {
		switch (step.op) {
			case "commit":
				this.commit(step.count)
				return
			case "prune":
				this.prune(step.pick)
				return
			case "hole":
				this.hole(step.mask)
				return
			case "page":
				await this.pageStep()
				return
			case "replay":
				await this.replayStep()
				return
			case "hole-below":
				this.holeBelow(step.mask)
				return
		}
	}
}

describe("activity hole contract properties", () => {
	let store: ActivityFixture
	let query: ActivityQueryService

	beforeAll(async () => {
		store = await createFixture({ memory: true })
		query = openQueryService(store, {
			now: fixtureClock(),
			limits: { replayPage: 2 },
		})
	})

	afterAll(async () => {
		await query.close()
		await store.close()
	})

	// Feature: web-gaps-3, Property 6: No silent skip
	// Validates: Requirements 4.2, 4.3, 4.4, 4.6
	it("delivers every row existing at token issue, or resets", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.array(stepArb, { minLength: 1, maxLength: 24, size: "max" }),
				async steps => {
					store.reset()
					const harness = new Harness(store, query)
					for (const step of steps) await harness.run(step)
				},
			),
			{ numRuns: 150 },
		)
	}, 20_000)

	// Feature: web-gaps-3, Property 7: Reset termination
	// Validates: Requirements 4.5, 4.8
	it("a page or replay started after a reset is not reset without a new hole", async () => {
		const quiet: fc.Arbitrary<Step> = fc.oneof(
			fc.record({
				op: fc.constant("commit" as const),
				count: fc.integer({ min: 1, max: 3 }),
			}),
			fc.record({ op: fc.constant("page" as const) }),
			fc.record({ op: fc.constant("replay" as const) }),
			fc.record({
				op: fc.constant("hole-below" as const),
				mask: fc.integer({ min: 1, max: 255 }),
			}),
		)
		await fc.assert(
			fc.asyncProperty(
				fc.array(stepArb, { maxLength: 16 }),
				fc.array(quiet, { minLength: 1, maxLength: 16, size: "max" }),
				async (history, after) => {
					store.reset()
					const harness = new Harness(store, query)
					for (const step of history) await harness.run(step)
					// Clients restart after whatever reset the history produced.
					harness.page = null
					harness.replay = null
					const pageBefore = harness.pageResetsWithoutHole
					const replayBefore = harness.replayResets
					for (const step of after) await harness.run(step)
					// Holes at or below the follower's position never reset it, and a
					// page is reset only by a generation that landed after it started.
					expect(harness.pageResetsWithoutHole).toBe(pageBefore)
					expect(harness.replayResets).toBe(replayBefore)
				},
			),
			{ numRuns: 150 },
		)
	}, 20_000)
})
