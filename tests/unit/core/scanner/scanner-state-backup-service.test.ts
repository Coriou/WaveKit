/**
 * The scanner service's pre-migration backup seam: it names the recording keep store (which
 * lives in the core state directory, outside the scanner directory), so a backup holds a copy in
 * `outside/`, and `status().stateBackup` reports the outcome.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { RECORDING_KEEPS_FILE_NAME } from "@wavekit/api-types"
import {
	BACKUP_OUTSIDE_DIR,
	BACKUPS_DIR,
	CURRENT_SCANNER_STATE_FORMAT,
	formatLabel,
} from "../../../../src/core/state-backup.js"
import { makeTmpDir } from "../../../helpers/tmp-dir.js"
import { serviceHarness } from "../../../mocks/scanner/service-fakes.js"

const KEEPS = '{"version":1,"keeps":[]}\n'

describe("ScannerService pre-migration backup", () => {
	it("copies the keep store into the backup's outside/ folder and reports the outcome", async () => {
		const stateDir = makeTmpDir("wk-scan-backup-")
		const scannerDir = join(stateDir, "scanner")
		// Unmarked state from a build before format markers.
		await mkdir(scannerDir, { recursive: true })
		await writeFile(join(scannerDir, "jobs.json"), '{"version":1,"jobs":[]}\n')
		await writeFile(join(stateDir, RECORDING_KEEPS_FILE_NAME), KEEPS)
		const h = serviceHarness({
			dir: stateDir,
			patch: s => {
				s.storage.dir = scannerDir
			},
		})
		await h.service.start()
		try {
			const names = await readdir(join(scannerDir, BACKUPS_DIR))
			const backup = names.find(n => n.startsWith("pre-unmarked."))
			expect(backup).toBeDefined()
			const copy = join(
				scannerDir,
				BACKUPS_DIR,
				backup ?? "",
				BACKUP_OUTSIDE_DIR,
				RECORDING_KEEPS_FILE_NAME,
			)
			expect(await readFile(copy, "utf8")).toBe(KEEPS)
			expect(h.service.status().stateBackup).toEqual({
				outcome: "taken",
				fromFormat: "unmarked",
				toFormat: formatLabel(CURRENT_SCANNER_STATE_FORMAT),
				path: join(BACKUPS_DIR, backup ?? ""),
			})
		} finally {
			await h.service.stop()
		}
	})

	it("a fresh scanner directory reports no backup needed", async () => {
		const stateDir = makeTmpDir("wk-scan-backup-")
		const h = serviceHarness({
			dir: stateDir,
			patch: s => {
				s.storage.dir = join(stateDir, "scanner")
			},
		})
		await h.service.start()
		try {
			expect(h.service.status().stateBackup).toEqual({
				outcome: "none",
				reason: "fresh",
				toFormat: formatLabel(CURRENT_SCANNER_STATE_FORMAT),
			})
		} finally {
			await h.service.stop()
		}
	})
})
