import {
	API_ENUMS_PATH,
	DISCOVERY_VIEWS,
	SCAN_JOB_VIEWS,
	type DiscoveryCompact,
	type DiscoveryCompactPage,
	type ScanJob,
	type ScanJobCompact,
	type ScannerRecorderDecision,
} from "@wavekit/api-types"
import Fastify, { type FastifyInstance } from "fastify"
import { afterEach, describe, expect, it, vi } from "vitest"
import { API_ENUMS, enumRoutes } from "../../../src/api/routes/enums.js"
import {
	scannerRoutes,
	type ScannerRouteService,
} from "../../../src/api/routes/scanner.js"
import { DiscoveryStore } from "../../../src/core/scanner/store/discovery-store.js"
import type { DiscoveryFilter } from "../../../src/core/scanner/store/discovery-store.js"
import { makeHopPlan } from "../../mocks/scanner/job-spec.js"
import { counterIds, makeObs } from "../../mocks/scanner/observations.js"

const T0 = Date.UTC(2026, 9, 9, 12, 0, 0)
const META = { storeEpoch: "e1", storeRevision: 7 }

function storeOf(n: number): DiscoveryStore {
	const store = new DiscoveryStore({
		maxDiscoveries: n + 1,
		now: () => T0,
		newId: counterIds(),
	})
	for (let i = 0; i < n; i++)
		store.ingest(
			makeObs({
				id: `o-${i}`,
				centreHz: 100_000_000 + i * 100_000,
				startedAt: T0 + i * 1_000,
				blocks: 2,
			}),
		)
	return store
}

/** The service's compact read over a real store, with the given recorder decisions. */
function service(
	store: DiscoveryStore,
	extra: Partial<ScannerRouteService> = {},
	last: (
		id: string,
	) => { code: ScannerRecorderDecision; at: string } | null = () => null,
) {
	return {
		listDiscoveries: (filter: DiscoveryFilter) => ({
			...store.list(filter),
			...META,
		}),
		listDiscoveriesPaced: async (filter: DiscoveryFilter) => ({
			...(await store.listPaced(filter)),
			...META,
		}),
		listDiscoveriesCompact: async (
			filter: DiscoveryFilter,
		): Promise<DiscoveryCompactPage> => {
			const page = await store.listCompactPaced(filter)
			return {
				items: page.items.map(row => {
					const decision = last(row.id)
					return { ...row, recorder: decision ? { last: decision } : null }
				}),
				nextCursor: page.nextCursor,
				...META,
			}
		},
		...extra,
	} as unknown as ScannerRouteService
}

const apps: FastifyInstance[] = []

async function appFor(scanner: ScannerRouteService): Promise<FastifyInstance> {
	const app = Fastify()
	apps.push(app)
	await app.register(scannerRoutes, { scanner })
	await app.register(enumRoutes)
	return app
}

afterEach(async () => {
	for (const app of apps.splice(0)) await app.close()
})

const FIELDS = [
	"id",
	"frequencyHz",
	"class",
	"protocol",
	"confidence",
	"evidenceLevel",
	"identity",
	"lastSeenAt",
	"recorder",
] as const satisfies readonly (keyof DiscoveryCompact)[]

describe("GET /api/scanner/discoveries?view=compact", () => {
	it("answers the documented fields only, with the paging and the store stamp", async () => {
		const app = await appFor(service(storeOf(5)))
		const first = await app.inject(
			"/api/scanner/discoveries?view=compact&limit=2",
		)
		expect(first.statusCode).toBe(200)
		const page = first.json<DiscoveryCompactPage>()
		expect(page).toMatchObject({ nextCursor: "2", ...META })
		expect(page.items).toHaveLength(2)
		for (const row of page.items)
			expect(Object.keys(row).sort()).toEqual([...FIELDS].sort())
		const next = await app.inject(
			`/api/scanner/discoveries?view=compact&limit=2&cursor=${page.nextCursor}`,
		)
		const ids = next.json<DiscoveryCompactPage>().items.map(row => row.id)
		expect(ids).not.toContain(page.items[0]!.id)
		expect(ids).toHaveLength(2)
	})

	it("says what null means: no decision is a null recorder, a decision is its last", async () => {
		const store = storeOf(2)
		const [a, b] = store.list({}).items
		const at = new Date(T0).toISOString()
		const app = await appFor(
			service(store, {}, id => (id === a!.id ? { code: "started", at } : null)),
		)
		const res = await app.inject("/api/scanner/discoveries?view=compact")
		const rows = new Map(
			res.json<DiscoveryCompactPage>().items.map(row => [row.id, row]),
		)
		expect(rows.get(a!.id)?.recorder).toEqual({
			last: { code: "started", at },
		})
		expect(rows.get(b!.id)?.recorder).toBeNull()
		expect(rows.get(b!.id)?.identity).toBeNull()
	})

	it("keeps a bare compact row under 250 bytes, under half the full one", async () => {
		const app = await appFor(service(storeOf(100)))
		const size = async (query: string): Promise<number> => {
			const res = await app.inject(`/api/scanner/discoveries?limit=100${query}`)
			const { items } = res.json<{ items: unknown[] }>()
			return (
				items.reduce<number>(
					(sum, row) => sum + Buffer.byteLength(JSON.stringify(row)),
					0,
				) / items.length
			)
		}
		const compact = await size("&view=compact")
		const full = await size("")
		expect(compact).toBeLessThan(250)
		expect(compact).toBeLessThan(full / 2)
	})

	it("leaves the default and view=full answers as they were", async () => {
		const store = storeOf(3)
		const app = await appFor(service(store))
		const plain = await app.inject("/api/scanner/discoveries")
		const full = await app.inject("/api/scanner/discoveries?view=full")
		const expected = store.list({})
		expect(plain.json()).toEqual({ ...expected, ...META })
		expect(full.body).toBe(plain.body)
		expect(
			plain.json<{ items: { family?: string }[] }>().items[0]?.family,
		).toBe("unknown")
	})

	it("uses the paced read, and the plain one on an older service shape", async () => {
		const store = storeOf(2)
		const paced = vi.fn(async (filter: DiscoveryFilter) => ({
			...(await store.listPaced(filter)),
			...META,
		}))
		const plain = vi.fn((filter: DiscoveryFilter) => ({
			...store.list(filter),
			...META,
		}))
		const current = await appFor({
			listDiscoveries: plain,
			listDiscoveriesPaced: paced,
		} as unknown as ScannerRouteService)
		await current.inject("/api/scanner/discoveries")
		expect(paced).toHaveBeenCalledTimes(1)
		expect(plain).not.toHaveBeenCalled()
		const older = await appFor({
			listDiscoveries: plain,
		} as unknown as ScannerRouteService)
		expect((await older.inject("/api/scanner/discoveries")).statusCode).toBe(
			200,
		)
		expect(plain).toHaveBeenCalledTimes(1)
	})

	it("refuses an unknown view with a 400", async () => {
		const app = await appFor(service(storeOf(1)))
		const res = await app.inject("/api/scanner/discoveries?view=small")
		expect(res.statusCode).toBe(400)
	})

	it("answers an invalid cursor as the full read does", async () => {
		const app = await appFor(service(storeOf(1)))
		const compact = await app.inject(
			"/api/scanner/discoveries?view=compact&cursor=x",
		)
		const full = await app.inject("/api/scanner/discoveries?cursor=x")
		expect(compact.statusCode).toBe(full.statusCode)
		expect(compact.json()).toEqual(full.json())
	})

	it("lists the views in GET /api/enums", async () => {
		expect(API_ENUMS.scanner.discoveryViews).toBe(DISCOVERY_VIEWS)
		expect(API_ENUMS.scanner.jobViews).toBe(SCAN_JOB_VIEWS)
		const app = await appFor(service(storeOf(0)))
		const res = await app.inject(API_ENUMS_PATH)
		expect(
			res.json<{ scanner: { discoveryViews: string[]; jobViews: string[] } }>()
				.scanner,
		).toMatchObject({
			discoveryViews: ["full", "compact"],
			jobViews: ["full", "compact"],
		})
	})
})

describe("GET /api/scanner/jobs?view=compact", () => {
	const job = {
		id: "j_1",
		name: "a sweep",
		state: "running",
		spec: { kind: "discover", sourceId: "source-a" },
		plan: makeHopPlan(
			Array.from({ length: 200 }, (_, i) => 100_000_000 + i * 2_000_000),
		),
		issues: [],
		updatedAt: new Date(T0).toISOString(),
	} as unknown as ScanJob
	const row: ScanJobCompact = {
		id: "j_1",
		name: "a sweep",
		kind: "discover",
		state: "running",
		reason: null,
		sourceId: "source-a",
		updatedAt: new Date(T0).toISOString(),
	}

	it("answers small rows, without building a job DTO", async () => {
		const listJobs = vi.fn(() => [job])
		const app = await appFor(
			service(storeOf(0), { listJobs, jobRows: () => [row] }),
		)
		const res = await app.inject("/api/scanner/jobs?view=compact")
		expect(res.json()).toEqual([row])
		expect(listJobs).not.toHaveBeenCalled()
		expect(Buffer.byteLength(JSON.stringify(row))).toBeLessThan(200)
	})

	it("maps the full job on an older service shape", async () => {
		const app = await appFor(service(storeOf(0), { listJobs: () => [job] }))
		const res = await app.inject("/api/scanner/jobs?view=compact")
		expect(res.json()).toEqual([row])
	})

	it("keeps the full list by default, and the plan makes it far larger", async () => {
		const app = await appFor(service(storeOf(0), { listJobs: () => [job] }))
		const res = await app.inject("/api/scanner/jobs")
		expect(res.json()).toEqual([job])
		expect(Buffer.byteLength(res.body)).toBeGreaterThan(
			50 * Buffer.byteLength(JSON.stringify(row)),
		)
	})

	it("refuses an unknown view with a 400", async () => {
		const app = await appFor(service(storeOf(0), { listJobs: () => [job] }))
		expect((await app.inject("/api/scanner/jobs?view=small")).statusCode).toBe(
			400,
		)
	})
})
