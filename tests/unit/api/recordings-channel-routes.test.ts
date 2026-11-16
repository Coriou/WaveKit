/**
 * The recordings list route over a real catalogue: the item's verdict facts (`speech`, `keptBy`,
 * `startedAt`, `observationId`) and the channel scopes (`channelHz`, `nearHz` + `toleranceHz`,
 * `matchedByChannel`) on the wire, and a 400 naming a contradictory scope. Synthetic files only.
 */
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Fastify from "fastify"
import pino from "pino"
import { afterEach, describe, expect, it } from "vitest"
import type { RecordingInventoryPage } from "@wavekit/api-types"
import {
	recordingRoutes,
	type RecordingRoutesOptions,
} from "../../../src/api/routes/recordings.js"
import { createRecordingInventory } from "../../../src/core/recordings/inventory.js"

const logger = pino({ level: "silent" })
const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
	for (const c of cleanups.splice(0).reverse()) await c()
})

const DISCOVERY = { id: "d_01ROUTECHAN", hz: 446_006_250 }
const OP = "00000000-0000-4000-8000-000000000001"

function wav(): Buffer {
	const b = Buffer.alloc(44 + 1600)
	b.write("RIFF", 0, "ascii")
	b.writeUInt32LE(36 + 1600, 4)
	b.write("WAVE", 8, "ascii")
	b.write("fmt ", 12, "ascii")
	b.writeUInt32LE(16, 16)
	b.writeUInt16LE(1, 20)
	b.writeUInt16LE(1, 22)
	b.writeUInt32LE(8000, 24)
	b.writeUInt32LE(16000, 28)
	b.writeUInt16LE(2, 32)
	b.writeUInt16LE(16, 34)
	b.write("data", 36, "ascii")
	b.writeUInt32LE(1600, 40)
	return b
}

describe("recordings route: verdict and channel", () => {
	it("serves the verdict facts and the channel scopes", async () => {
		const root = await mkdtemp(join(tmpdir(), "wk-rec-route-"))
		cleanups.push(() => rm(root, { recursive: true, force: true }))
		const folder = join(root, "recordings", "analog", DISCOVERY.id)
		await mkdir(folder, { recursive: true })
		const file = join(folder, `analog-${OP}.wav`)
		await writeFile(file, wav())
		const old = (Date.now() - 120_000) / 1000
		await utimes(file, old, old)
		const receiptDir = join(root, ".analog-operations", OP)
		await mkdir(receiptDir, { recursive: true })
		await writeFile(
			join(receiptDir, "receipt.json"),
			JSON.stringify({
				version: 1,
				operationId: OP,
				observationId: "o_ROUTE",
				outcome: "finalized",
				cutReason: "completed",
				keptBy: "prior-none",
				speechHeard: false,
				startedAt: "2026-11-16T10:00:00.000Z",
			}),
		)
		const inventory = createRecordingInventory({
			dsdFmeDirs: () => [],
			scannerRecordingsDir: () => join(root, "recordings"),
			discoveryOwner: id =>
				id === DISCOVERY.id ? { id, frequencyHz: DISCOVERY.hz } : null,
			logger,
		})
		cleanups.push(() => inventory.close?.())
		const app = Fastify({ logger: false })
		await app.register(recordingRoutes, {
			inventory,
			authorize: () => undefined,
			access: {
				leaseDownload: () => ({
					kind: "attached",
					active: () => true,
					release: () => undefined,
				}),
			},
		} as unknown as RecordingRoutesOptions)
		cleanups.push(() => app.close())
		const get = async (query: string) => {
			const res = await app.inject({
				method: "GET",
				url: `/api/recordings?${query}`,
			})
			return {
				status: res.statusCode,
				body: res.json() as RecordingInventoryPage & {
					fields?: { field: string }[]
				},
			}
		}
		const exact = await get(`channelHz=${DISCOVERY.hz}`)
		expect(exact.status).toBe(200)
		expect(exact.body.items).toHaveLength(1)
		expect(exact.body.items[0]).toMatchObject({
			frequencyHz: DISCOVERY.hz,
			speech: "not-heard",
			keptBy: "prior-none",
			startedAt: "2026-11-16T10:00:00.000Z",
			observationId: "o_ROUTE",
		})
		const near = await get(`nearHz=${DISCOVERY.hz + 10_000}&toleranceHz=12500`)
		expect(near.status).toBe(200)
		expect(near.body.matched).toBe(1)
		expect(near.body.matchedByChannel).toEqual([
			{ frequencyHz: DISCOVERY.hz, count: 1 },
		])
		const none = await get(`channelHz=${DISCOVERY.hz + 12_500}`)
		expect(none.body.items).toEqual([])
		const bad = await get("toleranceHz=10")
		expect(bad.status).toBe(400)
		expect(bad.body.fields?.map(f => f.field)).toEqual(["toleranceHz"])
		const both = await get(`channelHz=1&nearHz=1`)
		expect(both.status).toBe(400)
	})
})
