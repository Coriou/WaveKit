/**
 * The catalogue side of Activity recording links: `activityEventId` on listed items (read at
 * list time, only when the lookup is wired), `hasKey` (memory only; null while it cannot prove a
 * file is gone), and a dsd-fme call's stable key opening its file in any dsd-fme directory.
 */
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Fastify from "fastify"
import pino from "pino"
import { afterEach, describe, expect, it } from "vitest"
import {
	recordingRoutes,
	type RecordingRoutesOptions,
} from "../../../../src/api/routes/recordings.js"
import { createRecordingInventory } from "../../../../src/core/recordings/inventory.js"
import { wireRecordingLinks } from "../../../../src/core/activity/recording-links.js"
import type { ActivityLinkOp } from "../../../../src/core/activity/storage/contract.js"

const logger = pino({ level: "silent" })
const NAME = "20261012_100000_12345_YSF_1A3_GROUP_TGT_9_SRC_1.wav"
const roots: string[] = []
const closers: (() => void)[] = []
afterEach(async () => {
	for (const c of closers.splice(0)) c()
	await Promise.all(
		roots.splice(0).map(r => rm(r, { recursive: true, force: true })),
	)
})

async function callDirs(): Promise<{ a: string; b: string }> {
	const a = await mkdtemp(join(tmpdir(), "wk-p2-inv-a-"))
	const b = await mkdtemp(join(tmpdir(), "wk-p2-inv-b-"))
	roots.push(a, b)
	const file = join(b, NAME)
	await writeFile(file, Buffer.alloc(64))
	const old = (Date.now() - 60_000) / 1000
	await utimes(file, old, old)
	return { a, b }
}

describe("catalogue links to Activity", () => {
	it("lists activityEventId when wired (null when unknown), and no such property otherwise", async () => {
		const { a, b } = await callDirs()
		const dirs = () => [
			{ decoderId: "dsd-a", dir: a },
			{ decoderId: "dsd-b", dir: b },
		]
		const wired = createRecordingInventory({
			dsdFmeDirs: dirs,
			scannerRecordingsDir: () => null,
			logger,
			activityEventId: key => (key === `dsd~${NAME}` ? "evt-1" : null),
		})
		const plain = createRecordingInventory({
			dsdFmeDirs: dirs,
			scannerRecordingsDir: () => null,
			logger,
		})
		closers.push(
			() => wired.close?.(),
			() => plain.close?.(),
		)
		const listed = await wired.list({})
		expect(listed.items.map(i => [i.key, i.activityEventId])).toEqual([
			[`dsd~${NAME}`, "evt-1"],
		])
		const bare = await plain.list({})
		expect("activityEventId" in (bare.items[0] ?? {})).toBe(false)
	})

	it("hasKey answers from memory once built, null before", async () => {
		const { a, b } = await callDirs()
		const inv = createRecordingInventory({
			dsdFmeDirs: () => [
				{ decoderId: "dsd-a", dir: a },
				{ decoderId: "dsd-b", dir: b },
			],
			scannerRecordingsDir: () => null,
			logger,
		})
		closers.push(() => inv.close?.())
		expect(inv.hasKey?.(`dsd~${NAME}`)).toBeNull()
		await inv.start?.()
		expect(inv.hasKey?.(`dsd~${NAME}`)).toBe(true)
		expect(inv.hasKey?.(`dsd~${NAME.replace("12345", "54321")}`)).toBe(false)
	})

	it("a DMR call file on disk is not a key (DMR recordings off), so the link sweep removes an old DMR link", async () => {
		const { a, b } = await callDirs()
		const DMR = "20261012_100001_12345_DMR_CC_1_GROUP_TGT_9_SRC_1.wav"
		const file = join(a, DMR)
		await writeFile(file, Buffer.alloc(64))
		const old = (Date.now() - 60_000) / 1000
		await utimes(file, old, old)
		const inv = createRecordingInventory({
			dsdFmeDirs: () => [
				{ decoderId: "dsd-a", dir: a },
				{ decoderId: "dsd-b", dir: b },
			],
			scannerRecordingsDir: () => null,
			logger,
		})
		closers.push(() => inv.close?.())
		await inv.start?.()
		expect(inv.hasKey?.(`dsd~${DMR}`)).toBe(false)
		expect(inv.hasKey?.(`dsd~${NAME}`)).toBe(true)
		// A store written before DMR recordings were switched off holds both links.
		const ops: ActivityLinkOp[] = []
		const links = wireRecordingLinks({
			links: {
				admitRecording: () => undefined,
				link: op => ops.push(op),
				recordingEventId: () => null,
				linkedRecordings: () => [`dsd~${DMR}`, `dsd~${NAME}`],
				onLinks: () => () => undefined,
			},
			catalogue: inv,
			logger,
			sweepMs: 3_600_000,
			missingMs: 0,
		})
		closers.push(() => links.close())
		links.sweep()
		links.sweep()
		expect(ops).toEqual([{ type: "unlink", recordingIds: [`dsd~${DMR}`] }])
	})

	it("an old DMR link goes even while a configured directory is missing (the dv call recorder's, never created)", async () => {
		const { a, b } = await callDirs()
		const DMR = "20261012_100001_12345_DMR_CC_1_GROUP_TGT_9_SRC_1.wav"
		const file = join(a, DMR)
		await writeFile(file, Buffer.alloc(64))
		const old = (Date.now() - 60_000) / 1000
		await utimes(file, old, old)
		// The recorder's directory is created only when it starts (it had no call tap here).
		const dvCalls = join(b, "dv-calls")
		const DV = "20261012_100002_12346_dsd-a_GROUP_TGT_9_SRC_3.wav"
		const inv = createRecordingInventory({
			dsdFmeDirs: () => [
				{ decoderId: "dsd-a", dir: a },
				{ decoderId: "dsd-b", dir: b },
				{ decoderId: "dv-calls", dir: dvCalls, kind: "dv-call" },
			],
			dvCallDecoderIds: () => ["dsd-a"],
			scannerRecordingsDir: () => null,
			logger,
		})
		closers.push(() => inv.close?.())
		await inv.start?.()
		// A missing directory may hold any servable dsd~ name: those stay unknown.
		expect(inv.hasKey?.(`dsd~${NAME}`)).toBeNull()
		expect(inv.hasKey?.(`dsd~${DV}`)).toBeNull()
		// No source serves a dsd-fme DMR name while DMR recordings are off.
		expect(inv.hasKey?.(`dsd~${DMR}`)).toBe(false)
		// Neither a TEMP name nor a name that is no call name is claimed gone.
		expect(inv.hasKey?.(`dsd~TEMP_${DMR}`)).toBeNull()
		const ops: ActivityLinkOp[] = []
		const links = wireRecordingLinks({
			links: {
				admitRecording: () => undefined,
				link: op => ops.push(op),
				recordingEventId: () => null,
				linkedRecordings: () => [`dsd~${DMR}`, `dsd~${NAME}`, `dsd~${DV}`],
				onLinks: () => () => undefined,
			},
			catalogue: inv,
			logger,
			sweepMs: 3_600_000,
			missingMs: 0,
		})
		closers.push(() => links.close())
		links.sweep()
		links.sweep()
		expect(ops).toEqual([{ type: "unlink", recordingIds: [`dsd~${DMR}`] }])
	})

	it("hasKey cannot tell while a refresh runs, nor after a pass that met a directory error", async () => {
		const { a, b } = await callDirs()
		let dirs = [
			{ decoderId: "dsd-a", dir: a },
			{ decoderId: "dsd-b", dir: b },
		]
		const inv = createRecordingInventory({
			dsdFmeDirs: () => dirs,
			scannerRecordingsDir: () => null,
			logger,
		})
		closers.push(() => inv.close?.())
		await inv.start?.()
		inv.invalidate?.()
		expect(inv.hasKey?.(`dsd~${NAME}`)).toBeNull()
		await inv.list({})
		expect(inv.hasKey?.(`dsd~${NAME}`)).toBe(true)
		// A configured directory that is not a directory any more: its files read unknown, not gone.
		dirs = [
			{ decoderId: "dsd-a", dir: a },
			{ decoderId: "dsd-b", dir: join(b, NAME) },
		]
		inv.invalidate?.()
		await inv.list({})
		expect(inv.hasKey?.(`dsd~${NAME}`)).toBeNull()
	})

	it("opens a dsd-fme call by its stable key in whichever dsd-fme directory holds it", async () => {
		const { a, b } = await callDirs()
		const inv = createRecordingInventory({
			dsdFmeDirs: () => [
				{ decoderId: "dsd-a", dir: a },
				{ decoderId: "dsd-b", dir: b },
			],
			scannerRecordingsDir: () => null,
			logger,
		})
		closers.push(() => inv.close?.())
		const opened = await inv.open(`dsd~${NAME}`)
		expect(opened?.name).toBe(NAME)
		expect(opened?.path).toBe(join(b, NAME))
		await opened?.handle.close()
		expect(await inv.open(`dsd~../${NAME}`)).toBeNull()
		// A .wav that is no dsd-fme call name (the catalogue never lists it) is never served.
		const other = "20261012_100000_12345_notes.wav"
		await writeFile(join(b, other), Buffer.alloc(64))
		const old = (Date.now() - 60_000) / 1000
		await utimes(join(b, other), old, old)
		expect(await inv.open(`dsd~${other}`)).toBeNull()
		const app = Fastify({ logger: false })
		await app.register(recordingRoutes, {
			inventory: inv,
			authorize: () => undefined,
			access: {
				leaseDownload: () => ({
					kind: "attached",
					active: () => true,
					release: () => undefined,
				}),
			},
		} as unknown as RecordingRoutesOptions)
		try {
			const get = (id: string) =>
				app.inject({
					method: "GET",
					url: `/api/recordings/${encodeURIComponent(id)}/file`,
				})
			expect((await get(`dsd~${other}`)).statusCode).toBe(404)
			expect((await get(`dsd~${NAME}`)).statusCode).toBe(200)
		} finally {
			await app.close()
		}
		expect(await inv.open(`dsd~${NAME.replace("12345", "54321")}`)).toBeNull()
	})
})
