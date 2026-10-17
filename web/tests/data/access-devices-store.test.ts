import { afterEach, describe, expect, it, vi } from "vitest"
import type { AccessDeviceDto } from "@wavekit/api-types"

import { AccessDevicesStore } from "../../src/data/access-devices-store.ts"
import {
	deviceSub,
	deviceTitle,
	devicesSummary,
	lastUsedText,
} from "../../src/features/settings/devices.ts"
import { json, scripted } from "./fake-fetch.ts"

const HOUR = 3_600_000
const NOW = Date.UTC(2026, 9, 17, 15, 20)
const id = (c: string) => `device_${c.repeat(42)}A`
const device = (
	c: string,
	over: Partial<AccessDeviceDto> = {},
): AccessDeviceDto => ({
	deviceId: id(c),
	createdAt: NOW - 5 * 24 * HOUR,
	renewedAt: NOW - HOUR,
	expiresAt: NOW + 30 * 24 * HOUR,
	current: false,
	name: null,
	kind: null,
	lastSeenAt: null,
	...over,
})
const LIST = [
	device("a", { current: true, name: "Studio Mac", kind: "desktop" }),
	device("b", { name: "Ben's iPhone", kind: "phone" }),
	device("c", { kind: "tablet" }),
]

afterEach(() => vi.useRealTimers())

// Feature: web app access (Settings › Signed-in devices)
describe("AccessDevicesStore", () => {
	it("loads the devices and treats a 401 as no session", async () => {
		let paired = true
		const { api } = scripted(() =>
			paired
				? json(200, { devices: LIST })
				: json(401, { code: "AUTH_REQUIRED" }),
		)
		const store = new AccessDevicesStore(api)
		await store.load()
		expect(store.get().devices?.map(d => d.name)).toEqual([
			"Studio Mac",
			"Ben's iPhone",
			null,
		])
		paired = false
		await store.load()
		expect(store.get()).toMatchObject({ devices: null, error: null })
	})

	it("labels a device, trimming the name and clearing an empty one", async () => {
		const { api, calls } = scripted(call =>
			call.method === "GET"
				? json(200, { devices: LIST })
				: json(200, { updated: true }),
		)
		const store = new AccessDevicesStore(api)
		await store.load()
		await store.label(id("c"), { name: "  Kitchen tablet ", kind: "tablet" })
		await store.label(id("b"), { name: "   " })
		expect(calls.slice(1).map(c => c.body)).toEqual([
			{ deviceId: id("c"), name: "Kitchen tablet", kind: "tablet" },
			{ deviceId: id("b"), name: null },
		])
		expect(store.get().devices?.map(d => d.name)).toEqual([
			"Studio Mac",
			null,
			"Kitchen tablet",
		])
	})

	it("signs another device out after the Undo grace, and Undo keeps it", async () => {
		vi.useFakeTimers()
		const { api, calls } = scripted(call =>
			call.method === "GET"
				? json(200, { devices: LIST })
				: json(200, { revoked: true }),
		)
		const store = new AccessDevicesStore(api)
		await store.load()
		const undo = store.scheduleRevoke(id("b"), () => {}, 1000)
		expect(store.get().removing.has(id("b"))).toBe(true)
		undo()
		expect(store.get().removing.has(id("b"))).toBe(false)
		store.scheduleRevoke(id("c"), () => {}, 1000)
		await vi.advanceTimersByTimeAsync(1000)
		expect(calls.filter(c => c.method === "POST").map(c => c.body)).toEqual([
			{ deviceId: id("c") },
		])
		expect(store.get().devices?.map(d => d.deviceId)).toEqual([
			id("a"),
			id("b"),
		])
		expect(store.get().removing.size).toBe(0)
	})

	it("shows a device again when its sign-out fails", async () => {
		vi.useFakeTimers()
		const { api } = scripted(call =>
			call.method === "GET"
				? json(200, { devices: LIST })
				: json(503, { code: "ACCESS_UNAVAILABLE" }),
		)
		const store = new AccessDevicesStore(api)
		await store.load()
		const onError = vi.fn()
		store.scheduleRevoke(id("b"), onError, 10)
		await vi.advanceTimersByTimeAsync(10)
		expect(onError).toHaveBeenCalledOnce()
		expect(store.get().removing.size).toBe(0)
		expect(store.get().devices).toHaveLength(3)
	})
})

describe("device words", () => {
	it("names unnamed devices by kind", () => {
		expect(deviceTitle({ name: null, kind: "phone" })).toBe("Unnamed phone")
		expect(deviceTitle({ name: null, kind: null })).toBe("Unnamed browser")
		expect(deviceTitle({ name: "Shack", kind: "cli" })).toBe("Shack")
	})

	it("says when a device was last used, at the core's hour resolution", () => {
		const hour = Math.floor(NOW / HOUR) * HOUR
		expect(lastUsedText(hour, NOW)).toBe("used this hour")
		expect(lastUsedText(hour - 3 * HOUR, NOW)).toBe("used 3 h ago")
		expect(lastUsedText(hour - 4 * 24 * HOUR, NOW)).toBe("used 13 Oct")
	})

	it("sums a device up in one line", () => {
		const d = device("b", {
			lastSeenAt: Math.floor(NOW / HOUR) * HOUR - 2 * HOUR,
		})
		expect(deviceSub(d, NOW)).toBe(
			"Paired 12 Oct · used 2 h ago · signed in until 16 Nov",
		)
		expect(
			deviceSub({ ...d, expiresAt: NOW + HOUR, lastSeenAt: null }, NOW),
		).toBe("Paired 12 Oct · signs out within a day")
	})

	it("lists this browser first in the Settings row", () => {
		expect(devicesSummary(LIST)).toBe(
			"This browser, Ben's iPhone and 1 more",
		)
		expect(devicesSummary(LIST.slice(0, 2))).toBe(
			"This browser and Ben's iPhone",
		)
	})
})
