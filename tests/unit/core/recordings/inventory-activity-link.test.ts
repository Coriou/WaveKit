/**
 * The catalogue side of Activity recording links: `activityEventId` on listed items (read at
 * list time, only when the lookup is wired), `hasKey` (memory only; null while it cannot prove a
 * file is gone), and a dsd-fme call's stable key opening its file in any dsd-fme directory.
 */
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pino from "pino"
import { afterEach, describe, expect, it } from "vitest"
import { createRecordingInventory } from "../../../../src/core/recordings/inventory.js"

const logger = pino({ level: "silent" })
const NAME = "20261012_100000_12345_DMR_CC_1_GROUP_TGT_9_SRC_1.wav"
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
		expect(await inv.open(`dsd~${NAME.replace("12345", "54321")}`)).toBeNull()
	})
})
