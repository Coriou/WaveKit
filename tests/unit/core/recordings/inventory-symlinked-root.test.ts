/**
 * WG9 R2: the inventory lists a configured recording root that is itself a symlink the way
 * the deleters prune it: resolved once (first sight), listed and resolved through its real
 * directory; a symlink below it stays refused; a real root whose identity changed is not
 * listed (a counted source error). Non-symlinked roots: inventory.test.ts, unchanged.
 */
import {
	mkdir,
	mkdtemp,
	realpath,
	rename,
	rm,
	symlink,
	unlink,
	utimes,
	writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createRecordingInventory } from "../../../../src/core/recordings/inventory.js"
import type { Logger } from "../../../../src/utils/logger.js"

const DSD = (hhmmss: string): string =>
	`20261016_${hhmmss}_01234_1_GROUP_TGT_100_SRC_2001.wav`

function wav(dataBytes: number): Buffer {
	const b = Buffer.alloc(44 + dataBytes)
	b.write("RIFF", 0, "ascii")
	b.writeUInt32LE(36 + dataBytes, 4)
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
	b.writeUInt32LE(dataBytes, 40)
	return b
}

function fakeLogger(): { logger: Logger; warn: ReturnType<typeof vi.fn> } {
	const warn = vi.fn()
	const l: Record<string, unknown> = {
		warn,
		info: vi.fn(),
		debug: vi.fn(),
		error: vi.fn(),
		trace: vi.fn(),
		fatal: vi.fn(),
	}
	l["child"] = () => l
	return { logger: l as unknown as Logger, warn }
}

let base = ""
const now = Date.now() + 60_000

async function put(p: string): Promise<void> {
	await mkdir(path.dirname(p), { recursive: true })
	await writeFile(p, wav(16_000))
	const t = (now - 30_000) / 1000
	await utimes(p, t, t)
}

afterEach(async () => {
	if (base) await rm(base, { recursive: true, force: true })
	base = ""
})

async function setup() {
	base = await realpath(await mkdtemp(path.join(tmpdir(), "wk-rec-root-")))
	const real = path.join(base, "real")
	await put(path.join(real, DSD("120000")))
	const outside = path.join(base, "outside")
	await put(path.join(outside, DSD("120001")))
	await symlink(
		path.join(outside, DSD("120001")),
		path.join(real, DSD("120001")),
	)
	const configured = path.join(base, "configured")
	await symlink(real, configured)
	const { logger, warn } = fakeLogger()
	const inv = createRecordingInventory({
		dsdFmeDirs: () => [{ decoderId: "a", dir: configured }],
		scannerRecordingsDir: () => null,
		now: () => now,
		logger,
	})
	return { real, outside, configured, inv, warn }
}

describe("recordings inventory, symlinked configured dsd-fme root", () => {
	it("lists and resolves through the real directory; a symlinked file below stays refused", async () => {
		const { real, inv } = await setup()
		const page = await inv.list({})
		expect(page.items.map(i => i.id)).toEqual([`dsd:0~${DSD("120000")}`])
		expect(await inv.resolve(`dsd:0~${DSD("120000")}`)).toBe(
			path.join(real, DSD("120000")),
		)
		expect(await inv.resolve(`dsd:0~${DSD("120001")}`)).toBeNull()
	})

	it("a re-pointed configured link keeps the pinned real directory", async () => {
		const { real, configured, inv } = await setup()
		await inv.list({})
		const other = path.join(base, "other")
		await put(path.join(other, DSD("130000")))
		await unlink(configured)
		await symlink(other, configured)
		inv.invalidate?.()
		expect((await inv.list({})).items.map(i => i.id)).toEqual([
			`dsd:0~${DSD("120000")}`,
		])
		expect(await inv.resolve(`dsd:0~${DSD("130000")}`)).toBeNull()
		expect(await inv.resolve(`dsd:0~${DSD("120000")}`)).toBe(
			path.join(real, DSD("120000")),
		)
	})

	it("a real directory replaced after the first sight is not listed (counted)", async () => {
		const { real, inv, warn } = await setup()
		await inv.list({})
		await rename(real, path.join(base, "moved"))
		await put(path.join(real, DSD("140000")))
		inv.invalidate?.()
		expect((await inv.list({})).items).toEqual([])
		expect(await inv.resolve(`dsd:0~${DSD("140000")}`)).toBeNull()
		const fields = warn.mock.calls.at(-1)?.[0] as Record<string, unknown>
		expect(fields["sourceErrors"]).toBe(1)
		expect(JSON.stringify(warn.mock.calls)).not.toContain(base)
	})
})

describe("recordings inventory, symlinked scanner storage root", () => {
	it("lists the scanner recordings under a symlinked storage root through its real directory", async () => {
		base = await realpath(await mkdtemp(path.join(tmpdir(), "wk-rec-root-")))
		const real = path.join(base, "storage-real")
		await put(path.join(real, "recordings", "dv", "d_abc", "call-1.wav"))
		const storage = path.join(base, "storage")
		await symlink(real, storage)
		const { logger } = fakeLogger()
		const inv = createRecordingInventory({
			dsdFmeDirs: () => [],
			scannerRecordingsDir: () => path.join(storage, "recordings"),
			now: () => now,
			logger,
		})
		expect((await inv.list({})).items.map(i => i.id)).toEqual([
			"scan:d_abc~call-1.wav",
		])
		expect(await inv.resolve("scan:d_abc~call-1.wav")).toBe(
			path.join(real, "recordings", "dv", "d_abc", "call-1.wav"),
		)
	})
})
