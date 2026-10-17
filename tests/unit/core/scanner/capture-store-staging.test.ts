import {
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Logger } from "../../../../src/utils/logger.js"
import { CaptureStore } from "../../../../src/core/scanner/evidence/capture-store.js"

let root: string
let warn: ReturnType<typeof vi.fn>
let info: ReturnType<typeof vi.fn>

function store(): CaptureStore {
	const fake: Record<string, unknown> = { warn, info, debug: vi.fn() }
	fake["child"] = () => fake
	return new CaptureStore({
		dir: root,
		logger: fake as unknown as Logger,
		now: () => 0,
	})
}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "capstage-"))
	warn = vi.fn()
	info = vi.fn()
})
afterEach(async () => {
	await rm(root, { recursive: true, force: true })
})

describe("capture store staging cleanup (WG10 req 1.10)", () => {
	it("golden (recorded from the frozen code): a tree without .tmp subdirectories", async () => {
		await mkdir(join(root, ".tmp"))
		await writeFile(join(root, ".tmp", "cap_a.cu8"), "x")
		await writeFile(join(root, "cap_orphan.cu8"), "x")
		await writeFile(join(root, "cap_b.json.tmp"), "x")
		await writeFile(join(root, "cap_bad.scanner.json"), "{")
		await writeFile(join(root, "notes.txt"), "x")
		await store().init()
		expect((await readdir(root)).sort()).toEqual([
			".tmp",
			"cap_bad.scanner.json",
			"notes.txt",
		])
		expect(await readdir(join(root, ".tmp"))).toEqual([])
		const calls = warn.mock.calls.map(c => c[1])
		// Frozen code also warned "Removing a capture leftover failed" (EISDIR on .tmp): removed by req 1.10.
		expect(calls).toEqual(["Ignoring an unreadable capture sidecar"])
	})

	it("does not warn about the staging directory itself", async () => {
		await store().init()
		expect(warn).not.toHaveBeenCalled()
		expect((await lstat(join(root, ".tmp"))).isDirectory()).toBe(true)
	})

	it("leaves a subdirectory inside .tmp and counts it", async () => {
		await mkdir(join(root, ".tmp", "sub"), { recursive: true })
		await writeFile(join(root, ".tmp", "sub", "keep.bin"), "x")
		await writeFile(join(root, ".tmp", "cap_a.cu8"), "x")
		await store().init()
		expect(await readdir(join(root, ".tmp"))).toEqual(["sub"])
		expect(await readdir(join(root, ".tmp", "sub"))).toEqual(["keep.bin"])
		expect(
			JSON.stringify([...warn.mock.calls, ...info.mock.calls]),
		).not.toContain("sub")
	})

	it("a symlinked .tmp is not swept and warns with fixed text", async () => {
		const outside = await mkdtemp(join(tmpdir(), "capoutside-"))
		try {
			await writeFile(join(outside, "precious.cu8"), "x")
			await symlink(outside, join(root, ".tmp"))
			await store().init()
			expect(await readdir(outside)).toEqual(["precious.cu8"])
			expect(warn).toHaveBeenCalledWith(
				"Capture staging directory is not a plain directory; not swept",
			)
		} finally {
			await rm(outside, { recursive: true, force: true })
		}
	})

	it("a .tmp that is a regular file is not swept", async () => {
		await writeFile(join(root, ".tmp"), "x")
		await store().init()
		expect(warn).toHaveBeenCalledWith(
			"Capture staging directory is not a plain directory; not swept",
		)
		expect((await lstat(join(root, ".tmp"))).isFile()).toBe(true)
	})
})
