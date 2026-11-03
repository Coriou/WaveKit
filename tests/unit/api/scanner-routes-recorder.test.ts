// The analog recorder's decisions on discovery detail reads (`recorder`) and in the scanner status.
import Fastify, { type FastifyInstance } from "fastify"
import { afterEach, describe, expect, it, vi } from "vitest"
import type {
	ScannerRecorderDiscovery,
	ScannerRecorderStatus,
} from "@wavekit/api-types"
import {
	scannerRoutes,
	type ScannerRouteService,
} from "../../../src/api/routes/scanner.js"
import type { Discovery } from "../../../src/core/scanner/types.js"

const AT = new Date(Date.UTC(2026, 10, 3, 4, 30, 0)).toISOString()

const discovery = {
	id: "d_a",
	frequencyHz: 145_000_000,
	sourceIds: ["rtl"],
	signal: { best: { snrDb: 20 }, last: { snrDb: 10 } },
	coChannel: [],
} as unknown as Discovery

const decisions: ScannerRecorderDiscovery = {
	last: {
		code: "finalized",
		at: AT,
		sourceId: "rtl",
		observationId: "o_1",
		discoveryId: "d_a",
	},
	counts: { started: 1, voiced: 1, finalized: 1, "refused:cpu": 2 },
}

const status: ScannerRecorderStatus = {
	sessions: [
		{
			sourceId: "rtl",
			observationId: "o_2",
			discoveryId: null,
			state: "shadow",
			writing: false,
			backlogMs: 120,
		},
	],
	parked: 0,
	recent: [decisions.last],
	counts: decisions.counts,
	logsSuppressed: 0,
}

describe("scanner routes: recorder decisions", () => {
	let app: FastifyInstance | undefined

	afterEach(async () => {
		await app?.close()
		app = undefined
	})

	async function build(
		recorder: (id: string) => ScannerRecorderDiscovery | null,
	) {
		const service = {
			listDiscoveries: vi.fn(() => ({ items: [discovery], nextCursor: null })),
			getDiscovery: vi.fn((id: string) =>
				id === discovery.id ? discovery : undefined,
			),
			discoveryRecorder: vi.fn(recorder),
			status: vi.fn(() => ({ enabled: true, recorder: status })),
		}
		app = Fastify({ logger: false })
		await app.register(scannerRoutes, {
			scanner: service as unknown as ScannerRouteService,
		})
		return { app, service }
	}

	it("a detail read carries every field of the discovery's recorder decisions", async () => {
		const { app } = await build(id => (id === "d_a" ? decisions : null))
		const res = await app.inject({ url: "/api/scanner/discoveries/d_a" })
		expect(res.statusCode).toBe(200)
		expect(res.json().recorder).toEqual(decisions)
	})

	it("nothing decided omits the field; the list never carries it", async () => {
		const { app } = await build(() => null)
		const one = await app.inject({ url: "/api/scanner/discoveries/d_a" })
		expect(one.json()).not.toHaveProperty("recorder")
		const list = await app.inject({ url: "/api/scanner/discoveries" })
		expect(list.json().items[0]).not.toHaveProperty("recorder")
	})

	it("the scanner status carries the recorder block unchanged", async () => {
		const { app } = await build(() => null)
		const res = await app.inject({ url: "/api/scanner" })
		expect(res.statusCode).toBe(200)
		expect(res.json().recorder).toEqual(status)
	})
})
