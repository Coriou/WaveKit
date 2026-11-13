/**
 * The free-receiver verdict of a plain resume (U1): rtlmux's client list from the sdr-host
 * (SdrHostPoller.clientsReading, both stats formats) against this connection's local port, fail
 * closed on anything unknown, and the reading's age bound at and past its limit.
 */
import { describe, expect, it } from "vitest"
import { SdrHostPoller } from "../../../src/core/sdr-host-poller.js"
import {
	DEFAULT_LIST_BOUNDS,
	receiverClientsListedAfter,
	receiverClientsMaxAgeMs,
	receiverClientsVerdict,
	sdrHostPairedWithSource,
	SDR_HOST_LIST_FETCH_MS,
	SDR_HOST_LIST_MAX_AGE_MS,
} from "../../../src/core/tuning-ledger-receiver-free.js"
import { createLogger } from "../../../src/utils/logger.js"

const logger = createLogger({ level: "fatal" })
const reading = (
	ports: Array<number | null>,
	clients = ports.length,
	listAgeMs: number | null = 0,
) => ({
	startedAt: 1000,
	clients,
	ports,
	listAgeMs,
})
/** A list just read (age 0): taken no earlier than the poll's start minus the fetch bound. */
const AT = 1000 - SDR_HOST_LIST_FETCH_MS

describe("receiverClientsVerdict", () => {
	const MAX = receiverClientsMaxAgeMs(3000, 2000)

	it("derives the age bound from the poll interval and timeout (8 s with the defaults)", () => {
		expect(MAX).toBe(8000)
	})

	it("is free only for this connection alone, within the age bound", () => {
		expect(receiverClientsVerdict(reading([5000]), 5000, 1000, MAX)).toEqual({
			free: true,
			reason: "port-matched",
			readingAt: AT,
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
		).toEqual({ free: false, reason: "another-client", readingAt: AT })
	})

	it("is free with exactly one listed client whose port does not match (a NAT that rewrites ports): sole-client", () => {
		const sole = { free: true, reason: "sole-client", readingAt: AT }
		expect(receiverClientsVerdict(reading([6000]), 5000, 1000, MAX)).toEqual(
			sole,
		)
		// One client without a port, or a bare count of one, is the same one client.
		expect(receiverClientsVerdict(reading([null]), 5000, 1000, MAX)).toEqual(
			sole,
		)
		expect(receiverClientsVerdict(reading([], 1), 5000, 1000, MAX)).toEqual(
			sole,
		)
		// The age bound holds for it as for a matched port: at the bound free, past it unknown.
		expect(
			receiverClientsVerdict(reading([6000]), 5000, 1000 + MAX, MAX).free,
		).toBe(true)
		expect(
			receiverClientsVerdict(reading([6000]), 5000, 1001 + MAX, MAX),
		).toEqual({ free: false, reason: "clients-unknown" })
	})

	it("holds with two or more clients whatever their ports: another client when the list names every client", () => {
		const another = { free: false, reason: "another-client", readingAt: AT }
		// Neither is this connection's port (a NAT, or a list missing ours): still another client.
		expect(
			receiverClientsVerdict(reading([6000, 7000]), 5000, 1000, MAX),
		).toEqual(another)
		expect(
			receiverClientsVerdict(reading([null, null, null]), 5000, 1000, MAX),
		).toEqual(another)
		// A bare count, or fewer entries than clients: who they are is unknown.
		expect(receiverClientsVerdict(reading([], 2), 5000, 1000, MAX)).toEqual({
			free: false,
			reason: "clients-unknown",
		})
		expect(receiverClientsVerdict(reading([6000], 3), 5000, 1000, MAX)).toEqual(
			{ free: false, reason: "clients-unknown" },
		)
	})

	it("dates a free verdict by when rtlmux listed the clients, not when the core's poll started (a cached sdr-host list)", () => {
		// 1.5 s old at the answer: listed no earlier than 1000 - 1500 - 3000.
		expect(
			receiverClientsVerdict(reading([6000], 1, 1_500), 5000, 1000, MAX),
		).toEqual({ free: true, reason: "sole-client", readingAt: -3_500 })
		expect(
			receiverClientsVerdict(reading([5000], 1, 1_500), 5000, 1000, MAX),
		).toEqual({ free: true, reason: "port-matched", readingAt: -3_500 })
		// No age (raw rtlmux stats, an older sdr-host): as old as the sdr-host serves a list.
		expect(
			receiverClientsVerdict(reading([6000], 1, null), 5000, 1000, MAX)
				.readingAt,
		).toBe(1000 - SDR_HOST_LIST_MAX_AGE_MS - SDR_HOST_LIST_FETCH_MS)
	})

	it("fails closed on every unknown: no reading, no connection, zero clients, a malformed count, a time in the future", () => {
		const unknown = { free: false, reason: "clients-unknown" }
		expect(receiverClientsVerdict(null, 5000, 1000, MAX)).toEqual(unknown)
		// No local port: our connection is not up, so one listed client is someone else.
		expect(receiverClientsVerdict(reading([5000]), null, 1000, MAX)).toEqual(
			unknown,
		)
		expect(receiverClientsVerdict(reading([]), 5000, 1000, MAX)).toEqual(
			unknown,
		)
		// One client but two ports: malformed, not one client.
		expect(
			receiverClientsVerdict(reading([5000, 6000], 1), 5000, 1000, MAX),
		).toEqual(unknown)
		expect(receiverClientsVerdict(reading([5000], 2), 5000, 1000, MAX)).toEqual(
			unknown,
		)
		expect(
			receiverClientsVerdict(reading([5000], Number.NaN), 5000, 1000, MAX),
		).toEqual(unknown)
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
		// No sampling block: the list's age is unknown.
		expect(r?.listAgeMs).toBeNull()
	})

	it("reads the list's age from the same answer (sampling.stats.ageMs), null when unusable", async () => {
		const body = (ageMs: unknown) => ({
			rtlmux: {
				running: true,
				stats: {
					clients: 1,
					bytesPerSec: 0,
					totalBytesSent: 0,
					clientDetails: [
						{ id: 0, address: "127.0.0.1:50123", bytesDropped: 0 },
					],
				},
			},
			sampling: { stats: { state: "ok", ageMs } },
		})
		expect((await poll(body(1_234)))?.listAgeMs).toBe(1_234)
		expect((await poll(body(0)))?.listAgeMs).toBe(0)
		expect((await poll(body(-5)))?.listAgeMs).toBeNull()
		expect((await poll(body("1000")))?.listAgeMs).toBeNull()
		expect((await poll(body(null)))?.listAgeMs).toBeNull()
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

describe("receiverClientsListedAfter", () => {
	const at = (listAgeMs: number | null, startedAt = 100_000) =>
		receiverClientsListedAfter({ startedAt, clients: 1, ports: [], listAgeMs })

	it("is the poll's start minus the reported list age minus the sdr-host's fetch bound (3 s)", () => {
		expect(SDR_HOST_LIST_FETCH_MS).toBe(3_000)
		expect(at(0)).toBe(97_000)
		expect(at(2_000)).toBe(95_000)
	})

	it("without a usable age takes the longest the sdr-host serves a list (30 s, so 33 s in all)", () => {
		expect(SDR_HOST_LIST_MAX_AGE_MS).toBe(30_000)
		const fallback = 100_000 - 33_000
		expect(at(null)).toBe(fallback)
		expect(at(-1)).toBe(fallback)
		expect(at(Number.NaN)).toBe(fallback)
		expect(at(Number.POSITIVE_INFINITY)).toBe(fallback)
		// A reported age at the sdr-host's bound is as old as the fallback; past it, older still.
		expect(at(30_000)).toBe(fallback)
		expect(at(30_001)).toBe(fallback - 1)
	})

	it("a cached list counts only once the poll starts the list's age and the fetch bound after the session", () => {
		const session = 50_000
		const fresh = (startedAt: number, age: number | null) =>
			(receiverClientsListedAfter({
				startedAt,
				clients: 1,
				ports: [null],
				listAgeMs: age,
			}) ?? -Infinity) > session
		// Age 2 s: at the bound (session + 5 s) not yet, 1 ms past it yes.
		expect(fresh(session + 5_000, 2_000)).toBe(false)
		expect(fresh(session + 5_001, 2_000)).toBe(true)
		// No age: 33 s.
		expect(fresh(session + 33_000, null)).toBe(false)
		expect(fresh(session + 33_001, null)).toBe(true)
	})

	it("takes custom bounds and fails closed on a non-finite start", () => {
		expect(
			receiverClientsListedAfter(
				{ startedAt: 1000, clients: 1, ports: [], listAgeMs: null },
				{ maxListAgeMs: 500, fetchMs: 100 },
			),
		).toBe(400)
		expect(
			receiverClientsListedAfter({
				startedAt: Number.NaN,
				clients: 1,
				ports: [],
				listAgeMs: 0,
			}),
		).toBeNull()
		expect(DEFAULT_LIST_BOUNDS).toEqual({
			maxListAgeMs: SDR_HOST_LIST_MAX_AGE_MS,
			fetchMs: SDR_HOST_LIST_FETCH_MS,
		})
	})
})

describe("sdrHostPairedWithSource", () => {
	it("pairs only an sdr-host on the host the IQ connection uses", () => {
		expect(
			sdrHostPairedWithSource(
				"http://receiver.example:8080",
				"receiver.example",
			),
		).toBe(true)
		expect(sdrHostPairedWithSource("http://[::1]:8080", "::1")).toBe(true)
		expect(
			sdrHostPairedWithSource(
				"http://RECEIVER.example:8080",
				"receiver.example",
			),
		).toBe(true)
	})

	it("an sdr-host elsewhere (its only client SDR++ on another receiver) is not paired: hold", () => {
		expect(
			sdrHostPairedWithSource("http://other.example:8080", "receiver.example"),
		).toBe(false)
		expect(sdrHostPairedWithSource(undefined, "receiver.example")).toBe(false)
		expect(
			sdrHostPairedWithSource("http://receiver.example:8080", undefined),
		).toBe(false)
		expect(sdrHostPairedWithSource("not a url", "receiver.example")).toBe(false)
	})
})
