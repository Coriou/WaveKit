/**
 * WG10 MA.1 (Main, rk2 review minor 3): src/index.ts hands the sweep the scanner recordings
 * directory under the realpath of the configured storage root (the same real directory the
 * evidence store pins), so a symlinked root is swept, and a missing root sweeps nothing.
 */
import * as nodeFs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pino from "pino"
import { afterEach, describe, expect, it } from "vitest"
import { sweepRecordingDeleteLeftovers } from "../../../../src/core/recordings/delete-sweep.js"
import type { RecordingProtection } from "../../../../src/core/recordings/contract.js"
import { scannerDeleteSweepDir } from "../../../../src/index.js"

const P = ".wavekit-delete-abc123"
const logger = pino({ level: "silent" })
const ready: RecordingProtection & { state: () => "ready" } = {
	state: () => "ready",
	isProtected: () => false,
	isDsdFmeFileProtected: () => false,
	isScannerFileProtected: () => false,
	discoveryHoldsKept: () => false,
}

const roots: string[] = []
afterEach(async () => {
	for (const r of roots.splice(0))
		await nodeFs.rm(r, { recursive: true, force: true })
})

async function layout() {
	const base = await nodeFs.realpath(
		await nodeFs.mkdtemp(join(tmpdir(), "wk-sweepw-")),
	)
	roots.push(base)
	const real = join(base, "real")
	const priv = join(real, "recordings", "dv", "d_abc", P)
	await nodeFs.mkdir(priv, { recursive: true })
	await nodeFs.chmod(priv, 0o700)
	await nodeFs.writeFile(join(priv, "verified"), "x")
	const link = join(base, "link")
	await nodeFs.symlink(real, link)
	return { base, real, link, priv }
}

describe("delete sweep wiring: the scanner root is realpath-resolved (WG10 MA.1)", () => {
	it("resolves a symlinked storage root to its real directory", async () => {
		const { base, real, link } = await layout()
		expect(await scannerDeleteSweepDir(base, link)).toBe(
			join(real, "recordings", "dv"),
		)
	})

	it("defaults to <stateDir>/scanner and answers null when the root is missing", async () => {
		const { base } = await layout()
		expect(await scannerDeleteSweepDir(base, null)).toBeNull()
		await nodeFs.mkdir(join(base, "scanner"))
		expect(await scannerDeleteSweepDir(base, "")).toBe(
			join(base, "scanner", "recordings", "dv"),
		)
	})

	it("a leftover under a symlinked root is swept through the resolved dir", async () => {
		const { base, link, priv } = await layout()
		const resolved = await sweepRecordingDeleteLeftovers({
			dsdFmeDirs: [],
			scannerRecordingsDir: await scannerDeleteSweepDir(base, link),
			protection: ready,
			logger,
		})
		expect(resolved).toMatchObject({ found: 1, deleted: 1, left: 0 })
		await expect(nodeFs.lstat(priv)).rejects.toMatchObject({ code: "ENOENT" })
	})
})
