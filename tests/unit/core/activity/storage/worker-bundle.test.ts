import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL, fileURLToPath } from "node:url"
import { build } from "esbuild"
import { afterAll, describe, expect, it } from "vitest"
import { openActivityStore } from "../../../../../src/core/activity/storage/store.js"
import { envelope, logger, readRecords } from "./helpers.js"

const repository = fileURLToPath(new URL("../../../../../", import.meta.url))
const roots: string[] = []

afterAll(async () => {
	await Promise.all(
		roots.map(root => rm(root, { recursive: true, force: true })),
	)
})

describe("activity writer worker", () => {
	it("commits through a bundled worker thread", async () => {
		// Placed in the repo so Node resolves external @wavekit/shared. That is
		// how scripts/build-file.mjs emits this entry: esm, packages external.
		const bundleDir = await mkdtemp(join(repository, ".tmp-activity-worker-"))
		roots.push(bundleDir)
		const outfile = join(bundleDir, "activity-writer-worker.mjs")
		await build({
			absWorkingDir: repository,
			entryPoints: ["src/core/activity/storage/activity-writer-worker.ts"],
			outfile,
			bundle: true,
			platform: "node",
			format: "esm",
			packages: "external",
		})
		await writeFile(join(bundleDir, "package.json"), '{"type":"module"}\n')
		const stateDir = await mkdtemp(join(tmpdir(), "wavekit-activity-state-"))
		roots.push(stateDir)
		const store = await openActivityStore({
			stateDir,
			logger,
			execution: "thread",
			workerUrl: pathToFileURL(outfile),
			limits: {
				batchWindowMs: 0,
				globalBurst: 10,
				decoderBurst: 10,
			},
		})
		const committed = new Promise<string>(resolve => {
			store.onCommit(identity => {
				resolve(identity.committedMax)
			})
		})
		expect(store.admit(envelope({ eventId: "from-worker" }))).toEqual({
			admitted: true,
		})
		await expect(committed).resolves.toBe("1")
		const records = await readRecords(store.dbPath)
		expect(records.map(record => record.eventId)).toEqual(["from-worker"])
		await store.close()
		const reopened = await openActivityStore({
			stateDir,
			logger,
			execution: "inline",
			limits: { batchWindowMs: 0 },
		})
		expect(reopened.stats().rows).toBe(1)
		await reopened.close()
	}, 8_000)
})
