import Fastify from "fastify"
import fc from "fast-check"
import { RTL_TUNER_GAIN_TABLES } from "@wavekit/api-types"
import type {
	ReceiverCapabilities,
	ReceiverHeaderEvidence,
	ReceiverSourceDescription,
} from "@wavekit/api-types"
import { afterEach, describe, expect, it } from "vitest"
import { receiverCapabilitiesRoutes } from "../../../src/api/routes/receiver-capabilities.js"
import {
	gainTableCoherent,
	gainTableFor,
	receiverGainTableSchema,
} from "../../../src/core/tuner-capabilities/gain-table.js"
import { createReceiverCapabilitiesProvider } from "../../../src/core/tuner-capabilities/provider.js"
import {
	RECEIVER_CAPABILITIES_LIMITS,
	receiverCapabilitiesSchema,
} from "../../../src/core/tuner-capabilities/types.js"
import type {
	ReceiverEvidenceReader,
	SourceReceiverEvidence,
} from "../../../src/core/tuner-capabilities/types.js"
import { TUNER_REST_COMMAND_POLICY } from "../../../src/core/tuner-controller.js"

const now = Date.UTC(2026, 0, 2)
const token = (value: number) => value.toString(16).padStart(32, "0")
const transports: ReceiverSourceDescription["type"][] = [
	"rtl_tcp",
	"sdrpp-network",
	"recording",
]

function advertised(
	tunerType: number,
	gainCount: number,
): ReceiverHeaderEvidence {
	return {
		state: "advertised",
		provenance: "rtl-peer-header",
		sessionId: token(2),
		observedAt: new Date(now).toISOString(),
		tunerType,
		gainCount,
	}
}

function headerBytes(tunerType: number, gainCount: number): Buffer {
	const bytes = Buffer.alloc(12)
	bytes.set([0x52, 0x54, 0x4c, 0x30])
	bytes.writeUInt32BE(tunerType, 4)
	bytes.writeUInt32BE(gainCount, 8)
	return bytes
}

function evidence(
	options: {
		sourceId?: string
		sessionId?: string | null
		header?: SourceReceiverEvidence["header"]
		source?: ReceiverSourceDescription
		connection?: SourceReceiverEvidence["connection"]
	} = {},
): SourceReceiverEvidence {
	const source = options.source ?? {
		type: "rtl_tcp",
		kind: "iq",
		format: "U8_IQ",
	}
	const connection = options.connection ?? "connected"
	return {
		sourceId: options.sourceId ?? "gt-source",
		sourceStateToken: {},
		sourceIncarnation: token(1),
		sessionId: options.sessionId === undefined ? token(2) : options.sessionId,
		snapshotId: token(3),
		capturedAt: now,
		source,
		caps: { sampleRate: 2048000, centerFreq: 100000000 },
		connection,
		delivery:
			connection === "connected"
				? {
						state: "streaming",
						lastSampleAt: now - 10,
						sampleAgeMs: 10,
						timeoutMs: 10000,
					}
				: {
						state: "disconnected",
						lastSampleAt: null,
						sampleAgeMs: null,
						timeoutMs: 10000,
					},
		header: options.header ?? {
			capture: "complete",
			bytes: headerBytes(5, 29),
			capturedAt: now - 100,
		},
	}
}

function reader(
	candidates: readonly SourceReceiverEvidence[],
): ReceiverEvidenceReader {
	return {
		read: id => {
			const found = candidates.find(c => c.sourceId === id)
			return found ? { kind: "present", evidence: found } : { kind: "missing" }
		},
		readPage: () => ({
			kind: "candidates",
			candidates,
			capturedAt: now,
			snapshotId: candidates.length ? token(3) : null,
		}),
	}
}

function getItem(e: SourceReceiverEvidence): ReceiverCapabilities {
	const result = createReceiverCapabilitiesProvider(
		reader([e]),
		TUNER_REST_COMMAND_POLICY,
	).get(e.sourceId)
	if (!result.ok) throw new Error(`provider failed: ${result.code}`)
	return result.value
}

describe("gainTableFor", () => {
	it("returns every reason in the stated order", () => {
		expect(gainTableFor(advertised(5, 29), "sdrpp-network")).toEqual({
			state: "not-applicable",
			reason: "non-rtl-transport",
		})
		expect(gainTableFor(advertised(5, 29), "recording").state).toBe(
			"not-applicable",
		)
		for (const header of [
			{ state: "unknown", reason: "awaiting-header" },
			{ state: "unknown", reason: "partial-header" },
			{ state: "unknown", reason: "invalid-header" },
			{ state: "unknown", reason: "not-connected" },
			{ state: "unknown", reason: "format-not-captured" },
			{ state: "not-applicable", reason: "non-iq-source" },
		] as const)
			expect(gainTableFor(header, "rtl_tcp")).toEqual({
				state: "unknown",
				reason: "header-not-advertised",
			})
	})

	it("maps each tuner type 0-7 and 0xffffffff", () => {
		const reasonOf = (type: number, count: number) => {
			const table = gainTableFor(advertised(type, count), "rtl_tcp")
			return table.state === "suggested" ? table.tuner : table.reason
		}
		expect(reasonOf(0, 1)).toBe("no-gain-table")
		expect(reasonOf(0, 0)).toBe("no-gain-table")
		expect(reasonOf(4, 1)).toBe("no-gain-table")
		expect(reasonOf(1, 14)).toBe("E4000")
		expect(reasonOf(2, 5)).toBe("FC0012")
		expect(reasonOf(3, 23)).toBe("FC0013")
		expect(reasonOf(5, 29)).toBe("R820T")
		expect(reasonOf(6, 29)).toBe("R828D")
		expect(reasonOf(7, 29)).toBe("unlisted-tuner-type")
		expect(reasonOf(0xffffffff, 0xffffffff)).toBe("unlisted-tuner-type")
	})

	it("rejects gain counts one off the table length", () => {
		for (const [type, entry] of Object.entries(RTL_TUNER_GAIN_TABLES)) {
			if (!entry) continue
			const n = entry.valuesTenthsDb.length
			for (const count of [n - 1, n + 1, 0, 0xffffffff])
				expect(
					gainTableFor(advertised(Number(type), count), "rtl_tcp"),
				).toEqual({ state: "unknown", reason: "gain-count-mismatch" })
		}
	})

	it("returns the frozen array itself, never a copy or a sorted list", () => {
		const table = gainTableFor(advertised(1, 14), "rtl_tcp")
		expect(table.state).toBe("suggested")
		if (table.state !== "suggested") return
		expect(table.valuesTenthsDb).toBe(RTL_TUNER_GAIN_TABLES[1]?.valuesTenthsDb)
		expect(Object.isFrozen(table.valuesTenthsDb)).toBe(true)
	})

	it("ignores inherited keys of the table object", () => {
		for (const type of [-1, 1.5, Number.NaN])
			expect(gainTableFor(advertised(type, 14), "rtl_tcp").state).toBe(
				"unknown",
			)
	})

	// Feature: web-gaps-7, Property 8: Gain table match
	// Validates: Requirements 5.1, 5.2, 5.3
	it("is suggested exactly when advertised, listed and counted", () => {
		const header = fc.oneof(
			fc
				.record({
					type: fc.integer({ min: 0, max: 10 }),
					count: fc.integer({ min: 0, max: 40 }),
				})
				.map(({ type, count }) => advertised(type, count)),
			fc.constantFrom<ReceiverHeaderEvidence>(
				{ state: "unknown", reason: "awaiting-header" },
				{ state: "unknown", reason: "invalid-header" },
				{ state: "not-applicable", reason: "non-iq-source" },
			),
		)
		fc.assert(
			fc.property(header, fc.constantFrom(...transports), (h, transport) => {
				const table = gainTableFor(h, transport)
				const entry =
					h.state === "advertised"
						? RTL_TUNER_GAIN_TABLES[h.tunerType]
						: undefined
				const match =
					transport === "rtl_tcp" &&
					h.state === "advertised" &&
					entry !== undefined &&
					entry.valuesTenthsDb.length === h.gainCount
				expect(table.state === "suggested").toBe(match)
				if (table.state === "suggested") {
					expect(table.tuner).toBe(entry?.tuner)
					expect(table.valuesTenthsDb).toBe(entry?.valuesTenthsDb)
				} else if (transport !== "rtl_tcp")
					expect(table).toEqual({
						state: "not-applicable",
						reason: "non-rtl-transport",
					})
				else if (h.state !== "advertised")
					expect(table).toEqual({
						state: "unknown",
						reason: "header-not-advertised",
					})
				else if (h.tunerType === 0 || h.tunerType === 4)
					expect(table).toEqual({ state: "unknown", reason: "no-gain-table" })
				else if (entry === undefined)
					expect(table).toEqual({
						state: "unknown",
						reason: "unlisted-tuner-type",
					})
				else
					expect(table).toEqual({
						state: "unknown",
						reason: "gain-count-mismatch",
					})
				expect(receiverGainTableSchema.safeParse(table).success).toBe(true)
			}),
			{ numRuns: 300 },
		)
	})
})

describe("gain table schema and coherence", () => {
	const r820t = RTL_TUNER_GAIN_TABLES[5]?.valuesTenthsDb ?? []
	it("accepts only the named tuner's exact table", () => {
		const base = {
			state: "suggested",
			provenance: "librtlsdr-tuner-gains",
		}
		expect(
			receiverGainTableSchema.safeParse({
				...base,
				tuner: "R820T",
				valuesTenthsDb: [...r820t],
			}).success,
		).toBe(true)
		for (const bad of [
			{ ...base, tuner: "E4000", valuesTenthsDb: [...r820t] },
			{ ...base, tuner: "R820T", valuesTenthsDb: r820t.slice(1) },
			{ ...base, tuner: "R820T", valuesTenthsDb: [...r820t].reverse() },
			{ ...base, tuner: "R820T", valuesTenthsDb: [...r820t, 500] },
			{ ...base, tuner: "FC2580", valuesTenthsDb: [0] },
			{ ...base, tuner: "unknown", valuesTenthsDb: [] },
			{ ...base, tuner: "R820T", valuesTenthsDb: [...r820t], extra: 1 },
			{
				...base,
				provenance: "device",
				tuner: "R820T",
				valuesTenthsDb: [...r820t],
			},
			{ state: "unknown", reason: "stale" },
			{ state: "not-applicable", reason: "header-not-advertised" },
			null,
			"suggested",
		])
			expect(receiverGainTableSchema.safeParse(bad).success).toBe(false)
	})

	it("rejects a table that disagrees with the item's own header", () => {
		const item = getItem(evidence())
		expect(gainTableCoherent(item)).toBe(true)
		const rtl = { type: "rtl_tcp", kind: "iq", format: "U8_IQ" } as const
		const sdrpp = {
			type: "sdrpp-network",
			kind: "iq",
			format: "S16_IQ",
		} as const
		const suggested = gainTableFor(advertised(5, 29), "rtl_tcp")
		const cases: Pick<
			ReceiverCapabilities,
			"source" | "peerHeader" | "gainTable"
		>[] = [
			{ source: rtl, peerHeader: advertised(1, 14), gainTable: suggested },
			{ source: rtl, peerHeader: advertised(5, 28), gainTable: suggested },
			{
				source: rtl,
				peerHeader: { state: "unknown", reason: "awaiting-header" },
				gainTable: suggested,
			},
			{
				source: sdrpp,
				peerHeader: { state: "not-applicable", reason: "non-rtl-transport" },
				gainTable: suggested,
			},
			{
				source: rtl,
				peerHeader: advertised(5, 29),
				gainTable: { state: "unknown", reason: "gain-count-mismatch" },
			},
			{
				source: rtl,
				peerHeader: advertised(7, 29),
				gainTable: { state: "unknown", reason: "no-gain-table" },
			},
			{
				source: rtl,
				peerHeader: advertised(5, 29),
				gainTable: {
					state: "suggested",
					provenance: "librtlsdr-tuner-gains",
					tuner: "R828D",
					valuesTenthsDb: r820t,
				},
			},
		]
		for (const c of cases) expect(gainTableCoherent(c)).toBe(false)
		const { gainTable: _omit, ...missing } = item
		expect(gainTableCoherent(missing)).toBe(false)
	})

	it("the item schema requires gainTable", () => {
		const { gainTable: _omit, ...missing } = getItem(evidence())
		expect(receiverCapabilitiesSchema.safeParse(missing).success).toBe(false)
	})
})

describe("provider gain table", () => {
	it("suggests the table only for the current advertised session", () => {
		expect(getItem(evidence()).gainTable).toEqual({
			state: "suggested",
			provenance: "librtlsdr-tuner-gains",
			tuner: "R820T",
			valuesTenthsDb: [...(RTL_TUNER_GAIN_TABLES[5]?.valuesTenthsDb ?? [])],
		})
	})

	it("a reconnect without a header drops the previous session's table", () => {
		const items = [
			evidence(),
			evidence({
				sessionId: token(9),
				header: { capture: "missing", bytes: null, capturedAt: null },
			}),
			evidence({
				sessionId: token(9),
				header: { capture: "partial", bytes: null, capturedAt: null },
			}),
			evidence({
				connection: "disconnected",
				sessionId: null,
				header: { capture: "missing", bytes: null, capturedAt: null },
			}),
		].map(getItem)
		expect(items[0]?.gainTable?.state).toBe("suggested")
		for (const item of items.slice(1))
			expect(item.gainTable).toEqual({
				state: "unknown",
				reason: "header-not-advertised",
			})
		// Same provider, sequential snapshots: no cache across sessions.
		let current = evidence()
		const provider = createReceiverCapabilitiesProvider(
			{
				read: () => ({ kind: "present", evidence: current }),
				readPage: () => ({ kind: "unavailable" }),
			},
			TUNER_REST_COMMAND_POLICY,
		)
		const first = provider.get("gt-source")
		current = evidence({
			sessionId: token(9),
			header: { capture: "missing", bytes: null, capturedAt: null },
		})
		const second = provider.get("gt-source")
		expect(first.ok && first.value.gainTable?.state).toBe("suggested")
		expect(second.ok && second.value.gainTable?.state).toBe("unknown")
	})

	it("a new session advertising another tuner gets that tuner's table", () => {
		const item = getItem(
			evidence({
				sessionId: token(9),
				header: {
					capture: "complete",
					bytes: headerBytes(1, 14),
					capturedAt: now - 1,
				},
			}),
		)
		expect(item.gainTable?.state === "suggested" && item.gainTable.tuner).toBe(
			"E4000",
		)
	})

	it("non-rtl transports and non-captured formats", () => {
		const sdrpp = getItem(
			evidence({
				source: { type: "sdrpp-network", kind: "iq", format: "S16_IQ" },
				header: { capture: "not-applicable", bytes: null, capturedAt: null },
			}),
		)
		expect(sdrpp.gainTable).toEqual({
			state: "not-applicable",
			reason: "non-rtl-transport",
		})
		const recording = getItem(
			evidence({
				source: { type: "recording", kind: "recording", format: "auto" },
				connection: "disconnected",
				sessionId: null,
				header: { capture: "not-applicable", bytes: null, capturedAt: null },
			}),
		)
		expect(recording.gainTable).toEqual({
			state: "not-applicable",
			reason: "non-rtl-transport",
		})
	})

	it("count mismatch and unlisted types through the provider", () => {
		const mismatch = getItem(
			evidence({
				header: {
					capture: "complete",
					bytes: headerBytes(5, 30),
					capturedAt: now - 1,
				},
			}),
		)
		expect(mismatch.gainTable).toEqual({
			state: "unknown",
			reason: "gain-count-mismatch",
		})
		const unlisted = getItem(
			evidence({
				header: {
					capture: "complete",
					bytes: headerBytes(0xffffffff, 29),
					capturedAt: now - 1,
				},
			}),
		)
		expect(unlisted.gainTable).toEqual({
			state: "unknown",
			reason: "unlisted-tuner-type",
		})
	})

	it("item and page byte bounds hold at the largest table with 16 items", () => {
		const longId = (i: number) =>
			`${String(i).padStart(2, "0")}${"x".repeat(98)}`
		const candidates = Array.from({ length: 17 }, (_, i) =>
			evidence({ sourceId: longId(i) }),
		)
		const provider = createReceiverCapabilitiesProvider(
			reader(candidates),
			TUNER_REST_COMMAND_POLICY,
		)
		const page = provider.list({ after: null, limit: 16 })
		expect(page.ok).toBe(true)
		if (!page.ok) return
		expect(page.value.items).toHaveLength(16)
		for (const item of page.value.items) {
			expect(item.gainTable?.state).toBe("suggested")
			const bytes = Buffer.byteLength(JSON.stringify(item))
			expect(bytes).toBeLessThan(RECEIVER_CAPABILITIES_LIMITS.itemBytes)
		}
		const pageBytes = Buffer.byteLength(JSON.stringify(page.value))
		expect(pageBytes).toBeLessThan(RECEIVER_CAPABILITIES_LIMITS.pageBytes)
		const item = page.value.items[0]
		if (!item) return
		const { gainTable: _omit, ...without } = item
		const growth =
			Buffer.byteLength(JSON.stringify(item)) -
			Buffer.byteLength(JSON.stringify(without))
		expect(growth).toBe(213)
		expect(growth).toBeLessThanOrEqual(260)
	})
})

describe("route serialises gainTable", () => {
	const apps: ReturnType<typeof Fastify>[] = []
	afterEach(async () => {
		for (const app of apps.splice(0)) await app.close()
	})
	it("sends the suggested table and each unknown reason", async () => {
		for (const [e, expected] of [
			[evidence(), "suggested"],
			[
				evidence({
					header: {
						capture: "complete",
						bytes: headerBytes(5, 28),
						capturedAt: now - 1,
					},
				}),
				"gain-count-mismatch",
			],
			[
				evidence({
					header: {
						capture: "complete",
						bytes: headerBytes(4, 1),
						capturedAt: now - 1,
					},
				}),
				"no-gain-table",
			],
			[
				evidence({
					header: {
						capture: "complete",
						bytes: headerBytes(9, 1),
						capturedAt: now - 1,
					},
				}),
				"unlisted-tuner-type",
			],
		] as const) {
			const app = Fastify()
			apps.push(app)
			await app.register(receiverCapabilitiesRoutes, {
				provider: createReceiverCapabilitiesProvider(
					reader([e]),
					TUNER_REST_COMMAND_POLICY,
				),
			})
			const one = await app.inject({
				url: `/api/receiver-capabilities/${e.sourceId}`,
			})
			const list = await app.inject({ url: "/api/receiver-capabilities" })
			for (const response of [one, list])
				expect(response.statusCode, response.body).toBe(200)
			const item = one.json<ReceiverCapabilities>()
			const table = item.gainTable
			expect(
				table?.state === "suggested"
					? "suggested"
					: table?.state === "unknown"
						? table.reason
						: "?",
			).toBe(expected)
			if (table?.state === "suggested")
				expect(table.valuesTenthsDb).toEqual([
					...(RTL_TUNER_GAIN_TABLES[5]?.valuesTenthsDb ?? []),
				])
			expect(
				list.json<{ items: ReceiverCapabilities[] }>().items[0]?.gainTable,
			).toEqual(table)
		}
	})
})

describe("gain table versus the gain command's validated range", () => {
	it("counts, without filtering, the table values outside the gain rule", () => {
		const rule = TUNER_REST_COMMAND_POLICY.find(row => row.id === "gain")?.rule
		expect(rule).toEqual({ kind: "integer-range", min: 0, max: 500 })
		if (rule?.kind !== "integer-range") return
		const outside: Record<string, number> = {}
		for (const entry of Object.values(RTL_TUNER_GAIN_TABLES)) {
			if (!entry) continue
			outside[entry.tuner] = entry.valuesTenthsDb.filter(
				v => v < rule.min || v > rule.max,
			).length
		}
		expect(outside).toEqual({
			E4000: 1,
			FC0012: 2,
			FC0013: 7,
			R820T: 0,
			R828D: 0,
		})
		const table = gainTableFor(advertised(3, 23), "rtl_tcp")
		expect(table.state === "suggested" && table.valuesTenthsDb.length).toBe(23)
	})
})

describe("route refuses a hostile provider's gain table", () => {
	const apps: ReturnType<typeof Fastify>[] = []
	afterEach(async () => {
		for (const app of apps.splice(0)) await app.close()
	})
	it("maps a table that disagrees with the header to CONFLICT", async () => {
		const good = getItem(evidence())
		const r820t = [...(RTL_TUNER_GAIN_TABLES[5]?.valuesTenthsDb ?? [])]
		for (const gainTable of [
			{ state: "unknown", reason: "header-not-advertised" },
			{
				state: "suggested",
				provenance: "librtlsdr-tuner-gains",
				tuner: "R828D",
				valuesTenthsDb: r820t,
			},
			{
				state: "suggested",
				provenance: "librtlsdr-tuner-gains",
				tuner: "R820T",
				valuesTenthsDb: [...r820t, 500, 500, 500],
			},
			undefined,
		]) {
			const value = JSON.parse(JSON.stringify(good)) as Record<string, unknown>
			if (gainTable === undefined) delete value["gainTable"]
			else value["gainTable"] = gainTable
			const app = Fastify()
			apps.push(app)
			await app.register(receiverCapabilitiesRoutes, {
				provider: {
					get: () => ({
						ok: true,
						value: value as unknown as ReceiverCapabilities,
					}),
					list: () => ({ ok: false, code: "UNAVAILABLE" }),
					dispose: () => undefined,
				},
			})
			const response = await app.inject({
				url: `/api/receiver-capabilities/${good.sourceId}`,
			})
			expect(response.statusCode).toBe(503)
			expect(response.json<{ code: string }>().code).toBe(
				"RECEIVER_CAPABILITIES_CONFLICT",
			)
			expect(response.body).not.toContain("R828D")
		}
	})
})
