/**
 * The free-receiver verdict of a plain resume (U1): rtlmux's client list from the sdr-host
 * (SdrHostPoller.clientsReading, both stats formats) against this connection's local port, fail
 * closed on anything unknown, and the reading's age bound at and past its limit.
 */
import { describe, expect, it } from "vitest"
import { SdrHostPoller } from "../../../src/core/sdr-host-poller.js"
import {
	receiverClientsMaxAgeMs,
	receiverClientsVerdict,
} from "../../../src/core/tuning-ledger-receiver-free.js"
import { createLogger } from "../../../src/utils/logger.js"

const logger = createLogger({ level: "fatal" })
const reading = (ports: Array<number | null>, clients = ports.length) => ({
	startedAt: 1000,
	clients,
	ports,
})

describe("receiverClientsVerdict", () => {
	const MAX = receiverClientsMaxAgeMs(3000, 2000)

	it("derives the age bound from the poll interval and timeout (8 s with the defaults)", () => {
		expect(MAX).toBe(8000)
	})

	it("is free only for this connection alone, within the age bound", () => {
		expect(receiverClientsVerdict(reading([5000]), 5000, 1000, MAX)).toEqual({
			free: true,
			reason: "receiver-free",
		})
		// At the bound it still counts; past it the reading is unknown.
		expect(
			receiverClientsVerdict(reading([5000]), 5000, 1000 + MAX, MAX).free,
		).toBe(true)
		expect(
			receiverClientsVerdict(reading([5000]), 5000, 1001 + MAX, MAX),
		).toEqual({ free: false, reason: "clients-unknown" })
	})

	it("names another client only when this connection is listed beside it", () => {
		expect(
			receiverClientsVerdict(reading([5000, 6000]), 5000, 1000, MAX),
		).toEqual({ free: false, reason: "another-client" })
	})

	it("fails closed on every unknown: no reading, no port, unlisted connection, a bare count, a time in the future", () => {
		const unknown = { free: false, reason: "clients-unknown" }
		expect(receiverClientsVerdict(null, 5000, 1000, MAX)).toEqual(unknown)
		expect(receiverClientsVerdict(reading([5000]), null, 1000, MAX)).toEqual(
			unknown,
		)
		// A reading from before this connection (or behind a NAT) never names it.
		expect(receiverClientsVerdict(reading([6000]), 5000, 1000, MAX)).toEqual(
			unknown,
		)
		expect(receiverClientsVerdict(reading([]), 5000, 1000, MAX)).toEqual(
			unknown,
		)
		expect(receiverClientsVerdict(reading([5000], 2), 5000, 1000, MAX)).toEqual(
			unknown,
		)
		expect(receiverClientsVerdict(reading([null]), 5000, 1000, MAX)).toEqual(
			unknown,
		)
		expect(receiverClientsVerdict(reading([5000]), 5000, 999, MAX)).toEqual(
			unknown,
		)
	})
})

describe("SdrHostPoller.clientsReading", () => {
	async function poll(body: unknown, ok = true) {
		const fetchFn = (async (url: string) => {
			if (!String(url).endsWith("/api/status"))
				return new Response(null, { status: 404 })
			return ok
				? new Response(JSON.stringify(body), {
						status: 200,
						headers: { "content-type": "application/json" },
					})
				: new Response(null, { status: 500 })
		}) as typeof fetch
		const poller = new SdrHostPoller(
			logger,
			[{ sourceId: "rtl", apiUrl: "http://sdr-host.invalid" }],
			{ fetchFn, pollIntervalMs: 60_000 },
		)
		poller.on("error", () => undefined)
		const answered = new Promise<void>(resolve =>
			poller.once("identity-result", () => resolve()),
		)
		poller.start()
		await answered
		// The reading is set once the whole poll (status, then host facts) finished.
		await new Promise(resolve => setTimeout(resolve, 20))
		poller.stop()
		return poller.clientsReading("rtl")
	}

	it("reads the ports of the sdr-host format's client addresses (IPv4 and IPv6)", async () => {
		const r = await poll({
			rtlmux: {
				running: true,
				stats: {
					clients: 2,
					bytesPerSec: 0,
					totalBytesSent: 0,
					clientDetails: [
						{ id: 0, address: "127.0.0.1:50123", bytesDropped: 0 },
						{ id: 1, address: "[::1]:50124", bytesDropped: 0 },
					],
				},
			},
		})
		expect(r).toMatchObject({ clients: 2, ports: [50123, 50124] })
		expect(typeof r?.startedAt).toBe("number")
	})

	it("reads the ports of raw rtlmux stats", async () => {
		const r = await poll({
			rtlmux: {
				running: true,
				stats: {
					server: { dataIn: 0, dataOut: 0 },
					clients: [
						{ client: { host: "127.0.0.1", port: 40001 }, dataOut: 1 },
						{ client: { host: "127.0.0.1" }, dataOut: 1 },
					],
				},
			},
		})
		expect(r).toMatchObject({ clients: 2, ports: [40001, null] })
	})

	it("has no reading after a failed poll, or without rtlmux stats", async () => {
		expect(await poll({}, false)).toBeNull()
		expect(await poll({ rtlTcp: { running: true } })).toBeNull()
	})
})
