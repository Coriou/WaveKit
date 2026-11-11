import { describe, expect, it, vi } from "vitest"
import * as fc from "fast-check"
import {
	SdrHostPoller,
	sanitizeHostVersion,
} from "../../../src/core/sdr-host-poller.js"
import type { SdrHostStatus } from "@wavekit/api-types"
import { createLogger } from "../../../src/utils/logger.js"

const logger = createLogger({ level: "fatal" })

async function pollResponse(payload: unknown): Promise<SdrHostStatus> {
	const fetchFn = vi
		.fn<typeof fetch>()
		.mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }))
	const poller = new SdrHostPoller(
		logger,
		[{ sourceId: "local-iq", apiUrl: "http://localhost:8080" }],
		{ fetchFn },
	)
	try {
		const status = new Promise<SdrHostStatus>((resolve, reject) => {
			poller.once("status", resolve)
			poller.once("error", (_sourceId, error) => reject(error))
		})
		poller.start()
		const result = await status
		expect(fetchFn).toHaveBeenCalledWith(
			"http://localhost:8080/api/status",
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		)
		return result
	} finally {
		poller.stop()
	}
}

describe("SdrHostPoller device facts", () => {
	it("maps a failed USB check to no device fact", async () => {
		const status = await pollResponse({
			dongle: { present: false, probeFailed: true },
			rtlTcp: { running: false },
		})
		expect(status.receiverFacts).toEqual({
			deviceFound: null,
			rtlTcpRunning: false,
			deviceProbe: "failed",
		})
		expect(status.dongle?.probeFailed).toBe(true)
	})

	it("marks an answered USB check as an observation", async () => {
		const status = await pollResponse({
			dongle: { present: false, probeFailed: false },
		})
		expect(status.receiverFacts).toMatchObject({
			deviceFound: false,
			deviceProbe: "observed",
		})
		expect(status.dongle).not.toHaveProperty("probeFailed")
	})

	it("reads a host without the field as it always did", async () => {
		const status = await pollResponse({ dongle: { present: false } })
		expect(status.receiverFacts).toEqual({
			deviceFound: false,
			rtlTcpRunning: null,
		})
	})

	it("states no device from a malformed probe field", async () => {
		const status = await pollResponse({
			dongle: { present: false, probeFailed: "no" },
		})
		expect(status.receiverFacts).toEqual({
			deviceFound: null,
			rtlTcpRunning: null,
		})
	})
})

describe("SdrHostPoller API compatibility", () => {
	it("reports dongle presence from the actual SDR host status response", async () => {
		const status = await pollResponse({
			uptime: 120,
			dongle: {
				present: true,
				vendor: "Realtek Semiconductor Corp.",
				product: "RTL2838 DVB-T",
				serial: "00000001",
				driverConflict: false,
			},
			rtlTcp: {
				running: true,
				pid: 42,
				config: {
					sampleRate: 2400000,
					frequency: 100000000,
					gain: 0,
					agc: true,
				},
			},
			rtlmux: {
				running: true,
				stats: { clients: 1, bytesPerSec: 4800000, totalBytesSent: 9600000 },
			},
			warnings: [],
			errors: [],
		})
		expect(status.available).toBe(true)
		expect(status.dongle).toEqual({
			found: true,
			vendor: "Realtek Semiconductor Corp.",
			product: "RTL2838 DVB-T",
			serial: "00000001",
		})
		expect(status.rtlmux?.totalBytesSent).toBe(9600000)
	})

	it("prefers present=false over an older found field", async () => {
		const status = await pollResponse({
			dongle: { present: false, found: true },
		})
		expect(status.dongle?.found).toBe(false)
	})

	it("continues accepting the legacy dongle found field", async () => {
		const status = await pollResponse({ dongle: { found: true } })
		expect(status.dongle?.found).toBe(true)
	})

	it("sums raw rtlmux client IQ output instead of upstream command traffic", async () => {
		const status = await pollResponse({
			rtlmux: {
				running: true,
				stats: {
					server: { dataIn: 5000000, dataOut: 15 },
					clients: [
						{
							client: { host: "192.168.1.2", port: 50000 },
							dataOut: 2000000,
							dropped: { size: 1000 },
						},
						{
							client: { host: "192.168.1.3", port: 50001 },
							dataOut: 3000000,
							dropped: { size: 2000 },
						},
						{ client: { host: "192.168.1.4", port: 50002 } },
					],
				},
			},
		})
		expect(status.rtlmux?.clients).toBe(3)
		expect(status.rtlmux?.totalBytesSent).toBe(5000000)
		expect(status.rtlmux?.clientDetails).toEqual([
			{ id: 0, address: "192.168.1.2", bytesDropped: 1000 },
			{ id: 1, address: "192.168.1.3", bytesDropped: 2000 },
			{ id: 2, address: "192.168.1.4", bytesDropped: 0 },
		])
	})

	it.each([
		["1.0.0", "1.0.0"],
		[42, null],
		[{ v: 1 }, null],
		["x".repeat(65), null],
		["x".repeat(64), "x".repeat(64)],
		["1.0\u0007.0", null],
		["", null],
		[undefined, null],
	])("version %j becomes %j", async (version, expected) => {
		const status = await pollResponse({ version, uptime: 1 })
		expect(status.version).toBe(expected)
	})

	it("reports a null version when the field is missing", async () => {
		expect((await pollResponse({ uptime: 1 })).version).toBeNull()
	})

	it("the unavailable status has a null version", () => {
		const poller = new SdrHostPoller(logger, [
			{ sourceId: "a", apiUrl: "http://x" },
		])
		expect(poller.getStatus("a")?.version).toBeNull()
	})

	it.each([[null], [[1, 2]], ["text"], [7]])(
		"survives a non-object body %j without throwing",
		async body => {
			const fetchFn = vi
				.fn<typeof fetch>()
				.mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }))
			const poller = new SdrHostPoller(
				logger,
				[{ sourceId: "a", apiUrl: "http://x" }],
				{ fetchFn },
			)
			try {
				const failed = new Promise<void>(resolve =>
					poller.once("error", () => resolve()),
				)
				poller.start()
				await failed
				expect(poller.getStatus("a")?.available).toBe(false)
				expect(poller.getStatus("a")?.version).toBeNull()
			} finally {
				poller.stop()
			}
		},
	)
})

// Feature: web-gaps-4, Property 9: Poller hostility
// Validates: Requirements 5.5
describe("sanitizeHostVersion property", () => {
	it("never throws and only passes 1-64 printable ASCII strings", () => {
		fc.assert(
			fc.property(fc.jsonValue(), value => {
				const out = sanitizeHostVersion(value)
				if (out !== null) {
					expect(value).toBe(out)
					expect(/^[\x20-\x7e]{1,64}$/.test(out)).toBe(true)
				}
			}),
			{ numRuns: 200 },
		)
		fc.assert(
			fc.property(fc.string({ minLength: 1, maxLength: 64 }), s => {
				const ok = /^[\x20-\x7e]+$/.test(s)
				expect(sanitizeHostVersion(s)).toBe(ok ? s : null)
			}),
			{ numRuns: 200 },
		)
	})
})

describe("SdrHostPoller receiver endpoints (receiver-endpoints 1.1, 3.6)", () => {
	const base = {
		uptime: 1,
		rtlmux: { running: true, stats: { bytesPerSec: 1, clients: 1 } },
	}
	const fields = {
		receiverId: "0123456789abcdef0123456789abcdef",
		endpoints: {
			iqPort: 5555,
			apiPort: 8080,
			addresses: [
				{
					address: "192.0.2.69",
					family: "IPv4",
					interface: "eth0",
					kind: "ethernet",
					speedMbps: 100,
					signalDbm: null,
				},
				{
					address: "198.51.100.23",
					family: "IPv4",
					interface: "wlan0",
					kind: "wireless",
					speedMbps: null,
					signalDbm: -70,
				},
			],
		},
	}

	it("keeps the emitted status byte-identical when the receiver adds the endpoint fields", async () => {
		const strip = (s: SdrHostStatus) =>
			JSON.stringify({ ...s, lastFetchedAt: null })
		const without = await pollResponse(base)
		const withFields = await pollResponse({ ...base, ...fields })
		expect(strip(withFields)).toBe(strip(without))
		expect(Object.keys(withFields)).not.toContain("receiverId")
		expect(Object.keys(withFields)).not.toContain("endpoints")
	})

	it("emits the parsed report beside the status, or null when absent or invalid", async () => {
		const reportFor = async (payload: unknown) => {
			const poller = new SdrHostPoller(
				logger,
				[{ sourceId: "pi", apiUrl: "http://192.0.2.1:8080" }],
				{
					fetchFn: vi
						.fn<typeof fetch>()
						.mockResolvedValue(Response.json(payload)),
				},
			)
			const report = new Promise<unknown>(resolve =>
				poller.once("receiver-endpoints", (sourceId, value) => {
					expect(sourceId).toBe("pi")
					resolve(value)
				}),
			)
			poller.start()
			try {
				return await report
			} finally {
				poller.stop()
			}
		}
		expect(await reportFor({ ...base, ...fields })).toEqual({
			receiverId: fields.receiverId,
			endpoints: {
				iqPort: 5555,
				apiPort: 8080,
				addresses: [
					{ address: "192.0.2.69", kind: "ethernet" },
					{ address: "198.51.100.23", kind: "wireless" },
				],
			},
		})
		expect(await reportFor(base)).toBeNull()
		// A hostname anywhere in the list drops the whole report (fail closed).
		const hostname = structuredClone(fields)
		hostname.endpoints.addresses[1]!.address = "wavekit-pi.local"
		expect(await reportFor({ ...base, ...hostname })).toBeNull()
		expect(await reportFor({ ...base, ...fields, endpoints: null })).toBeNull()
		const loopback = structuredClone(fields)
		loopback.endpoints.addresses[0]!.address = "127.0.0.1"
		expect(await reportFor({ ...base, ...loopback })).toBeNull()
	})

	it("ignores the endpoint list of a redirected answer", async () => {
		const response = Response.json({ ...base, ...fields })
		Object.defineProperty(response, "redirected", { value: true })
		const poller = new SdrHostPoller(
			logger,
			[{ sourceId: "pi", apiUrl: "http://192.0.2.1:8080" }],
			{ fetchFn: vi.fn<typeof fetch>().mockResolvedValue(response) },
		)
		const report = new Promise<unknown>(resolve =>
			poller.once("receiver-endpoints", (_id, value) => resolve(value)),
		)
		poller.start()
		try {
			expect(await report).toBeNull()
		} finally {
			poller.stop()
		}
	})
})

describe("SdrHostPoller identity results", () => {
	const UNIT = "fedcba9876543210fedcba9876543210"

	it("emits each poll's result after /api/status, before /api/host answers", async () => {
		let releaseHost!: () => void
		const hostGate = new Promise<void>(resolve => (releaseHost = resolve))
		const fetchFn = vi.fn<typeof fetch>(async input => {
			if (String(input).endsWith("/api/host")) {
				await hostGate
				return new Response("{}", { status: 200 })
			}
			return new Response(JSON.stringify({ unitId: UNIT }), { status: 200 })
		})
		const poller = new SdrHostPoller(
			logger,
			[{ sourceId: "rtl", apiUrl: "http://sdr-host.invalid" }],
			{ fetchFn, pollIntervalMs: 60_000 },
		)
		try {
			const before = Date.now()
			const result = new Promise(resolve =>
				poller.once("identity-result", (_id, r) => resolve(r)),
			)
			poller.start()
			const r = (await result) as {
				startedAt: number
				ok: boolean
				facts: unknown
			}
			expect(r.ok).toBe(true)
			expect(r.facts).toEqual({ unitId: UNIT })
			expect(r.startedAt).toBeGreaterThanOrEqual(before)
			// /api/host is still pending: the result did not wait for it.
			expect(fetchFn).toHaveBeenCalledTimes(2)
			expect(poller.hasAnswered("rtl")).toBe(true)
		} finally {
			releaseHost()
			poller.stop()
		}
	})

	it("a failed poll is a result too (ok false, no facts), and answers nothing", async () => {
		const fetchFn = vi.fn<typeof fetch>().mockRejectedValue(new Error("down"))
		const poller = new SdrHostPoller(
			logger,
			[{ sourceId: "rtl", apiUrl: "http://sdr-host.invalid" }],
			{ fetchFn },
		)
		poller.on("error", () => {})
		try {
			const result = new Promise(resolve =>
				poller.once("identity-result", (_id, r) => resolve(r)),
			)
			poller.start()
			expect(await result).toMatchObject({ ok: false, facts: null })
			expect(poller.hasAnswered("rtl")).toBe(false)
		} finally {
			poller.stop()
		}
	})

	it("pollNow brings a scheduled poll (also a failure backoff) forward, and reruns once after one in flight", async () => {
		vi.useFakeTimers()
		try {
			let calls = 0
			let releaseStatus: (() => void) | null = null
			const fetchFn = vi.fn<typeof fetch>(async input => {
				if (String(input).endsWith("/api/host"))
					return new Response("{}", { status: 200 })
				calls++
				if (calls === 1) throw new Error("down")
				if (calls === 2)
					await new Promise<void>(resolve => (releaseStatus = resolve))
				return new Response(JSON.stringify({ unitId: UNIT }), { status: 200 })
			})
			const poller = new SdrHostPoller(
				logger,
				[{ sourceId: "rtl", apiUrl: "http://sdr-host.invalid" }],
				{ fetchFn, pollIntervalMs: 60_000, timeoutMs: 10_000 },
			)
			poller.on("error", () => {})
			const results: boolean[] = []
			poller.on("identity-result", (_id, r) => results.push(r.ok))
			poller.start()
			await vi.advanceTimersByTimeAsync(0)
			// The first poll failed: the next one is 2 s away; pollNow starts it now.
			expect(results).toEqual([false])
			poller.pollNow("rtl")
			await vi.advanceTimersByTimeAsync(0)
			expect(calls).toBe(2)
			// While it runs, a second pollNow queues exactly one more right after it.
			poller.pollNow("rtl")
			poller.pollNow("rtl")
			releaseStatus!()
			await vi.advanceTimersByTimeAsync(0)
			await vi.advanceTimersByTimeAsync(0)
			expect(calls).toBe(3)
			expect(results).toEqual([false, true, true])
			// Then back to the normal interval: nothing more for 60 s.
			await vi.advanceTimersByTimeAsync(59_000)
			expect(calls).toBe(3)
			poller.stop()
		} finally {
			vi.useRealTimers()
		}
	})
})
