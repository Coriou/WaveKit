import { afterEach, describe, expect, it, vi } from "vitest"
import {
	digestMachineToken,
	sessionCredentialBinding,
} from "../../../src/access/credentials.js"
import { ConnectionLeases } from "../../../src/access/connection-leases.js"
import { SessionStore } from "../../../src/access/sessions.js"
import type { SessionCreation } from "../../../src/access/sessions.js"

afterEach(() => {
	vi.useRealTimers()
})

function created(result: SessionCreation) {
	if (result.kind !== "created") throw new Error("Expected created session")
	return result
}

async function fixture(ttlMs = 1000, maxListenersPerSession = 16) {
	let elapsed = 0
	let wall = 1000
	const store = await SessionStore.open({
		credentialBinding: sessionCredentialBinding(
			digestMachineToken("A".repeat(43)),
		),
		persist: async () => {},
		epochNow: () => wall,
		monotonicNow: () => elapsed,
		ttlMs,
		maxListenersPerSession,
	})
	return {
		store,
		advance: (value: number) => {
			elapsed += value
		},
		wallJump: (value: number) => {
			wall += value
		},
	}
}

describe("ConnectionLeases", () => {
	it("binds injected adapter managers to the actual session authority", async () => {
		const first = await fixture()
		const second = await fixture()
		const leases = new ConnectionLeases(first.store)
		expect(leases.usesSessionStore(first.store)).toBe(true)
		expect(leases.usesSessionStore(second.store)).toBe(false)
		leases.dispose()
	})

	it("rejects before admission without invoking transport cleanup", async () => {
		vi.useFakeTimers()
		const { store } = await fixture()
		const leases = new ConnectionLeases(store)
		const cleanup = vi.fn()
		expect(leases.attach("missing", cleanup)).toEqual({
			kind: "rejected",
			reason: "invalidated",
		})
		expect(cleanup).not.toHaveBeenCalled()
		expect(vi.getTimerCount()).toBe(0)
		leases.dispose()
	})

	it("shares one timer and frees both capacity bounds on release", async () => {
		vi.useFakeTimers()
		const { store } = await fixture(1000, 2)
		const session = created(await store.create())
		const leases = new ConnectionLeases(store, { maxConnections: 2 })
		const cleanup = vi.fn()
		const first = leases.attach(session.principalId, cleanup)
		const second = leases.attach(session.principalId, cleanup)
		expect(first.kind).toBe("attached")
		expect(second.kind).toBe("attached")
		expect(leases.attach(session.principalId, cleanup)).toEqual({
			kind: "rejected",
			reason: "capacity",
		})
		expect(vi.getTimerCount()).toBe(1)
		if (first.kind === "attached") {
			first.lease.release()
			first.lease.release()
			expect(first.lease.current()).toBeUndefined()
		}
		expect(leases.attach(session.principalId, cleanup).kind).toBe("attached")
		leases.dispose()
		expect(cleanup).toHaveBeenCalledTimes(2)
		expect(vi.getTimerCount()).toBe(0)
	})

	it("rejects authority listener capacity without closing a new transport", async () => {
		vi.useFakeTimers()
		const { store } = await fixture(1000, 1)
		const session = created(await store.create())
		const leases = new ConnectionLeases(store)
		const accepted = vi.fn()
		const rejected = vi.fn()
		expect(leases.attach(session.principalId, accepted).kind).toBe("attached")
		expect(leases.attach(session.principalId, rejected)).toEqual({
			kind: "rejected",
			reason: "capacity",
		})
		expect(rejected).not.toHaveBeenCalled()
		leases.dispose()
		expect(accepted).toHaveBeenCalledOnce()
	})

	it("enforces monotonic expiry and follows renewal across the original deadline", async () => {
		vi.useFakeTimers()
		const { store, advance, wallJump } = await fixture()
		const session = created(await store.create())
		const leases = new ConnectionLeases(store, { checkIntervalMs: 100 })
		const cleanup = vi.fn()
		leases.attach(session.principalId, cleanup)
		advance(900)
		await store.renew(session.principalId)
		wallJump(40 * 24 * 60 * 60 * 1000)
		advance(200)
		vi.advanceTimersByTime(100)
		expect(cleanup).not.toHaveBeenCalled()
		wallJump(-80 * 24 * 60 * 60 * 1000)
		advance(800)
		vi.advanceTimersByTime(100)
		expect(cleanup).toHaveBeenCalledOnce()
		expect(vi.getTimerCount()).toBe(0)
		leases.dispose()
	})

	it("never schedules a 30-day timeout and closes immediately on revocation", async () => {
		const { store } = await fixture(30 * 24 * 60 * 60 * 1000)
		const session = created(await store.create())
		const delays: number[] = []
		const clear = vi.fn()
		const leases = new ConnectionLeases(store, {
			timers: {
				set: (_callback, delay) => {
					delays.push(delay)
					return "timer"
				},
				clear,
			},
		})
		const cleanup = vi.fn()
		leases.attach(session.principalId, cleanup)
		expect(delays).toEqual([250])
		await store.revoke(session.principalId)
		expect(cleanup).toHaveBeenCalledOnce()
		expect(clear).toHaveBeenCalledWith("timer")
		leases.dispose()
		expect(cleanup).toHaveBeenCalledOnce()
	})

	it("isolates cleanup exceptions and makes disposal idempotent", async () => {
		vi.useFakeTimers()
		const { store } = await fixture()
		const session = created(await store.create())
		const leases = new ConnectionLeases(store)
		const next = vi.fn()
		leases.attach(session.principalId, () => {
			throw new Error("Transport cleanup failed")
		})
		leases.attach(session.principalId, next)
		leases.dispose()
		leases.dispose()
		expect(next).toHaveBeenCalledOnce()
		expect(vi.getTimerCount()).toBe(0)
		expect(leases.attach(session.principalId, next)).toEqual({
			kind: "rejected",
			reason: "disposed",
		})
	})

	it("closes all leases on storage failure and reports unavailable", async () => {
		vi.useFakeTimers()
		let fail = false
		const store = await SessionStore.open({
			credentialBinding: sessionCredentialBinding(
				digestMachineToken("A".repeat(43)),
			),
			persist: async () => {
				if (fail) throw new Error("Private storage cause")
			},
		})
		const session = created(await store.create())
		const cleanup = vi.fn()
		const leases = new ConnectionLeases(store)
		leases.attach(session.principalId, cleanup)
		fail = true
		await expect(store.renew(session.principalId)).rejects.toMatchObject({
			code: "ACCESS_UNAVAILABLE",
		})
		expect(cleanup).toHaveBeenCalledOnce()
		expect(vi.getTimerCount()).toBe(0)
		expect(leases.attach(session.principalId, cleanup)).toEqual({
			kind: "rejected",
			reason: "unavailable",
		})
		leases.dispose()
	})

	it("rejects invalid bounds and cleans failed timer attachment", async () => {
		const { store } = await fixture()
		expect(
			() => new ConnectionLeases(store, { checkIntervalMs: 1001 }),
		).toThrow()
		const session = created(await store.create())
		const cleanup = vi.fn()
		const leases = new ConnectionLeases(store, {
			timers: {
				set: () => {
					throw new Error("Timer implementation cause")
				},
				clear: () => {},
			},
		})
		expect(() => leases.attach(session.principalId, cleanup)).toThrow(
			"Lease scheduler unavailable",
		)
		expect(cleanup).not.toHaveBeenCalled()
		const direct = store.onInvalidated(session.principalId, cleanup)
		expect(direct.kind).toBe("attached")
		if (direct.kind === "attached") direct.unsubscribe()
		leases.dispose()
	})
})
