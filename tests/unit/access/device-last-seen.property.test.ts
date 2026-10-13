import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	digestMachineToken,
	generateMachineToken,
	sessionCredentialBinding,
} from "../../../src/access/credentials.js"
import { SessionStore } from "../../../src/access/sessions.js"
import type { SessionSnapshot } from "../../../src/access/sessions.js"

const HOUR = 3_600_000
const START = 1_699_999_200_000
const binding = sessionCredentialBinding(
	digestMachineToken(generateMachineToken(() => Buffer.alloc(32, 5))),
)

interface TimelineEvent {
	device: number
	hour: number
	offset: number
	action: "admit" | "label" | "read" | "failSeen" | "failLabel"
	name: string | null
	kind: "browser" | "phone" | "tablet" | "desktop" | "cli" | "other" | null
}

async function openStore() {
	let epoch = START
	let mono = 0
	let random = 40
	let fail = false
	let durable: SessionSnapshot | undefined
	const persists: SessionSnapshot[] = []
	const persist = (snapshot: SessionSnapshot) => {
		const copy = structuredClone(snapshot)
		persists.push(copy)
		if (fail) {
			fail = false
			return Promise.reject(new Error("injected"))
		}
		durable = copy
		return Promise.resolve()
	}
	const store = await SessionStore.open({
		credentialBinding: binding,
		persist,
		epochNow: () => epoch,
		monotonicNow: () => mono,
		maxSessions: 4,
		ttlMs: 30 * 24 * HOUR,
		random: size => Buffer.alloc(size, ++random),
		logger: { warn() {} },
	})
	return {
		store,
		persists,
		durable: () => durable,
		failNext: () => {
			fail = true
		},
		clearFail: () => {
			fail = false
		},
		setClock: (value: number) => {
			epoch = value
			mono = value - START
		},
	}
}

describe("device last-seen timeline", () => {
	// Feature: web-gaps-2, Property 14: Device last-seen
	// Validates: Requirements 11.3, 11.6
	// Feature: core-access-policy, Property 7: Device labels and coarse last-seen
	// Validates: Requirements 4.9, 4.10, 4.11, 4.12
	it("keeps hour-aligned non-decreasing last-seen, one success per hour, and commit-free reads", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: 1, max: 3 }),
				fc.array(
					fc.record({
						device: fc.integer({ min: 0, max: 2 }),
						hour: fc.integer({ min: 0, max: 4 }),
						offset: fc.integer({ min: 0, max: HOUR - 1 }),
						action: fc.constantFrom(
							"admit",
							"label",
							"read",
							"failSeen",
							"failLabel",
						),
						name: fc.constantFrom<string | null>("Radio", "Field", null),
						kind: fc.constantFrom(
							"browser",
							"phone",
							"tablet",
							"desktop",
							"cli",
							"other",
							null,
						),
					}),
					{ minLength: 1, maxLength: 8 },
				),
				async (count, events: TimelineEvent[]) => {
					const env = await openStore()
					const ids: string[] = []
					for (let index = 0; index < count; index++) {
						const created = await env.store.create()
						if (created.kind !== "created")
							throw new Error("Expected created session")
						ids.push(created.principalId)
					}
					const requester = ids[0]
					if (!requester) throw new Error("Missing requester")
					const seenCommits = new Map<string, number>()
					let previous = env.store.exportSnapshot()
					for (const event of events) {
						if (env.store.unavailable) break
						const id = ids[event.device % count]
						if (!id) throw new Error("Missing device")
						const when = START + event.hour * HOUR + event.offset
						env.setClock(when)
						if (event.action === "read") {
							const calls = env.persists.length
							const before = env.store.exportSnapshot()
							env.store.snapshotActiveDevices(requester)
							env.store.snapshotRememberedDevices()
							expect(env.persists.length).toBe(calls)
							expect(env.store.exportSnapshot()).toEqual(before)
							continue
						}
						if (event.action === "label" || event.action === "failLabel") {
							const before = env.store.exportSnapshot()
							if (event.action === "failLabel") env.failNext()
							if (event.action === "failLabel") {
								await expect(
									env.store.label(id, {
										name: event.name,
										kind: event.kind,
									}),
								).rejects.toMatchObject({ code: "ACCESS_UNAVAILABLE" })
								expect(env.store.exportSnapshot()).toEqual(before)
								expect(env.store.unavailable).toBe(true)
								break
							}
							const updated = await env.store.label(id, {
								name: event.name,
								kind: event.kind,
							})
							expect(updated).toBe(true)
							const record = env.store
								.exportSnapshot()
								.sessions.find(row => row.deviceId === id)
							expect(record?.name).toBe(event.name)
							expect(record?.kind).toBe(event.kind)
							expect(record?.lastSeenAt).toBe(
								before.sessions.find(row => row.deviceId === id)?.lastSeenAt ??
									null,
							)
						} else {
							const before = env.store.exportSnapshot()
							if (event.action === "failSeen") env.failNext()
							const calls = env.persists.length
							await env.store.noteSeen(id, when)
							if (env.persists.length === calls) env.clearFail()
							if (event.action === "failSeen") {
								expect(env.store.exportSnapshot()).toEqual(before)
								expect(env.store.unavailable).toBe(false)
							}
						}
						const current = env.store.exportSnapshot()
						for (const record of current.sessions) {
							expect(
								record.lastSeenAt === null || record.lastSeenAt % HOUR === 0,
							).toBe(true)
							const prior = previous.sessions.find(
								row => row.deviceId === record.deviceId,
							)
							const priorSeen = prior?.lastSeenAt ?? -1
							const nextSeen = record.lastSeenAt ?? -1
							expect(nextSeen).toBeGreaterThanOrEqual(priorSeen)
							if (
								prior &&
								record.lastSeenAt !== null &&
								record.lastSeenAt !== prior.lastSeenAt
							) {
								const key = `${record.deviceId}:${record.lastSeenAt}`
								const commits = (seenCommits.get(key) ?? 0) + 1
								seenCommits.set(key, commits)
								expect(commits).toBe(1)
							}
						}
						previous = current
					}
					if (env.durable() !== undefined)
						expect(env.durable()?.version).toBe(2)
				},
			),
			{ numRuns: 100 },
		)
	})
})
