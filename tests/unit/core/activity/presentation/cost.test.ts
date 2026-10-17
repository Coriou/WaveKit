import pino from "pino"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createActivityIngress } from "../../../../../src/core/activity/ingress.js"
import { createDecodeEnvelope } from "../../../../../src/core/activity/envelope.js"
import { presentDecoderOutputResult } from "../../../../../src/core/activity/presentation/registry.js"
import { ActivityIngress } from "../../../../../src/core/activity/storage/ingress.js"
import { ACTIVITY_LIMIT_DEFAULTS } from "../../../../../src/core/activity/storage/limits.js"
import { buildActivityRow } from "../../../../../src/core/activity/storage/row.js"
import type { DecoderOutput } from "../../../../../src/decoders/types.js"
import type * as EnvelopeModule from "../../../../../src/core/activity/envelope.js"
import type * as RegistryModule from "../../../../../src/core/activity/presentation/registry.js"
import type * as RowModule from "../../../../../src/core/activity/storage/row.js"
import { decoderOutput } from "./measure.js"

vi.mock(
	"../../../../../src/core/activity/storage/row.js",
	async importOriginal => {
		const actual = await importOriginal<typeof RowModule>()
		return { ...actual, buildActivityRow: vi.fn(actual.buildActivityRow) }
	},
)
vi.mock(
	"../../../../../src/core/activity/envelope.js",
	async importOriginal => {
		const actual = await importOriginal<typeof EnvelopeModule>()
		return {
			...actual,
			createDecodeEnvelope: vi.fn(actual.createDecodeEnvelope),
			withPresentation: vi.fn(actual.withPresentation),
		}
	},
)
vi.mock(
	"../../../../../src/core/activity/presentation/registry.js",
	async importOriginal => {
		const actual = await importOriginal<typeof RegistryModule>()
		return {
			...actual,
			presentDecoderOutputResult: vi.fn(actual.presentDecoderOutputResult),
		}
	},
)

const rows = vi.mocked(buildActivityRow)
const creates = vi.mocked(createDecodeEnvelope)
const presents = vi.mocked(presentDecoderOutputResult)

function pipeline(windowMs = 60_000) {
	let clock = Date.parse("2026-10-13T00:00:00.000Z")
	const store = new ActivityIngress(
		{ ...ACTIVITY_LIMIT_DEFAULTS, positionCoalesceMs: windowMs },
		() => clock,
		pino({ level: "silent" }),
	)
	let id = 0
	const ingress = createActivityIngress({
		sink: (envelope, present) => {
			store.admit(envelope, present)
		},
		logger: pino({ level: "silent" }),
		now: () => new Date(clock),
		randomUUID: () => `evt-${++id}`,
	})
	return {
		store,
		publish(output: DecoderOutput) {
			ingress.publish(output.decoder, "readsb", output)
		},
		advance(ms: number) {
			clock += ms
		},
		counters: () => ingress.counters(),
	}
}

function calls() {
	return {
		creates: creates.mock.calls.length,
		rows: rows.mock.calls.length,
		presents: presents.mock.calls.length,
	}
}

const beast = (icao: string) =>
	decoderOutput("aircraft", { icao, signal: -12.5, messageCount: 4 }, "beast")
const sbsPosition = (icao: string) =>
	decoderOutput(
		"aircraft",
		{
			icao,
			altitude: 35_000,
			lat: 51.477500915527344,
			lon: -0.46138763427734375,
			lastSeen: "2026-10-13T00:00:00.000Z",
			messageCount: 12,
		},
		"sbs",
	)
const aprsPosition = () =>
	decoderOutput(
		"aprs",
		{
			source: "N0CALL-9",
			destination: "APRS",
			path: ["WIDE1-1"],
			dataType: "Position",
			lat: 51.50833333333333,
			lon: -0.12583333333333332,
			course: 90,
			speed: 12,
		},
		"direwolf",
	)

beforeEach(() => {
	rows.mockClear()
	creates.mockClear()
	presents.mockClear()
})

describe("activity presentation cost on the common path (WG2 req 1, R1 A)", () => {
	it.each([
		["Beast aircraft", beast("4ca1d3")],
		["SBS position (float32 coordinates)", sbsPosition("4ca1d3")],
		["APRS position", aprsPosition()],
	])(
		"a stored %s builds one envelope and one row, and a coalesced repeat is never presented",
		(_name, output) => {
			const run = pipeline()
			run.publish(output)
			expect(run.store.admitted).toBe(1)
			expect(calls()).toEqual({ creates: 1, rows: 1, presents: 1 })
			const row = rows.mock.results[0]?.value as
				| { entityKey: string | null }
				| undefined
			expect(row?.entityKey).not.toBeNull()

			run.advance(1_000)
			run.publish(output)
			expect(run.store.coalescedPositions).toBe(1)
			// The drop paid for the plain envelope only, as before WG2.
			expect(calls()).toEqual({ creates: 2, rows: 1, presents: 1 })
			expect(run.counters().presentationFailures).toBe(0)
		},
	)

	it("does not present a reception the rate limiter drops", () => {
		const run = pipeline(0)
		const store = run.store as unknown as { takeTokens: () => boolean }
		const spy = vi.spyOn(store, "takeTokens").mockReturnValue(false)
		run.publish(beast("abcdef"))
		expect(run.store.admitted).toBe(0)
		expect(calls()).toEqual({ creates: 1, rows: 0, presents: 0 })
		spy.mockRestore()
	})

	it("fits an SBS position by arithmetic: no extra envelope or row is built", () => {
		const output = sbsPosition("4ca1d3")
		const result = presentDecoderOutputResult(output, "sbs")
		// Fits the 240-byte coalesced bound (WG5 req 4.7) unrounded.
		expect(result.presentation?.position).toBeDefined()
		expect(result.presentation?.position?.lat).toBe(51.477500915527344)
		expect(result.presentation?.position?.altM).toBe(10_668)
		expect(rows).not.toHaveBeenCalled()
		expect(creates).not.toHaveBeenCalled()
	})
})
