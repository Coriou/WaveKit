// Band inspection UX req 1.4 and 3.1: coverage and absorbed-id reads on the discovery routes.
import Fastify, { type FastifyInstance } from "fastify"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	DISCOVERY_EPOCH_HEADER,
	DISCOVERY_REVISION_HEADER,
	scannerRoutes,
	type ScannerRouteService,
} from "../../../src/api/routes/scanner.js"
import { buildCoverageIndex } from "../../../src/core/scanner/discovery-coverage.js"
import type { Discovery } from "../../../src/core/scanner/types.js"

const F = 433_920_000

const survivor = {
	id: "d_a",
	frequencyHz: F,
	sourceIds: ["rtl"],
	signal: { best: { snrDb: 20 }, last: { snrDb: 10 } },
	operator: { label: "gate" },
	coChannel: [],
} as unknown as Discovery

function fake(statuses: unknown) {
	const live = new Map([[survivor.id, survivor]])
	const absorbed = new Map([["d_b", "d_a"]])
	return {
		listDiscoveries: vi.fn(() => ({ items: [survivor], nextCursor: null })),
		getDiscovery: vi.fn((id: string) => live.get(id)),
		resolveDiscovery: vi.fn((id: string) => {
			const d = live.get(id)
			if (d) return d
			const s = absorbed.get(id)
			const r = s === undefined ? undefined : live.get(s)
			return r ? { ...r, absorbedInto: s, requestedId: id } : undefined
		}),
		discoveryCoverage: vi.fn(() => buildCoverageIndex(statuses)),
		discoveryObservations: vi.fn(() => ({ items: [], nextCursor: null })),
		evidencePath: vi.fn(() => Promise.resolve(null)),
	}
}

describe("discovery routes: coverage and absorbed ids", () => {
	let app: FastifyInstance
	let service: ReturnType<typeof fake>

	async function build(statuses: unknown) {
		service = fake(statuses)
		app = Fastify({ logger: false })
		await app.register(scannerRoutes, {
			scanner: service as unknown as ScannerRouteService,
		})
	}

	afterEach(async () => {
		await app.close()
	})

	const running = [
		{
			id: "pocsag",
			placements: [
				{ sourceId: "rtl", reach: "channel", channelHz: F, running: true },
			],
		},
	]

	it("GET of an absorbed id answers 200 with the survivor, absorbedInto and requestedId", async () => {
		await build(running)
		const res = await app.inject({ url: "/api/scanner/discoveries/d_b" })
		expect(res.statusCode).toBe(200)
		expect(res.json()).toEqual({
			...survivor,
			absorbedInto: "d_a",
			requestedId: "d_b",
			coverage: [{ decoderId: "pocsag", state: "running" }],
		})
	})

	it("GET of a live id has no alias fields; unknown ids are 404", async () => {
		await build(running)
		const ok = await app.inject({ url: "/api/scanner/discoveries/d_a" })
		expect(ok.statusCode).toBe(200)
		expect(ok.json()).not.toHaveProperty("absorbedInto")
		expect(ok.json()).not.toHaveProperty("requestedId")
		const missing = await app.inject({ url: "/api/scanner/discoveries/d_gone" })
		expect(missing.statusCode).toBe(404)
	})

	it("observations and evidence resolve an absorbed id to the survivor", async () => {
		await build(running)
		await app.inject({ url: "/api/scanner/discoveries/d_b/observations" })
		expect(service.discoveryObservations).toHaveBeenCalledWith("d_a", null, 100)
		await app.inject({ url: "/api/scanner/discoveries/d_b/evidence/psd" })
		expect(service.evidencePath).toHaveBeenCalledWith("d_a", "psd")
	})

	it("the list carries coverage; every other field passes through the schema", async () => {
		await build(running)
		const res = await app.inject({ url: "/api/scanner/discoveries" })
		expect(res.statusCode).toBe(200)
		expect(res.json()).toEqual({
			items: [
				{ ...survivor, coverage: [{ decoderId: "pocsag", state: "running" }] },
			],
			nextCursor: null,
		})
	})

	it("coverage follows the placement's reported channel width at its edges", async () => {
		const at = (channelHz: number) => [
			{
				id: "nfm",
				placements: [
					{
						sourceId: "rtl",
						reach: "channel",
						channelHz,
						channelWidthHz: 8_000,
						running: true,
					},
				],
			},
		]
		await build(at(F - 4_000))
		const edge = await app.inject({ url: "/api/scanner/discoveries/d_a" })
		expect(edge.json().coverage).toEqual([
			{ decoderId: "nfm", state: "running" },
		])
		await app.close()
		await build(at(F + 4_001))
		const past = await app.inject({ url: "/api/scanner/discoveries/d_a" })
		expect(past.json().coverage).toEqual([])
	})

	it("revision, epoch and store revision pass the list and detail schemas; DELETE sends them as headers", async () => {
		await build(running)
		const meta = { storeEpoch: "e1", storeRevision: 9 }
		const rev = { ...survivor, revision: 7 }
		service.listDiscoveries.mockReturnValue({
			items: [rev],
			nextCursor: null,
			...meta,
		} as never)
		service.resolveDiscovery.mockReturnValue({ ...rev, ...meta } as never)
		const list = await app.inject({ url: "/api/scanner/discoveries" })
		expect(list.json()).toMatchObject({ ...meta, items: [{ revision: 7 }] })
		const one = await app.inject({ url: "/api/scanner/discoveries/d_a" })
		expect(one.json()).toMatchObject({ revision: 7, ...meta })
		await app.close()
		app = Fastify({ logger: false })
		await app.register(scannerRoutes, {
			scanner: {
				...service,
				deleteDiscovery: vi.fn(() => Promise.resolve(true)),
				storeMeta: () => meta,
			} as unknown as ScannerRouteService,
		})
		const del = await app.inject({
			method: "DELETE",
			url: "/api/scanner/discoveries/d_0123456789abcdefghjkmnpqrs",
		})
		expect(del.statusCode).toBe(204)
		expect(del.headers[DISCOVERY_EPOCH_HEADER]).toBe("e1")
		expect(del.headers[DISCOVERY_REVISION_HEADER]).toBe("9")
	})

	it("[] and absent survive serialisation distinctly", async () => {
		await build([{ id: "ais", placements: [] }])
		const none = await app.inject({ url: "/api/scanner/discoveries/d_a" })
		expect(none.json().coverage).toEqual([])
		await app.close()
		await build([{ id: "ais" }])
		const unknown = await app.inject({ url: "/api/scanner/discoveries/d_a" })
		expect(unknown.json()).not.toHaveProperty("coverage")
		const list = await app.inject({ url: "/api/scanner/discoveries" })
		expect(list.json().items[0]).not.toHaveProperty("coverage")
	})

	it("suspension reasons are served", async () => {
		await build([
			{
				id: "flex",
				placements: [
					{
						sourceId: "rtl",
						reach: "channel",
						channelHz: F,
						running: false,
						suspension: { reasonCode: "capture-too-narrow", since: "x" },
					},
				],
			},
		])
		const res = await app.inject({ url: "/api/scanner/discoveries/d_a" })
		expect(res.json().coverage).toEqual([
			{
				decoderId: "flex",
				state: "suspended",
				suspensionReason: "capture-too-narrow",
			},
		])
	})

	it("an old client parse ignores the new fields", async () => {
		await build(running)
		const body = (
			await app.inject({ url: "/api/scanner/discoveries/d_b" })
		).json() as Record<string, unknown>
		// A pre-change client reads only the fields it knows.
		const { id, frequencyHz } = body
		expect({ id, frequencyHz }).toEqual({ id: "d_a", frequencyHz: F })
	})
})
