import fc from "fast-check"
import { describe, expect, it, vi } from "vitest"
import {
	digestMachineToken,
	generateMachineToken,
	sessionCredentialBinding,
} from "../../../src/access/credentials.js"
import { SessionStore } from "../../../src/access/sessions.js"
import type {
	SessionCreation,
	SessionSnapshot,
	SessionStoreOptions,
} from "../../../src/access/sessions.js"

const DAY = 24 * 60 * 60 * 1000
const binding = sessionCredentialBinding(
	digestMachineToken(generateMachineToken(() => Buffer.alloc(32, 99))),
)

function created(result: SessionCreation) {
	if (result.kind !== "created") throw new Error("Expected created session")
	return result
}

async function setup(overrides: Partial<SessionStoreOptions> = {}) {
	let elapsed = 0
	let randomCounter = 0
	let durable: SessionSnapshot | undefined
	const persist = vi.fn((snapshot: SessionSnapshot) => {
		durable = structuredClone(snapshot)
		return Promise.resolve()
	})
	const options: SessionStoreOptions = {
		credentialBinding: binding,
		persist,
		epochNow: () => 1_000_000,
		monotonicNow: () => elapsed,
		random: size => Buffer.alloc(size, ++randomCounter),
		...overrides,
	}
	const store = await SessionStore.open(options)
	return {
		store,
		persist,
		options,
		advance: (value: number) => {
			elapsed += value
		},
		durable: () => durable,
	}
}

describe("durable remembered-browser authority", () => {
	it("renews at day 29 to day 59, keeps the cookie across restart and has no absolute age cap", async () => {
		const env = await setup()
		const session = created(await env.store.create())
		expect(session.expiresAt).toBe(1_000_000 + 30 * DAY)
		expect(session.cookieMaxAgeSeconds).toBe((30 * DAY) / 1000)
		const close = vi.fn()
		const lease = env.store.onInvalidated(session.principalId, close)
		expect(lease.kind).toBe("attached")
		env.advance(29 * DAY)
		const renewed = await env.store.renew(session.principalId)
		expect(renewed).toMatchObject({
			kind: "renewed",
			expiresAt: 1_000_000 + 59 * DAY,
		})
		env.advance(DAY)
		expect(await env.store.pruneExpired()).toBe(0)
		if (lease.kind === "attached")
			expect(lease.current()?.expiresAt).toBe(1_000_000 + 59 * DAY)
		expect(close).not.toHaveBeenCalled()
		const restarted = await SessionStore.open({
			...env.options,
			epochNow: () => 1_000_000 + 30 * DAY,
			snapshot: env.durable(),
		})
		expect(restarted.lookup(session.cookieValue)?.principalId).toBe(
			session.principalId,
		)
		env.advance(28 * DAY)
		expect(await env.store.renew(session.principalId)).toMatchObject({
			kind: "renewed",
			expiresAt: 1_000_000 + 88 * DAY,
		})
		expect(env.store.lookup(session.cookieValue)).toBeDefined()
	})

	it("expires exactly at the idle deadline, cleans all leases and cannot revive on renewal", async () => {
		const env = await setup()
		const session = created(await env.store.create())
		const cleanup = vi.fn()
		let unsubscribePeer = () => {}
		env.store.onInvalidated(session.principalId, () => {
			unsubscribePeer()
			throw new Error("cleanup failed")
		})
		const peer = env.store.onInvalidated(session.principalId, cleanup)
		if (peer.kind === "attached") unsubscribePeer = peer.unsubscribe
		env.advance(30 * DAY - 1)
		expect(env.store.lookup(session.cookieValue)).toBeDefined()
		env.advance(1)
		expect(env.store.lookup(session.cookieValue)).toBeUndefined()
		expect(cleanup).toHaveBeenCalledOnce()
		expect(await env.store.renew(session.principalId)).toEqual({
			kind: "missing",
		})
		expect(await env.store.pruneExpired()).toBe(1)
		expect(await env.store.pruneExpired()).toBe(0)
		expect(cleanup).toHaveBeenCalledOnce()
		const restarted = await SessionStore.open({
			...env.options,
			epochNow: () => session.expiresAt,
			snapshot: env.durable(),
		})
		expect(restarted.lookup(session.cookieValue)).toBeUndefined()
	})

	it("waits for persistence before issuance, renewal or revocation becomes committed", async () => {
		let release: (() => void) | undefined
		let written: SessionSnapshot | undefined
		const env = await setup({
			persist: snapshot => {
				written = snapshot
				return new Promise<void>(resolve => {
					release = resolve
				})
			},
		})
		const issuance = env.store.create()
		await Promise.resolve()
		expect(env.store.exportSnapshot().sessions).toHaveLength(0)
		expect(written?.sessions).toHaveLength(1)
		release?.()
		const session = created(await issuance)
		env.advance(DAY)
		const renewal = env.store.renew(session.principalId)
		await Promise.resolve()
		expect(env.store.lookup(session.cookieValue)?.expiresAt).toBe(
			session.expiresAt,
		)
		release?.()
		await renewal
		expect(env.store.lookup(session.cookieValue)?.expiresAt).toBe(
			session.expiresAt + DAY,
		)
		const cleanup = vi.fn()
		env.store.onInvalidated(session.principalId, cleanup)
		const revocation = env.store.revoke(session.principalId)
		await Promise.resolve()
		expect(env.store.lookup(session.cookieValue)).toBeDefined()
		expect(cleanup).not.toHaveBeenCalled()
		release?.()
		expect(await revocation).toBe(true)
		expect(cleanup).toHaveBeenCalledOnce()
		expect(env.store.lookup(session.cookieValue)).toBeUndefined()
	})

	it("serializes concurrent renewals and renew/revoke without resurrecting devices", async () => {
		const env = await setup()
		const session = created(await env.store.create())
		env.advance(DAY)
		const [first, second] = await Promise.all([
			env.store.renew(session.principalId),
			env.store.renew(session.principalId),
		])
		expect(first).toEqual(second)
		const results = await Promise.all([
			env.store.renew(session.principalId),
			env.store.revoke(session.principalId),
			env.store.renew(session.principalId),
		])
		expect(results[0]).toMatchObject({ kind: "renewed" })
		expect(results[1]).toBe(true)
		expect(results[2]).toEqual({ kind: "missing" })
		expect(env.store.lookup(session.cookieValue)).toBeUndefined()
		expect(env.durable()?.sessions).toHaveLength(0)
	})

	it("rejects capacity without evicting, and replaces a verified browser without fixation or leaks", async () => {
		const env = await setup({ maxSessions: 1 })
		const first = created(await env.store.create())
		const close = vi.fn()
		env.store.onInvalidated(first.principalId, close)
		expect(await env.store.create()).toEqual({
			kind: "capacity",
			status: 429,
			code: "SESSION_CAPACITY",
		})
		expect(env.store.lookup(first.cookieValue)).toBeDefined()
		const second = created(
			await env.store.create({ replacePrincipalId: first.principalId }),
		)
		expect(second.cookieValue).not.toBe(first.cookieValue)
		expect(second.principalId).not.toBe(first.principalId)
		expect(env.store.lookup(first.cookieValue)).toBeUndefined()
		expect(close).toHaveBeenCalledOnce()
		expect(env.durable()?.sessions).toHaveLength(1)
		expect(await env.store.revoke(first.principalId)).toBe(false)
	})

	it("bounds randomness collisions without deleting the replacement's old session", async () => {
		const env = await setup({ random: size => Buffer.alloc(size) })
		await expect(env.store.create()).rejects.toMatchObject({
			code: "SESSION_GENERATION_FAILED",
		})
		expect(env.persist).not.toHaveBeenCalled()
		const other = await setup()
		const first = created(await other.store.create())
		let counter = 0
		const collisionStore = await SessionStore.open({
			...other.options,
			snapshot: other.durable(),
			random: size => Buffer.alloc(size, ++counter),
		})
		await expect(
			collisionStore.create({ replacePrincipalId: first.principalId }),
		).resolves.toMatchObject({ kind: "created" })
		// First candidate collides with the restored token; a later candidate wins.
		expect(counter).toBe(6)
	})

	it("rechecks attach races, counts repeated callback attachments and makes unsubscribe idempotent", async () => {
		const env = await setup({ maxListenersPerSession: 1 })
		const session = created(await env.store.create())
		const close = vi.fn()
		const attached = env.store.onInvalidated(session.principalId, close)
		expect(env.store.onInvalidated(session.principalId, close)).toEqual({
			kind: "capacity",
		})
		expect(close).toHaveBeenCalledOnce()
		if (attached.kind === "attached") {
			attached.unsubscribe()
			attached.unsubscribe()
		}
		await env.store.revoke(session.principalId)
		expect(close).toHaveBeenCalledOnce()
		expect(env.store.onInvalidated(session.principalId, close)).toEqual({
			kind: "invalidated",
		})
		expect(close).toHaveBeenCalledTimes(2)
	})

	it.each(["create", "renew", "revoke", "prune"] as const)(
		"latches unavailable and closes leases on failed %s persistence",
		async action => {
			const env = await setup()
			const session = created(await env.store.create())
			const close = vi.fn()
			env.store.onInvalidated(session.principalId, close)
			const before = env.store.exportSnapshot()
			env.persist.mockImplementation(() =>
				Promise.reject(new Error(session.cookieValue)),
			)
			if (action === "prune") env.advance(30 * DAY)
			const operation =
				action === "create"
					? env.store.create()
					: action === "renew"
						? env.store.renew(session.principalId)
						: action === "revoke"
							? env.store.revoke(session.principalId)
							: env.store.pruneExpired()
			await expect(operation).rejects.toMatchObject({
				code: "ACCESS_UNAVAILABLE",
				cause: undefined,
			})
			expect(env.store.unavailable).toBe(true)
			expect(env.store.lookup(session.cookieValue)).toBeUndefined()
			expect(close).toHaveBeenCalledOnce()
			expect(env.store.exportSnapshot()).toEqual(before)
			await expect(env.store.revokeAll()).rejects.toMatchObject({
				code: "ACCESS_UNAVAILABLE",
			})
		},
	)

	it("durably invalidates compatible old snapshots when the machine credential rotates", async () => {
		const env = await setup()
		const session = created(await env.store.create())
		const rotated = await SessionStore.open({
			...env.options,
			credentialBinding: "a".repeat(64),
			snapshot: env.durable(),
		})
		expect(rotated.lookup(session.cookieValue)).toBeUndefined()
		expect(env.durable()).toEqual({
			version: 2,
			credentialBinding: "a".repeat(64),
			sessions: [],
		})
		env.persist.mockRejectedValueOnce(new Error("private storage error"))
		await expect(
			SessionStore.open({
				...env.options,
				credentialBinding: "b".repeat(64),
				snapshot: env.durable(),
			}),
		).rejects.toMatchObject({ code: "ACCESS_UNAVAILABLE" })
	})

	it("rejects malformed, duplicate, future or overlong snapshot records without exposing private input", async () => {
		const env = await setup()
		const session = created(await env.store.create())
		const snapshot = env.store.exportSnapshot()
		const record = snapshot.sessions[0]!
		for (const malformed of [
			{ ...snapshot, version: 3 },
			{
				...snapshot,
				sessions: [{ ...record, name: "bad\nname" }],
			},
			{
				...snapshot,
				sessions: [{ ...record, kind: "laptop" }],
			},
			{
				...snapshot,
				sessions: [{ ...record, lastSeenAt: record.createdAt + 1 }],
			},
			{ ...snapshot, sessions: [record, record] },
			{
				...snapshot,
				sessions: [{ ...record, renewedAt: record.createdAt + DAY }],
			},
			{ ...snapshot, sessions: [{ ...record, expiresAt: record.renewedAt }] },
			{
				...snapshot,
				sessions: [{ ...record, expiresAt: record.expiresAt + 1 }],
			},
			{
				...snapshot,
				sessions: [{ ...record, tokenHash: session.cookieValue }],
			},
			{
				...snapshot,
				credentialBinding: "a".repeat(64),
				sessions: [record, record],
			},
			{
				...snapshot,
				sessions: [
					{
						...record,
						tokenHash: digestMachineToken(record.csrfToken).toString("hex"),
					},
				],
			},
			{
				...snapshot,
				sessions: [{ ...record, cookieValue: session.cookieValue }],
			},
		]) {
			await expect(
				SessionStore.open({ ...env.options, snapshot: malformed }),
			).rejects.toMatchObject({ code: "SESSION_SNAPSHOT_INVALID" })
		}
		expect(JSON.stringify(env.store)).toBe("{}")
		expect(JSON.stringify(snapshot)).not.toContain(session.cookieValue)
		snapshot.sessions[0]!.csrfToken = "mutated"
		snapshot.sessions.length = 0
		expect(env.store.lookup(session.cookieValue)?.csrfToken).toBe(
			session.csrfToken,
		)
		expect(env.store.exportSnapshot().sessions).toHaveLength(1)
	})

	it("ignores later wall-clock jumps and never reverses elapsed expiry progression", async () => {
		let wall = 1_000_000
		let mono = 10
		const env = await setup({
			epochNow: () => wall,
			monotonicNow: () => mono,
			ttlMs: 1000,
		})
		const session = created(await env.store.create())
		wall += 365 * DAY
		mono += 999
		expect(env.store.lookup(session.cookieValue)).toBeDefined()
		wall = 0
		mono -= 500
		expect(env.store.lookup(session.cookieValue)).toBeDefined()
		mono = 1010
		expect(env.store.lookup(session.cookieValue)).toBeUndefined()
		mono = 10
		expect(env.store.lookup(session.cookieValue)).toBeUndefined()
	})
})

describe("committed active device inventory", () => {
	// Feature: core-access-policy, Property 6: Committed active inventory
	// Validates: Requirements 4.6, 4.7, 4.8
	it("returns bounded detached identities, ordered clocks and exactly the requesting device", async () => {
		await fc.assert(
			fc.asyncProperty(fc.integer({ min: 1, max: 32 }), async count => {
				const env = await setup({ maxSessions: count })
				const identities: string[] = []
				for (let i = 0; i < count; i++) {
					identities.push(created(await env.store.create()).principalId)
					if (i % 2 === 0) env.advance(1)
				}
				const requester = identities[0]
				if (!requester) throw new Error("Missing requester")
				env.persist.mockClear()
				const snapshot = env.store.snapshotActiveDevices(requester)
				expect(snapshot.kind).toBe("active")
				if (snapshot.kind !== "active") throw new Error("Missing snapshot")
				expect(snapshot.devices).toHaveLength(count)
				expect(
					snapshot.devices
						.filter(device => device.current)
						.map(device => device.deviceId),
				).toEqual([requester])
				expect(snapshot.devices.map(device => device.deviceId)).toEqual(
					identities.toSorted((a, b) => {
						const groupA = Math.floor((identities.indexOf(a) + 1) / 2)
						const groupB = Math.floor((identities.indexOf(b) + 1) / 2)
						return groupA - groupB || (a < b ? -1 : a > b ? 1 : 0)
					}),
				)
				expect(Object.keys(snapshot.devices[0] ?? {}).sort()).toEqual([
					"createdAt",
					"current",
					"deviceId",
					"expiresAt",
					"kind",
					"lastSeenAt",
					"name",
					"renewedAt",
				])
				const first = snapshot.devices[0]
				if (first) first.expiresAt = 0
				expect(env.store.snapshotActiveDevices(requester)).not.toEqual(snapshot)
				expect(env.persist).not.toHaveBeenCalled()
			}),
			{ numRuns: 100 },
		)
	})

	it.each([1, 2, 32])(
		"respects configured capacity %i without changing read admission",
		async capacity => {
			const env = await setup({ maxSessions: capacity })
			const first = created(await env.store.create())
			for (let i = 1; i < capacity; i++) created(await env.store.create())
			expect(await env.store.create()).toMatchObject({
				kind: "capacity",
				status: 429,
			})
			expect(env.store.snapshotActiveDevices(first.principalId)).toMatchObject({
				kind: "active",
				devices: expect.arrayContaining([
					{
						deviceId: first.principalId,
						createdAt: 1_000_000,
						renewedAt: 1_000_000,
						expiresAt: first.expiresAt,
						current: true,
						name: null,
						kind: null,
						lastSeenAt: null,
					},
				]),
			})
		},
	)

	it("reads the clock once and filters expired peers without pruning, lease notification or writes", async () => {
		let now = 0
		const clock = vi.fn(() => now)
		const env = await setup({ ttlMs: 100, monotonicNow: clock })
		const old = created(await env.store.create())
		const cleanup = vi.fn()
		env.store.onInvalidated(old.principalId, cleanup)
		now = 50
		const current = created(await env.store.create())
		now = 100
		clock.mockClear()
		env.persist.mockClear()
		const result = env.store.snapshotActiveDevices(current.principalId)
		expect(result).toMatchObject({
			kind: "active",
			devices: [{ deviceId: current.principalId, current: true }],
		})
		expect(clock).toHaveBeenCalledTimes(1)
		expect(env.store.exportSnapshot().sessions).toHaveLength(2)
		expect(env.persist).not.toHaveBeenCalled()
		expect(cleanup).not.toHaveBeenCalled()
		expect(env.store.snapshotActiveDevices(old.principalId)).toEqual({
			kind: "missing",
		})
	})

	it.each(["create", "renew", "revoke"] as const)(
		"does not expose an uncommitted %s",
		async operation => {
			const env = await setup()
			const session = created(await env.store.create())
			const before = env.store.snapshotActiveDevices(session.principalId)
			let release = () => {}
			let entered = () => {}
			const atPersist = new Promise<void>(resolve => {
				entered = resolve
			})
			const barrier = new Promise<void>(resolve => {
				release = resolve
			})
			env.persist.mockImplementationOnce(async () => {
				entered()
				await barrier
			})
			env.advance(10)
			const pending =
				operation === "create"
					? env.store.create()
					: operation === "renew"
						? env.store.renew(session.principalId)
						: env.store.revoke(session.principalId)
			await atPersist
			expect(env.store.snapshotActiveDevices(session.principalId)).toEqual(
				before,
			)
			release()
			await pending
			expect(env.store.snapshotActiveDevices(session.principalId)).not.toEqual(
				before,
			)
		},
	)

	it("fails closed after persistence uncertainty and after a reentrant clock callback invalidates authority", async () => {
		const env = await setup()
		const session = created(await env.store.create())
		env.persist.mockRejectedValueOnce(new Error("private storage path"))
		await expect(env.store.renew(session.principalId)).rejects.toThrow()
		expect(() => env.store.snapshotActiveDevices(session.principalId)).toThrow(
			"Session authority unavailable",
		)

		let mode: "normal" | "reenter" | "fail" = "normal"
		let store: SessionStore | undefined
		const other = await setup({
			monotonicNow: () => {
				if (mode === "fail") return NaN
				if (mode === "reenter") {
					mode = "fail"
					try {
						store?.snapshotActiveDevices(session.principalId)
					} catch {
						/* Expected authority failure. */
					}
					mode = "normal"
				}
				return 0
			},
		})
		store = other.store
		const requester = created(await store.create())
		mode = "reenter"
		expect(() =>
			other.store.snapshotActiveDevices(requester.principalId),
		).toThrow("Session authority unavailable")
	})

	it("keeps v1 persistence and restart clocks unchanged by reads", async () => {
		const env = await setup()
		const session = created(await env.store.create())
		const durable = env.durable()
		const restarted = await SessionStore.open({
			...env.options,
			snapshot: durable,
		})
		env.persist.mockClear()
		expect(restarted.snapshotActiveDevices(session.principalId)).toEqual(
			env.store.snapshotActiveDevices(session.principalId),
		)
		expect(restarted.exportSnapshot()).toEqual(durable)
		expect(env.persist).not.toHaveBeenCalled()
	})
})

describe("device snapshot ordering and clock failures", () => {
	it("sorts equal creation times by ASCII identity, independent of private insertion order", async () => {
		const env = await setup()
		created(await env.store.create())
		created(await env.store.create())
		const privateState = env.store.exportSnapshot()
		const a = privateState.sessions[0]
		const b = privateState.sessions[1]
		if (!a || !b) throw new Error("Missing records")
		a.deviceId = `device_${"a".repeat(42)}A`
		b.deviceId = `device_${"Z".repeat(42)}A`
		const restarted = await SessionStore.open({
			...env.options,
			snapshot: privateState,
		})
		const result = restarted.snapshotActiveDevices(a.deviceId)
		if (result.kind !== "active") throw new Error("Missing requester")
		expect(result.devices.map(row => row.deviceId)).toEqual([
			b.deviceId,
			a.deviceId,
		])
	})

	it("returns every unexpired remembered device with no current requester", async () => {
		// Feature: browser-access-batch1, Property 1: Remembered-device inventory
		// Validates: browser-access-batch1 Decision 6
		await fc.assert(
			fc.asyncProperty(fc.integer({ min: 0, max: 32 }), async count => {
				const env = await setup({ maxSessions: Math.max(count, 1) })
				const identities: string[] = []
				for (let i = 0; i < count; i++) {
					identities.push(created(await env.store.create()).principalId)
					if (i % 2 === 0) env.advance(1)
				}
				env.persist.mockClear()
				const devices = env.store.snapshotRememberedDevices()
				expect(devices).toHaveLength(count)
				expect(devices.every(device => device.current === false)).toBe(true)
				expect(devices.map(device => device.deviceId)).toEqual(
					identities.toSorted((a, b) => {
						const groupA = Math.floor((identities.indexOf(a) + 1) / 2)
						const groupB = Math.floor((identities.indexOf(b) + 1) / 2)
						return groupA - groupB || (a < b ? -1 : a > b ? 1 : 0)
					}),
				)
				const first = devices[0]
				if (first) {
					first.expiresAt = 0
					expect(env.store.snapshotRememberedDevices()).not.toEqual(devices)
				} else {
					expect(env.store.snapshotRememberedDevices()).toEqual([])
				}
				expect(env.persist).not.toHaveBeenCalled()
			}),
			{ numRuns: 100 },
		)
	})

	it("omits expired rows from the machine inventory without pruning them", async () => {
		let now = 0
		const env = await setup({ ttlMs: 100, monotonicNow: () => now })
		const expired = created(await env.store.create())
		now = 50
		const live = created(await env.store.create())
		now = 100
		env.persist.mockClear()
		expect(env.store.snapshotRememberedDevices()).toEqual([
			expect.objectContaining({ deviceId: live.principalId, current: false }),
		])
		expect(
			env.store.exportSnapshot().sessions.map(record => record.deviceId),
		).toEqual([expired.principalId, live.principalId])
		expect(env.persist).not.toHaveBeenCalled()
	})

	it.each([NaN, Infinity, Number.MAX_SAFE_INTEGER])(
		"fails closed for an unusable clock value (%#)",
		async invalid => {
			let now = 0
			const env = await setup({ monotonicNow: () => now })
			const session = created(await env.store.create())
			now = invalid
			expect(() =>
				env.store.snapshotActiveDevices(session.principalId),
			).toThrow("Session authority unavailable")
			expect(env.store.unavailable).toBe(true)
		},
	)
})
