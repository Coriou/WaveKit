import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type {
	DecoderEfficiencyDetail,
	DecoderInfo,
	DecoderSuspensionReasonCode,
	DecoderSummary,
	DecoderVerdict,
} from "@wavekit/api-types"
import { decoderVerdictSchema } from "@wavekit/api-types"

import {
	mockCoversHz,
	mockDecoderName,
	mockVerdict,
} from "../../mock/decoder-summary.ts"
import { buildMockServer } from "../../mock/server.ts"
import type { MockServer } from "../../mock/server.ts"

/**
 * The core's decoderVerdict (src/api/routes/decoder-summary.ts), loaded at run time: the route module
 * does not typecheck under the web's tsconfig (its Fastify schema augmentation lives in the core).
 */
type CoreVerdict = (
	status: unknown,
	health: DecoderSummary["health"],
	running: boolean,
) => DecoderVerdict
const CORE_SUMMARY = new URL(
	"../../../src/api/routes/decoder-summary.ts",
	import.meta.url,
).href
const coreVerdict = async (): Promise<CoreVerdict> =>
	(
		(await import(/* @vite-ignore */ CORE_SUMMARY)) as {
			decoderVerdict: CoreVerdict
		}
	).decoderVerdict
const coreSummary = async () =>
	(await import(/* @vite-ignore */ CORE_SUMMARY)) as {
		decoderCoversHz: (status: unknown, hz: number) => boolean
		decoderName: (type: string) => string
	}

/** Every suspension reason the core knows, plus one it does not. */
const REASONS: readonly (string | undefined)[] = [
	undefined,
	"insufficient-sample-rate",
	"unsupported-sample-rate",
	"unsupported-input-kind",
	"unsupported-input-format",
	"unsupported-frontend-rate",
	"unsupported-decoder-input-rate",
	"unknown-requirements",
	"source-rate-unknown",
	"adaptation-unknown",
	"external-input",
	"frequency-out-of-band",
	"capture-too-narrow",
	"no-channel-selected",
	"tuner-scanning",
	"efficiency-budget",
	"decoder-unavailable",
	"channelizer-unavailable",
	"from-a-newer-core",
] satisfies readonly (DecoderSuspensionReasonCode | string | undefined)[]
const DETAILS: readonly (string | undefined)[] = [
	undefined,
	"budget",
	"cpu",
	"drops",
	"late-drops",
	"unknown",
	"from-a-newer-core",
] satisfies readonly (DecoderEfficiencyDetail | string | undefined)[]
const HEALTHS: readonly DecoderSummary["health"][] = [
	"failed",
	"suspended",
	"decoding",
	"idle",
]

/** The fields the verdicts read, set on both the mock's DecoderInfo and the core's DecoderStatus. */
interface Case {
	health: DecoderSummary["health"]
	mode?: "auto" | "off" | "on"
	desiredRunning?: boolean
	running: boolean
	reason?: string
	detail?: string
	/** The detail on a placement instead of the decoder. */
	onPlacement?: boolean
}

function cases(): Case[] {
	const out: Case[] = []
	for (const health of HEALTHS)
		for (const mode of [undefined, "auto", "off"] as const)
			for (const desiredRunning of [undefined, true, false])
				for (const running of [true, false]) {
					const base: Case = {
						health,
						running,
						...(mode ? { mode } : {}),
						...(desiredRunning === undefined ? {} : { desiredRunning }),
					}
					if (health !== "suspended") {
						out.push(base)
						continue
					}
					for (const reason of REASONS)
						for (const detail of DETAILS)
							for (const onPlacement of detail ? [false, true] : [false])
								out.push({
									...base,
									...(reason ? { reason } : {}),
									...(detail ? { detail, onPlacement } : {}),
								})
				}
	return out
}

function fields(c: Case) {
	return {
		id: "d",
		type: "readsb",
		running: c.running,
		health: "running" as const,
		uptime: 0,
		stats: { bytesIn: 0, eventsOut: 0, errors: 0 },
		restartCount: 0,
		...(c.mode ? { mode: c.mode } : {}),
		...(c.desiredRunning === undefined
			? {}
			: { desiredRunning: c.desiredRunning }),
		...(c.reason
			? { suspension: { reasonCode: c.reason, since: "2026-10-30T00:00:00Z" } }
			: {}),
		...(c.detail && !c.onPlacement ? { efficiency: { detail: c.detail } } : {}),
		...(c.detail && c.onPlacement
			? {
					placements: [
						{ sourceId: "rtl-0", running: false, efficiencyDetail: c.detail },
					],
				}
			: {}),
	}
}

describe("mock verdicts match the core's", () => {
	it("gives the core's verdict for every reason, efficiency detail and precedence case", async () => {
		const decoderVerdict = await coreVerdict()
		const all = cases()
		expect(all.length).toBeGreaterThan(500)
		for (const c of all) {
			const f = fields(c)
			const core = decoderVerdict(f, c.health, c.running)
			// reasons and details the types do not know are part of the table
			const mock = mockVerdict(f as unknown as DecoderInfo, c.health)
			expect({ c, verdict: mock }).toEqual({ c, verdict: core })
		}
	})
})

describe("mock failures, names and coverage match the core's", () => {
	it("drops the restart while the decoder restarts on its own, as the core does", async () => {
		const decoderVerdict = await coreVerdict()
		const retry = [
			{ health: "restarting" as const, running: false },
			{ health: "faulted" as const, running: true },
			{
				health: "faulted" as const,
				running: false,
				nextRestartAt: "2026-10-31T10:00:05Z",
			},
			{ health: "faulted" as const, running: false },
		]
		for (const r of retry) {
			const f = { ...fields({ health: "failed", running: r.running }), ...r }
			const core = decoderVerdict(
				{
					...f,
					...(r.nextRestartAt
						? { nextRestartAt: new Date(r.nextRestartAt) }
						: {}),
				},
				"failed",
				r.running,
			)
			expect({ r, verdict: mockVerdict(f as DecoderInfo, "failed") }).toEqual({
				r,
				verdict: core,
			})
		}
	})

	it("names every decoder type as the core does", async () => {
		const { decoderName } = await coreSummary()
		for (const type of [
			"readsb",
			"ais-catcher",
			"acarsdec",
			"dumpvdl2",
			"rtl433",
			"direwolf",
			"multimon-ng",
			"dsd-fme",
			"lora-meshtastic",
			"something-new",
		])
			expect(mockDecoderName(type)).toBe(decoderName(type))
	})

	it("covers a frequency exactly where the core's band rule does", async () => {
		const { decoderCoversHz } = await coreSummary()
		const bands = [
			{ targetsHz: [1_090_000_000] },
			{ targetsHz: [466_000_000, 466_025_000] },
			{ rangesHz: [{ minHz: 460_000_000, maxHz: 470_000_000 }] },
			{ targetsHz: [1_090_000_000], owner: "scanner" as const },
		]
		const probes = [
			1_090_000_000,
			1_090_200_000,
			1_090_200_001,
			465_800_000,
			465_799_999,
			466_012_500,
			470_200_000,
			470_200_001,
			0,
			-1,
			Number.NaN,
		]
		for (const b of bands)
			for (const hz of probes) {
				const d = {
					...(b.owner ? { owner: b.owner } : {}),
					bandAssessment: { verdict: "in-band" as const, ...b },
				}
				expect({ b, hz, covers: mockCoversHz(d, hz) }).toEqual({
					b,
					hz,
					covers: decoderCoversHz({ type: "readsb", ...d }, hz),
				})
			}
	})
})

describe("mock GET /api/decoders/summary", () => {
	let server: MockServer
	beforeAll(async () => {
		server = await buildMockServer({
			port: 0,
			audioOrigin: "http://localhost:3102",
		})
		await server.app.ready()
	})
	afterAll(async () => {
		await server.close()
	})
	const summary = async () =>
		(
			await server.app.inject({ method: "GET", url: "/api/decoders/summary" })
		).json<DecoderSummary[]>()
	const byId = async (id: string) => (await summary()).find(s => s.id === id)

	it("adds coversHz for ?hz= and refuses a bad one, as the core does", async () => {
		const at = await server.app.inject({
			method: "GET",
			url: "/api/decoders/summary?hz=1090062000",
		})
		expect(at.statusCode).toBe(200)
		const items = at.json<DecoderSummary[]>()
		expect(items.find(i => i.id === "readsb")?.coversHz).toBe(true)
		expect(items.find(i => i.id === "multimon-ng")?.coversHz).toBe(false)
		expect(items.every(i => typeof i.name === "string")).toBe(true)
		for (const bad of ["0", "abc", "Infinity", "100000000001"]) {
			const res = await server.app.inject({
				method: "GET",
				url: `/api/decoders/summary?hz=${bad}`,
			})
			expect(res.statusCode, bad).toBe(400)
		}
		expect((await summary()).every(i => !Object.hasOwn(i, "coversHz"))).toBe(
			true,
		)
	})

	it("gives every decoder a valid verdict", async () => {
		const items = await summary()
		expect(items.length).toBeGreaterThan(0)
		for (const item of items)
			expect(decoderVerdictSchema.safeParse(item.verdict).success).toBe(true)
		expect((await byId("rtl433-433"))?.verdict).toMatchObject({
			code: "out-of-band",
			actions: ["tune-to-band"],
		})
	})

	it("pauses ADS-B for CPU budget near 1090 MHz until the budget is raised", async () => {
		const tuned = await server.app.inject({
			method: "POST",
			url: "/api/tuner/rtl-0/frequency",
			payload: { hz: 1_090_000_000 },
		})
		expect(tuned.statusCode).toBe(200)
		expect((await byId("readsb"))?.verdict).toEqual({
			code: "efficiency-budget",
			text: "ADS-B paused: CPU budget full",
			actions: ["raise-budget", "turn-off-others", "pause-scanner"],
		})
		const raised = await server.app.inject({
			method: "PUT",
			url: "/api/decoders/efficiency/budget",
			payload: { cpuBudgetCores: 5 },
		})
		expect(raised.statusCode).toBe(200)
		expect((await byId("readsb"))?.verdict.code).toMatch(/decoding|listening/)
	})
})
