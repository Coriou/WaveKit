/**
 * Longevity: the scanner's pre-migration state backup at startup against the number of
 * recordings (measure only, not CI). Builds a scanner state directory in a temporary folder with
 * an older format marker, a few state files and --recordings recording files (default 10 000)
 * in --folders discovery folders (default 250), then times `ensurePreMigrationBackup` (what
 * `ScannerPersistence.load` awaits before "Scanner started"), split into its phases by the
 * test seams (link, fsync), and, when the build defers the recording links
 * (`completeDeferredLinks`), the time until they are done. The directory is deleted at the end.
 *
 *   pnpm exec esbuild scripts/longevity/state-backup-start.ts --bundle --platform=node \
 *     --format=esm --packages=external --outfile=output/longevity/state-backup-start.mjs
 *   node output/longevity/state-backup-start.mjs [--recordings 10000] [--folders 250]
 */
import { link } from "node:fs/promises"
import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import { join } from "node:path"
import { performance } from "node:perf_hooks"
import process from "node:process"
import * as backup from "../../src/core/state-backup.js"
import { createLogger } from "../../src/utils/logger.js"

const arg = (name: string, fallback: number): number => {
	const i = process.argv.indexOf(`--${name}`)
	const v = i >= 0 ? Number(process.argv[i + 1]) : Number.NaN
	return Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback
}
const RECORDINGS = arg("recordings", 10_000)
const FOLDERS = arg("folders", 250)
const logger = createLogger({ level: "fatal" })
const load = (): string =>
	os
		.loadavg()
		.map(v => v.toFixed(2))
		.join(" ")
const ms = (v: number): string => v.toFixed(1)

const dir = await mkdtemp(join(os.tmpdir(), "wavekit-state-backup-"))
try {
	await writeFile(
		join(dir, backup.STATE_FORMAT_FILE),
		`${JSON.stringify({ fileVersion: 0, heldJournalFormat: 0 })}\n`,
	)
	await writeFile(join(dir, "discoveries.json"), "x".repeat(200_000))
	await writeFile(join(dir, "journal.ndjson"), "y".repeat(100_000))
	const wav = Buffer.alloc(16_044)
	for (let i = 0; i < RECORDINGS; i++) {
		const folder = join(
			dir,
			"recordings",
			i % 2 ? "dv" : "analog",
			`d_F${i % FOLDERS}`,
		)
		await mkdir(folder, { recursive: true })
		await writeFile(join(folder, `r-${i}.wav`), wav)
	}
	let links = 0
	let linkMs = 0
	let syncs = 0
	let syncMs = 0
	const seams = {
		dir,
		logger,
		now: () => Date.now(),
		statfs: async () => ({ bavail: 1e12, bsize: 1 }),
		link: async (from: string, to: string) => {
			const t = performance.now()
			await link(from, to)
			links++
			linkMs += performance.now() - t
		},
		fsync: async (path: string, kind: "file" | "dir") => {
			const t = performance.now()
			const handle = await open(path, "r")
			try {
				await handle.sync()
			} catch (err) {
				if (kind === "file") throw err
			} finally {
				await handle.close()
			}
			syncs++
			syncMs += performance.now() - t
		},
	}
	const counts = (): string =>
		`links ${links} (sum ${ms(linkMs)} ms), fsyncs ${syncs} (sum ${ms(syncMs)} ms)`
	console.log(`state: ${RECORDINGS} recordings; load ${load()}`)
	const t0 = performance.now()
	const out = await backup.ensurePreMigrationBackup(seams)
	console.log(
		`before "started": ${ms(performance.now() - t0)} ms (${out.kind}); ${counts()}; load ${load()}`,
	)
	// Feature-detected, so the same script measures a build without the deferred half.
	const deferred = (
		backup as {
			completeDeferredLinks?: (o: typeof seams) => Promise<{ kind: string }[]>
		}
	).completeDeferredLinks
	if (deferred) {
		links = linkMs = syncs = syncMs = 0
		const t1 = performance.now()
		const done = await deferred(seams)
		console.log(
			`after "started", in the background: ${ms(performance.now() - t1)} ms (${done.map(d => d.kind).join(",")}); ${counts()}; load ${load()}`,
		)
	}
} finally {
	await rm(dir, { recursive: true, force: true })
}
