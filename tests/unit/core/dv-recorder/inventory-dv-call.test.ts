/**
 * The recorder's directory as an inventory source: its files list as kind `dv-call`, with the
 * decoder named in each file, under the same `dsd~` / `dsd:<n>~` keys as dsd-fme's own calls.
 */
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pino from "pino"
import { afterEach, describe, expect, it } from "vitest"
import { createRecordingInventory } from "../../../../src/core/recordings/inventory.js"
import { wavHeader } from "../../../../src/core/dv-recorder/wav-writer.js"
import { dvCallFileName } from "../../../../src/core/dv-recorder/names.js"

const logger = pino({ level: "silent" })
const DSD = "20261012_100000_12345_P25_1A3_GROUP_TGT_9_SRC_1.wav"
const DV_A = "20261012_100500_00042_dsd-fme_GROUP_TGT_9_SRC_1.wav"
const DV_B = "20261012_100600_00043_dsd-fme-2_PRIVATE_TGT_7_SRC_3.wav"
const TEMP = "TEMP_dv_20261012_100700_0001.wav"
const roots: string[] = []
const closers: (() => void)[] = []
afterEach(async () => {
	for (const c of closers.splice(0)) c()
	await Promise.all(
		roots.splice(0).map(r => rm(r, { recursive: true, force: true })),
	)
})

async function file(dir: string, name: string): Promise<void> {
	const p = join(dir, name)
	await writeFile(p, Buffer.concat([wavHeader(16_000), Buffer.alloc(16_000)]))
	const old = (Date.now() - 60_000) / 1000
	await utimes(p, old, old)
}

describe("inventory: the dv call recorder directory", () => {
	it("lists its files as dv-call with each file's decoder, never its TEMP", async () => {
		const dsdDir = await mkdtemp(join(tmpdir(), "wk-dvinv-dsd-"))
		const dvDir = await mkdtemp(join(tmpdir(), "wk-dvinv-dv-"))
		roots.push(dsdDir, dvDir)
		await file(dsdDir, DSD)
		await file(dvDir, DV_A)
		await file(dvDir, DV_B)
		await file(dvDir, TEMP)
		const inv = createRecordingInventory({
			dsdFmeDirs: () => [
				{ decoderId: "dsd-fme", dir: dsdDir },
				{ decoderId: "dv-calls", dir: dvDir, kind: "dv-call" },
			],
			dvCallDecoderIds: () => ["dsd-fme", "dsd-fme-2"],
			scannerRecordingsDir: () => null,
			logger,
		})
		closers.push(() => inv.close?.())
		const page = await inv.list({})
		const rows = page.items
			.map(i => [i.id, i.kind, i.decoderId, i.durationMs, i.callType])
			.sort()
		expect(rows).toEqual(
			[
				[`dsd:0~${DSD}`, "dsd-fme-call", "dsd-fme", 1000, "group"],
				[`dsd:1~${DV_A}`, "dv-call", "dsd-fme", 1000, "group"],
				[`dsd:1~${DV_B}`, "dv-call", "dsd-fme-2", 1000, "private"],
			].sort(),
		)
		expect(page.items.find(i => i.kind === "dv-call")?.startedAtLocal).toMatch(
			/^2026-10-12T10:0[56]:00$/,
		)
		expect(await inv.resolve(`dsd~${DV_B}`)).toBe(join(dvDir, DV_B))
		expect(inv.hasKey?.(`dsd~${DV_A}`)).toBe(true)
	})

	it("a call end of any decoder re-reads the recorder's directory", async () => {
		const dsdDir = await mkdtemp(join(tmpdir(), "wk-dvinv-touchdsd-"))
		const dvDir = await mkdtemp(join(tmpdir(), "wk-dvinv-touch-"))
		roots.push(dsdDir, dvDir)
		const inv = createRecordingInventory({
			dsdFmeDirs: () => [
				{ decoderId: "dsd-fme", dir: dsdDir },
				{ decoderId: "dv-calls", dir: dvDir, kind: "dv-call" },
			],
			dvCallDecoderIds: () => ["dsd-fme", "probe-1"],
			scannerRecordingsDir: () => null,
			logger,
		})
		closers.push(() => inv.close?.())
		expect((await inv.list({})).items).toEqual([])
		// The decoder owns a dsd-fme directory of its own: the dv-call one is re-read too.
		await file(dvDir, DV_A)
		await inv.touchCallRecordings?.("dsd-fme")
		expect((await inv.list({ kind: "dv-call" })).items.map(i => i.id)).toEqual([
			`dsd:1~${DV_A}`,
		])
		// A decoder with no directory of its own (a probe).
		const probe = "20261012_100800_00044_probe-1_GROUP_TGT_9_SRC_1.wav"
		await file(dvDir, probe)
		await inv.touchCallRecordings?.("probe-1")
		const items = (await inv.list({ kind: "dv-call" })).items
		expect(items.map(i => [i.id, i.decoderId]).sort()).toEqual(
			[
				[`dsd:1~${DV_A}`, "dsd-fme"],
				[`dsd:1~${probe}`, "probe-1"],
			].sort(),
		)
	})

	it("maps a name field only by an exact match; unknown, ambiguous or no resolver is null", async () => {
		const dvDir = await mkdtemp(join(tmpdir(), "wk-dvinv-map-"))
		roots.push(dvDir)
		const T = Date.UTC(2026, 9, 12, 10, 0, 0)
		const ids = [
			"scan-abcdefg-dsdfme-12",
			"scan-abcdefg-dsdfme-13",
			"dmr.a",
			"dmr-a",
		]
		const names = ids.map((id, i) => dvCallFileName(T, 100 + i, id, null))
		const unknown = dvCallFileName(T, 200, "gone-decoder", null)
		for (const n of [...names, unknown]) await file(dvDir, n)
		const make = (resolver?: () => readonly string[]) =>
			createRecordingInventory({
				dsdFmeDirs: () => [
					{ decoderId: "dv-calls", dir: dvDir, kind: "dv-call" },
				],
				...(resolver === undefined ? {} : { dvCallDecoderIds: resolver }),
				scannerRecordingsDir: () => null,
				logger,
			})
		const inv = make(() => ids)
		closers.push(() => inv.close?.())
		const byName = new Map(
			(await inv.list({})).items.map(i => [i.id.split("~")[1], i.decoderId]),
		)
		for (const [i, id] of ids.entries()) expect(byName.get(names[i])).toBe(id)
		expect(byName.get(unknown)).toBeNull()

		const none = make()
		closers.push(() => none.close?.())
		const all = (await none.list({})).items
		expect(all).toHaveLength(5)
		for (const i of all) expect(i.decoderId).toBeNull()

		const throwing = make(() => {
			throw new Error("not ready")
		})
		closers.push(() => throwing.close?.())
		for (const i of (await throwing.list({})).items)
			expect(i.decoderId).toBeNull()
	})
})
