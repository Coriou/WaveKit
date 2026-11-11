import { describe, expect, it } from "vitest"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
	loadOrCreateUnitId,
	UNIT_ID_FILE_NAME,
	type UnitIdFs,
} from "../../src/telemetry/unit-id.js"

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "sdr-host-unit-id-"))
	try {
		await fn(dir)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
}

describe("sdr-host unit id", () => {
	it("keeps the same id across restarts (a second load reads it back)", async () => {
		await withDir(async dir => {
			const first = await loadOrCreateUnitId(dir)
			expect(first.source).toBe("created")
			expect(first.unitId).toMatch(/^[0-9a-f]{32}$/)
			const second = await loadOrCreateUnitId(dir)
			expect(second).toEqual({ unitId: first.unitId, source: "read" })
		})
	})

	it("creates a new id when the file is missing", async () => {
		await withDir(async dir => {
			const first = await loadOrCreateUnitId(dir, undefined, () =>
				"a".repeat(32),
			)
			expect(first.unitId).toBe("a".repeat(32))
			await rm(join(dir, UNIT_ID_FILE_NAME))
			const again = await loadOrCreateUnitId(dir, undefined, () =>
				"b".repeat(32),
			)
			expect(again).toEqual({ unitId: "b".repeat(32), source: "created" })
			const text = await readFile(join(dir, UNIT_ID_FILE_NAME), "utf8")
			expect(JSON.parse(text)).toEqual({ version: 1, unitId: "b".repeat(32) })
		})
	})

	it.each([
		["not JSON", "{"],
		["a wrong version", JSON.stringify({ version: 2, unitId: "c".repeat(32) })],
		["a short id", JSON.stringify({ version: 1, unitId: "c".repeat(31) })],
		["upper-case hex", JSON.stringify({ version: 1, unitId: "C".repeat(32) })],
		["an oversized file", " ".repeat(2000)],
	])("regenerates a malformed file (%s)", async (_what, content) => {
		await withDir(async dir => {
			await writeFile(join(dir, UNIT_ID_FILE_NAME), content)
			const loaded = await loadOrCreateUnitId(dir, undefined, () =>
				"d".repeat(32),
			)
			expect(loaded).toEqual({ unitId: "d".repeat(32), source: "created" })
			const reread = await loadOrCreateUnitId(dir)
			expect(reread.unitId).toBe("d".repeat(32))
		})
	})

	it("reports no id when it cannot be persisted", async () => {
		const fs: UnitIdFs = {
			readFile: () =>
				Promise.reject(Object.assign(new Error("x"), { code: "ENOENT" })),
			writeFile: () => Promise.reject(new Error("read-only")),
			rename: () => Promise.resolve(),
			mkdir: () => Promise.resolve(),
		}
		expect(await loadOrCreateUnitId("/state", fs)).toEqual({
			unitId: null,
			source: "unavailable",
		})
	})

	it("writes through a temporary file renamed over the target", async () => {
		const calls: string[] = []
		const fs: UnitIdFs = {
			readFile: () => Promise.reject(new Error("missing")),
			writeFile: async path => {
				calls.push(`write ${path}`)
			},
			rename: async (from, to) => {
				calls.push(`rename ${from} -> ${to}`)
			},
			mkdir: async () => undefined,
		}
		const loaded = await loadOrCreateUnitId("/state", fs, () => "e".repeat(32))
		expect(loaded.unitId).toBe("e".repeat(32))
		expect(calls).toHaveLength(2)
		expect(calls[0]).toMatch(/^write \/state\/unit-id\.json\.\d+\.tmp$/)
		expect(calls[1]).toMatch(
			/^rename \/state\/unit-id\.json\.\d+\.tmp -> \/state\/unit-id\.json$/,
		)
	})
})
