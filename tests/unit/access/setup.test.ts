import * as fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { setupLocalAccess } from "../../../src/access/setup.js"
import { PrivateAccessStorage } from "../../../src/access/private-storage.js"

const roots: string[] = []
const ownership = "single-host-pid-namespace" as const

afterEach(async () => {
	for (const root of roots.splice(0))
		await fs.rm(root, { recursive: true, force: true })
})

async function location() {
	const root = await fs.mkdtemp(join(tmpdir(), "wavekit-access-setup-"))
	roots.push(root)
	return join(root, "private")
}

describe("stopped-core guided setup", () => {
	it("returns safe initial/existing status and leaves a reusable private credential ready for core startup", async () => {
		const directory = await location()
		expect(await setupLocalAccess({ directory, ownership })).toEqual({
			kind: "ready",
			code: "ACCESS_SETUP_CREATED",
			nextStep: "start-core-and-pair-browser",
		})
		const first = await fs.readFile(
			join(directory, "access-state.json"),
			"utf8",
		)
		expect(await setupLocalAccess({ directory, ownership })).toEqual({
			kind: "ready",
			code: "ACCESS_SETUP_READY",
			nextStep: "start-core-and-pair-browser",
		})
		expect(
			await fs.readFile(join(directory, "access-state.json"), "utf8"),
		).toBe(first)
		expect((await fs.readdir(directory)).sort()).toEqual([
			"access-state.json",
			"initialized",
		])
	})

	it("tells a running owner to stop/retry without changing its private state", async () => {
		const directory = await location()
		const storage = await PrivateAccessStorage.open({
			directory,
			ownership,
			mode: "provision",
		})
		try {
			expect(await setupLocalAccess({ directory, ownership })).toEqual({
				kind: "unavailable",
				code: "ACCESS_STORAGE_BUSY",
				nextStep: "stop-core-and-retry",
			})
		} finally {
			await storage.close()
		}
	})

	it("reports incomplete or corrupt storage as offline recovery and never returns a credential or path", async () => {
		const directory = await location()
		await setupLocalAccess({ directory, ownership })
		await fs.unlink(join(directory, "access-state.json"))
		const incomplete = await setupLocalAccess({ directory, ownership })
		expect(incomplete).toEqual({
			kind: "unavailable",
			code: "ACCESS_STORAGE_INCOMPLETE",
			nextStep: "repair-private-state-offline",
		})
		await fs.writeFile(
			join(directory, "access-state.json"),
			"secret-invalid-input",
			{ mode: 0o600 },
		)
		const corrupt = await setupLocalAccess({ directory, ownership })
		expect(corrupt).toEqual({
			kind: "unavailable",
			code: "ACCESS_STORAGE_INVALID",
			nextStep: "repair-private-state-offline",
		})
		expect(JSON.stringify(corrupt)).not.toContain("secret-invalid-input")
		expect(JSON.stringify(corrupt)).not.toContain(directory)
		expect(
			await fs.readFile(join(directory, "access-state.json"), "utf8"),
		).toBe("secret-invalid-input")
	})
})
