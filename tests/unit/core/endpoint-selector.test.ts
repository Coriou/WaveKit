/**
 * Receiver endpoint selection (docs/specs/receiver-endpoints, user story 3).
 */
import { describe, expect, it } from "vitest"
import * as fc from "fast-check"
import {
	ENDPOINT_CANDIDATE_BACKOFF_MS,
	EndpointSelector,
	type EndpointSelectorSources,
} from "../../../src/core/endpoint-selector.js"
import type { EndpointProbe } from "../../../src/core/endpoint-probe.js"
import type { ReceiverEndpointsReport } from "../../../src/core/sdr-host-poller.js"
import { createLogger } from "../../../src/utils/logger.js"

const logger = createLogger({ level: "fatal" })
const ID = "0123456789abcdef0123456789abcdef"
const OTHER_ID = "fedcba9876543210fedcba9876543210"
const WIFI = "198.51.100.23"
const ETH = "192.0.2.69"
const HOLD = 300_000

function report(
	addresses: Array<[string, "ethernet" | "wireless" | "other"]> = [
		[ETH, "ethernet"],
		[WIFI, "wireless"],
	],
	receiverId = ID,
	iqPort = 5555,
	apiPort = 8080,
): ReceiverEndpointsReport {
	return {
		receiverId,
		endpoints: {
			iqPort,
			apiPort,
			addresses: addresses.map(([address, kind]) => ({ address, kind })),
		},
	}
}

interface FakeConfig {
	type: string
	host: string
	port: number
	sdrHost?: { endpointSelection?: "auto" | "off" }
}

class FakeSources implements EndpointSelectorSources {
	active: string
	connected = true
	tracked = false
	config: FakeConfig
	readonly switches: Array<{ host: string; reason: string }> = []
	constructor(readonly configured: string) {
		this.active = configured
		this.config = {
			type: "rtl_tcp",
			host: configured,
			port: 5555,
			sdrHost: { endpointSelection: "auto" },
		}
	}
	getStatus() {
		return { connected: this.connected }
	}
	getConfig() {
		return this.config
	}
	getActiveHost() {
		return this.active
	}
	trackEndpoint() {
		this.tracked = true
		return true
	}
	retarget(_id: string, host: string, reason: string) {
		this.active = host
		this.switches.push({ host, reason })
		return true
	}
	/** What SourceManager does on its own after repeated endpoint failures. */
	failBack(selector: EndpointSelector) {
		const left = this.active
		this.active = this.configured
		this.switches.push({
			host: this.configured,
			reason: "fallback: selected endpoint failed",
		})
		selector.onFallback("pi", left)
	}
}

class FakeProbe implements EndpointProbe {
	ids = new Map<string, string | null>()
	headers = new Map<string, boolean>()
	readonly calls: string[] = []
	readonly apiPorts: number[] = []
	async receiverId(address: string, apiPort: number) {
		this.apiPorts.push(apiPort)
		this.calls.push(`id ${address}`)
		return this.ids.get(address) ?? null
	}
	async rtlTcpHeader(address: string) {
		this.calls.push(`iq ${address}`)
		return this.headers.get(address) ?? false
	}
}

function setup(configured = WIFI, holdDownMs = HOLD) {
	let now = 1_000_000
	const sources = new FakeSources(configured)
	const probe = new FakeProbe()
	const selector = new EndpointSelector(
		logger,
		sources,
		probe,
		[{ sourceId: "pi", configuredHost: configured, port: 5555, apiPort: 8080 }],
		{ now: () => now, holdDownMs },
	)
	return {
		sources,
		probe,
		selector,
		advance: (ms: number) => {
			now += ms
		},
		send: (r: ReceiverEndpointsReport | null) => selector.onReport("pi", r),
		failBack: () => sources.failBack(selector),
	}
}

describe("EndpointSelector", () => {
	it("moves to a better-ranked endpoint only after the same receiverId and an RTL0 header", async () => {
		const t = setup()
		t.probe.ids.set(ETH, ID)
		t.probe.headers.set(ETH, true)
		await t.send(report())
		expect(t.sources.tracked).toBe(true)
		expect(t.probe.calls).toEqual([`id ${ETH}`, `iq ${ETH}`])
		expect(t.sources.switches).toEqual([
			{ host: ETH, reason: "verified ethernet endpoint" },
		])
		// Already on the best endpoint: no further probing.
		t.advance(HOLD)
		await t.send(report())
		expect(t.probe.calls).toHaveLength(2)
	})

	it("keeps the active host on any failed check and backs the candidate off", async () => {
		const t = setup()
		t.probe.ids.set(ETH, OTHER_ID) // a different receiver at that address
		t.probe.headers.set(ETH, true)
		await t.send(report())
		t.probe.ids.set(ETH, ID)
		t.probe.headers.set(ETH, false) // not an rtl_tcp server
		t.advance(61_000)
		await t.send(report())
		await t.send(report()) // inside the doubled backoff: not probed again
		expect(t.sources.switches).toEqual([])
		expect(t.probe.calls).toEqual([`id ${ETH}`, `id ${ETH}`, `iq ${ETH}`])
	})

	it("does nothing without a report, while disconnected, or when the source port is not the receiver's IQ port", async () => {
		const t = setup()
		t.probe.ids.set(ETH, ID)
		t.probe.headers.set(ETH, true)
		await t.send(null)
		await t.send(report(undefined, ID, 1234))
		t.sources.connected = false
		await t.send(report())
		expect(t.probe.calls).toEqual([])
		expect(t.sources.switches).toEqual([])
	})

	it("backs off an endpoint SourceManager left, and falls back on a delisted endpoint or a new receiver", async () => {
		const t = setup()
		t.probe.ids.set(ETH, ID)
		t.probe.headers.set(ETH, true)
		await t.send(report())
		expect(t.sources.active).toBe(ETH)

		t.failBack()
		expect(t.sources.active).toBe(WIFI)
		// Hold-down and backoff: no immediate return to the endpoint that just failed.
		await t.send(report())
		expect(t.sources.active).toBe(WIFI)
		t.advance(HOLD)
		await t.send(report())
		expect(t.sources.active).toBe(ETH)

		await t.send(report([[WIFI, "wireless"]]))
		expect(t.sources.active).toBe(WIFI)
		expect(t.sources.switches.at(-1)?.reason).toMatch(/no longer lists/)

		t.advance(10 * HOLD)
		await t.send(report())
		expect(t.sources.active).toBe(ETH)
		// sdr-host restarted with a new id: the active endpoint must prove it again.
		t.probe.ids.set(ETH, OTHER_ID)
		await t.send(report(undefined, OTHER_ID))
		expect(t.sources.active).toBe(ETH)
		t.probe.ids.set(ETH, ID)
		await t.send(report(undefined, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"))
		expect(t.sources.active).toBe(WIFI)
		expect(t.sources.switches.at(-1)?.reason).toMatch(/identity changed/)
	})

	it("keeps the doubled backoff across a successful switch so a flapping endpoint waits longer", async () => {
		const t = setup(WIFI, 0) // no hold-down: only the backoff gates
		t.probe.ids.set(ETH, ID)
		t.probe.headers.set(ETH, true)
		await t.send(report())
		t.failBack() // backoff 60 s
		t.advance(ENDPOINT_CANDIDATE_BACKOFF_MS)
		await t.send(report())
		expect(t.sources.active).toBe(ETH)
		t.failBack() // doubles to 120 s, not reset by the switch
		t.advance(ENDPOINT_CANDIDATE_BACKOFF_MS)
		await t.send(report())
		expect(t.sources.active).toBe(WIFI)
		t.advance(ENDPOINT_CANDIDATE_BACKOFF_MS)
		await t.send(report())
		expect(t.sources.active).toBe(ETH)
	})

	it("leaves a source alone once its config is no longer the selection target", async () => {
		const changes: Array<Partial<FakeConfig>> = [
			{ host: "203.0.113.5" },
			{ port: 1234 },
			{ sdrHost: { endpointSelection: "off" } },
			{ sdrHost: {} },
		]
		for (const change of changes) {
			const t = setup()
			t.probe.ids.set(ETH, ID)
			t.probe.headers.set(ETH, true)
			t.sources.config = { ...t.sources.config, ...change }
			t.sources.active = t.sources.config.host
			await t.send(report())
			expect(t.sources.tracked).toBe(false)
			expect(t.sources.switches).toEqual([])
		}
		// A config change while a probe is in flight cancels the switch.
		const t = setup()
		t.probe.headers.set(ETH, true)
		t.probe.receiverId = async () => {
			t.sources.config = { ...t.sources.config, host: "203.0.113.5" }
			return ID
		}
		await t.send(report())
		expect(t.sources.switches).toEqual([])
	})

	it("probes only the configured API port; a different reported apiPort idles selection", async () => {
		const t = setup()
		t.probe.ids.set(ETH, ID)
		t.probe.headers.set(ETH, true)
		await t.send(report(undefined, ID, 5555, 22))
		expect(t.probe.calls).toEqual([])
		expect(t.sources.switches).toEqual([])
		await t.send(report())
		expect(t.probe.apiPorts).toEqual([8080])
		expect(t.sources.active).toBe(ETH)
		// On a selected endpoint, a changed apiPort sends the source home.
		await t.send(report(undefined, ID, 5555, 22))
		expect(t.sources.active).toBe(WIFI)
	})

	it("treats a configured hostname or bridge address as unranked", async () => {
		const t = setup("127.0.0.1")
		t.probe.ids.set(ETH, ID)
		t.probe.headers.set(ETH, true)
		await t.send(report())
		expect(t.sources.active).toBe(ETH)
	})

	it("drops a report that arrives while the previous one is still probing", async () => {
		const t = setup()
		let release: (value: string) => void = () => {}
		t.probe.receiverId = address => {
			t.probe.calls.push(`id ${address}`)
			return new Promise<string>(resolve => (release = resolve))
		}
		t.probe.headers.set(ETH, true)
		const first = t.send(report())
		await t.send(report())
		release(ID)
		await first
		expect(t.probe.calls).toEqual([`id ${ETH}`, `iq ${ETH}`])
		expect(t.sources.switches).toHaveLength(1)
	})
})

const ALL = [ETH, WIFI, "203.0.113.5"]
const step = fc.record({
	addresses: fc.subarray(ALL).chain(list =>
		fc.shuffledSubarray(list, {
			minLength: list.length,
			maxLength: list.length,
		}),
	),
	receiverId: fc.constantFrom(ID, OTHER_ID),
	idAnswers: fc.dictionary(
		fc.constantFrom(...ALL),
		fc.option(fc.constantFrom(ID, OTHER_ID), { nil: null }),
	),
	headerOk: fc.dictionary(fc.constantFrom(...ALL), fc.boolean()),
	connected: fc.boolean(),
	failBack: fc.boolean(),
	advanceMs: fc.integer({ min: 0, max: 2 * HOLD }),
	nullReport: fc.boolean(),
})
type Step = typeof step extends fc.Arbitrary<infer T> ? T : never

const toReport = (s: Step): ReceiverEndpointsReport | null =>
	s.nullReport
		? null
		: report(
				s.addresses.map(a => [a, a === WIFI ? "wireless" : "ethernet"]),
				s.receiverId,
			)

describe("EndpointSelector properties", () => {
	// Feature: receiver-endpoints, Property 2: No unverified switch
	// Validates: Requirements 3.2, 3.6
	it("only ever moves to a listed address after both checks pass for the reported receiver", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.array(step, { minLength: 1, maxLength: 12 }),
				async steps => {
					const t = setup()
					for (const s of steps) {
						t.probe.ids = new Map(Object.entries(s.idAnswers))
						t.probe.headers = new Map(Object.entries(s.headerOk))
						t.probe.calls.length = 0
						t.sources.connected = s.connected
						if (s.failBack && t.sources.active !== WIFI) t.failBack()
						t.advance(s.advanceMs)
						const r = toReport(s)
						const before = t.sources.switches.length
						await t.send(r)
						for (const sw of t.sources.switches.slice(before)) {
							if (sw.host === WIFI) continue // the configured anchor
							expect(r).not.toBeNull()
							expect(r?.endpoints.addresses.map(a => a.address)).toContain(
								sw.host,
							)
							expect(t.probe.ids.get(sw.host)).toBe(r?.receiverId)
							expect(t.probe.headers.get(sw.host)).toBe(true)
							expect(t.probe.calls).toContain(`iq ${sw.host}`)
						}
					}
				},
			),
			{ numRuns: 200 },
		)
	})

	// Feature: receiver-endpoints, Property 3: Bounded switching and anchor fallback
	// Validates: Requirements 3.3, 3.4
	it("keeps upgrades a hold-down apart and never returns to a failed endpoint inside its backoff", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.array(step, { minLength: 1, maxLength: 12 }),
				async steps => {
					const t = setup()
					let clock = 0
					let lastUpgrade = -Infinity
					const failedAt = new Map<string, number>()
					for (const s of steps) {
						t.probe.ids = new Map(Object.entries(s.idAnswers))
						t.probe.headers = new Map(Object.entries(s.headerOk))
						t.sources.connected = s.connected
						if (s.failBack && t.sources.active !== WIFI) {
							failedAt.set(t.sources.active, clock)
							t.failBack()
							expect(t.sources.active).toBe(WIFI)
						}
						t.advance(s.advanceMs)
						clock += s.advanceMs
						const before = t.sources.switches.length
						await t.send(toReport(s))
						const made = t.sources.switches.slice(before)
						expect(made.length).toBeLessThanOrEqual(1)
						for (const sw of made) {
							if (sw.host === WIFI) continue
							expect(clock - lastUpgrade).toBeGreaterThanOrEqual(HOLD)
							lastUpgrade = clock
							const failed = failedAt.get(sw.host)
							if (failed !== undefined)
								expect(clock - failed).toBeGreaterThanOrEqual(
									ENDPOINT_CANDIDATE_BACKOFF_MS,
								)
						}
					}
				},
			),
			{ numRuns: 200 },
		)
	})
})
