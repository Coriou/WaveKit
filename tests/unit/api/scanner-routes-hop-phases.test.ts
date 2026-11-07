/**
 * The real route over the real service: a job's per-hop phases reach the client, nothing strips them.
 */
import Fastify from "fastify"
import { afterEach, describe, expect, it } from "vitest"
import {
	scannerRoutes,
	type ScannerRouteService,
} from "../../../src/api/routes/scanner.js"
import type { ScanJob } from "../../../packages/api-types/src/scanner.js"
import {
	qualificationWorld,
	synthWorld,
} from "../core/scanner/sweep-qualification-harness.js"

const CENTRE_HZ = 446_100_000
const stops: (() => Promise<void>)[] = []
afterEach(async () => {
	for (const stop of stops.splice(0).reverse()) await stop()
})

describe("GET /jobs/:id hop phases", () => {
	it("returns each hop's measured phases, summing to its time", async () => {
		const w = qualificationWorld({
			centreHz: CENTRE_HZ,
			world: synthWorld([]),
		})
		stops.push(() => w.stop())
		await w.service.start()
		const job = await w.service.createJob({
			sourceId: "rtl",
			mode: "sweep",
			bandplans: [],
			ranges: [{ startHz: CENTRE_HZ - 400_000, endHz: CENTRE_HZ + 1_400_000 }],
			priority: 50,
			takeover: true,
			resume: { autoAfterIdleMs: null },
		} as never)
		const app = Fastify({ logger: false })
		stops.push(() => app.close())
		await app.register(scannerRoutes, {
			scanner: w.service as unknown as ScannerRouteService,
		})
		await w.advance(1_000)
		const res = await app.inject({ url: `/api/scanner/jobs/${job.id}` })
		expect(res.statusCode).toBe(200)
		const { hops } = res.json<ScanJob>().progress
		expect(hops).toBeDefined()
		const visited = hops!.filter(h => h.visits > 0)
		expect(visited.length).toBeGreaterThan(0)
		for (const h of hops!) {
			expect(h).toEqual(
				expect.objectContaining({
					measuredSettleMs: expect.any(Number) as number,
					measuredStaleMs: expect.any(Number) as number,
					measuredDwellMs: expect.any(Number) as number,
					measuredQualifyMs: expect.any(Number) as number,
					overheadMs: expect.any(Number) as number,
				}),
			)
			expect(
				h.measuredSettleMs! +
					h.measuredStaleMs! +
					h.measuredDwellMs! +
					h.measuredQualifyMs! +
					h.holdMs +
					h.overheadMs!,
			).toBe(h.timeMs)
		}
		expect(visited.some(h => h.measuredSettleMs! > 0)).toBe(true)
	}, 60_000)
})
