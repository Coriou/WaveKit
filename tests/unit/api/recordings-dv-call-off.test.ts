/**
 * The dv call recorder's directory is not served while DV_CALL_RECORDINGS_SERVED is off (no
 * call tap feeds the recorder, so nothing checked a file's call): a dv-call file on disk is
 * neither listed nor played, by its inventory id or its `dsd~` key, while a dsd-fme YSF call
 * beside it still is. Ids are synthetic.
 */
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Fastify from "fastify"
import type { FastifyInstance } from "fastify"
import pino from "pino"
import { afterEach, describe, expect, it } from "vitest"
import type { RecordingInventoryPage } from "@wavekit/api-types"
import { createRecordingInventory } from "../../../src/core/recordings/inventory.js"
import { DV_CALL_RECORDINGS_SERVED } from "../../../src/core/recordings/names.js"
import {
	recordingRoutes,
	type RecordingRoutesOptions,
} from "../../../src/api/routes/recordings.js"
import { wavHeader } from "../../../src/core/dv-recorder/wav-writer.js"

const DSD = "20261012_100000_12345_YSF_1A3_GROUP_TGT_9_SRC_1.wav"
const DV = "20261012_100500_00042_dsd-fme_GROUP_TGT_9_SRC_1.wav"

async function wav(dir: string, name: string): Promise<void> {
	const p = join(dir, name)
	await writeFile(p, Buffer.concat([wavHeader(16_000), Buffer.alloc(16_000)]))
	const old = (Date.now() - 60_000) / 1000
	await utimes(p, old, old)
}

describe("recordings: the dv call recorder's files while it has no call tap", () => {
	let root: string
	let app: FastifyInstance
	let close: (() => void) | undefined

	afterEach(async () => {
		close?.()
		await app.close()
		await rm(root, { recursive: true, force: true })
	})

	it("lists and plays no dv-call file, by id or key, and still serves a dsd-fme YSF call", async () => {
		expect(DV_CALL_RECORDINGS_SERVED).toBe(false)
		root = await mkdtemp(join(tmpdir(), "rec-dv-off-"))
		const dsdDir = join(root, "dsd")
		const dvDir = join(root, "dv")
		await mkdir(dsdDir)
		await mkdir(dvDir)
		await wav(dsdDir, DSD)
		await wav(dvDir, DV)
		const inventory = createRecordingInventory({
			dsdFmeDirs: () => [
				{ decoderId: "dsd-fme", dir: dsdDir },
				{ decoderId: "dv-calls", dir: dvDir, kind: "dv-call" },
			],
			dvCallDecoderIds: () => ["dsd-fme"],
			scannerRecordingsDir: () => null,
			logger: pino({ level: "silent" }),
		})
		close = () => inventory.close?.()
		app = Fastify({ logger: false })
		await app.register(recordingRoutes, {
			inventory,
			authorize: () => undefined,
			access: {
				leaseDownload: () => ({
					kind: "attached",
					active: () => true,
					release: () => {},
				}),
			},
		} as RecordingRoutesOptions)
		await app.ready()
		const get = (url: string) => app.inject({ method: "GET", url })
		const file = (id: string) =>
			get(`/api/recordings/${encodeURIComponent(id)}/file`)

		const page = (
			await get("/api/recordings?limit=200")
		).json<RecordingInventoryPage>()
		expect(page.items.map(i => [i.id, i.kind])).toEqual([
			[`dsd:0~${DSD}`, "dsd-fme-call"],
		])
		const dvOnly = (
			await get("/api/recordings?kind=dv-call")
		).json<RecordingInventoryPage>()
		expect(dvOnly.items).toEqual([])

		expect((await file(`dsd:0~${DSD}`)).statusCode).toBe(200)
		expect((await file(`dsd~${DSD}`)).statusCode).toBe(200)
		expect((await file(`dsd:1~${DV}`)).statusCode).toBe(404)
		expect((await file(`dsd~${DV}`)).statusCode).toBe(404)
		expect(inventory.hasKey?.(`dsd~${DV}`)).toBe(false)
		expect(await inventory.resolve(`dsd~${DV}`)).toBeNull()
	})
})
