import * as fs from "node:fs"
import { afterEach, describe, expect, it, vi } from "vitest"
import { spawnHubProcessFactory } from "../../../../src/core/iq-hub/hub-process.js"

afterEach(() => {
	vi.restoreAllMocks()
})

describe("spawnHubProcessFactory", () => {
	it("a synchronous spawn throw removes the private socket directory and fails IQHUB_UNAVAILABLE", async () => {
		const mkdtemp = fs.promises.mkdtemp.bind(fs.promises)
		const dirs: string[] = []
		vi.spyOn(fs.promises, "mkdtemp").mockImplementation(async prefix => {
			const dir = await mkdtemp(prefix)
			dirs.push(dir)
			return dir
		})
		// A NUL byte in the file name makes spawn throw synchronously (no child is created).
		const factory = spawnHubProcessFactory("wavekit-iqhub\u0000bad")
		const onLine = vi.fn()
		const onExit = vi.fn()
		await expect(
			factory({ sourceId: "rx", ringMs: 12_000 }, { onLine, onExit }),
		).rejects.toMatchObject({ code: "IQHUB_UNAVAILABLE" })
		expect(dirs).toHaveLength(1)
		expect(fs.existsSync(dirs[0] as string)).toBe(false)
		expect(onExit).not.toHaveBeenCalled()
	})
})
