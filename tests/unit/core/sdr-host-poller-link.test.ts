import { describe, it, expect, vi } from "vitest"
import { SdrHostPoller } from "../../../src/core/sdr-host-poller.js"
import { createLogger } from "../../../src/utils/logger.js"
import type { SdrHostStatus } from "@wavekit/api-types"

const reading = <T>(value: T, state = "ok") => ({ state, value })
const hostBody = () => ({
	network: reading([
		{ kind: "ethernet", defaultRouteMetric: 100, wireless: null },
		{
			name: "private-wlan",
			addresses: ["192.168.42.1"],
			kind: "wireless",
			defaultRouteMetric: 10,
			wireless: { signalDbm: -63 },
		},
		{ kind: "other", defaultRouteMetric: null, wireless: null },
	]),
	power: {
		undervoltageNow: reading(false),
		throttling: reading({ throttled: false }),
	},
})

async function poll(host: unknown, status: unknown = {}, failHost = false) {
	const fetchFn = vi.fn<typeof fetch>(async url => {
		if (url === "https://receiver.invalid/api/status")
			return Response.json(status)
		if (url === "https://receiver.invalid/api/host") {
			if (failHost) return new Response(null, { status: 503 })
			return Response.json(host)
		}
		return new Response(null, { status: 404 })
	})
	const poller = new SdrHostPoller(
		createLogger({ level: "fatal" }),
		[{ sourceId: "source", apiUrl: "https://receiver.invalid" }],
		{ fetchFn },
	)
	try {
		const ready = new Promise<SdrHostStatus>((resolve, reject) => {
			poller.once("status", resolve)
			poller.once("error", (_id, error) => reject(error))
		})
		poller.start()
		const result = await ready
		return { status: result, facts: poller.getLinkFacts("source") }
	} finally {
		poller.stop()
	}
}

describe("SDR host link facts", () => {
	it("default-route wireless interface yields kind and signal", async () => {
		expect((await poll(hostBody())).facts).toEqual({
			interfaceKind: "wireless",
			signalDbm: -63,
			undervoltageNow: false,
			throttled: false,
		})
	})

	it("stale undervoltage reading is null", async () => {
		const body = hostBody()
		body.power.undervoltageNow = reading(true, "stale")
		expect((await poll(body)).facts?.undervoltageNow).toBeNull()
	})

	it("throttling unavailable is null", async () => {
		const body = hostBody()
		body.power.throttling = reading({ throttled: true }, "unavailable")
		expect((await poll(body)).facts?.throttled).toBeNull()
		expect(
			(
				await poll({
					...body,
					power: { ...body.power, throttling: reading(null, "unavailable") },
				})
			).facts?.throttled,
		).toBeNull()
	})

	it("/api/host failure keeps status available", async () => {
		for (const result of [
			await poll(null, {}, true),
			await poll({ invalid: true }),
		]) {
			expect(result.status.available).toBe(true)
			expect(result.facts).toBeNull()
		}
	})

	it("addresses and names are never retained", async () => {
		const serialized = JSON.stringify((await poll(hostBody())).facts)
		expect(serialized).not.toContain("192.168.")
		expect(serialized).not.toContain("private-wlan")
		const body = hostBody()
		body.network.state = "stale"
		expect((await poll(body)).facts).toEqual({
			interfaceKind: null,
			signalDbm: null,
			undervoltageNow: false,
			throttled: false,
		})
	})

	it("iqDelivery modes parse; invalid → null", async () => {
		for (const modes of [[], ["raw"], ["raw", "channels"]]) {
			expect(
				(await poll(hostBody(), { iqDelivery: { modes } })).status.iqDelivery,
			).toEqual({ modes })
		}
		for (const iqDelivery of [
			undefined,
			null,
			{ modes: ["other"] },
			{ modes: ["raw", "raw", "raw"] },
			{ modes: "raw" },
		]) {
			expect(
				(await poll(hostBody(), { iqDelivery })).status.iqDelivery,
			).toBeNull()
		}
	})
})
