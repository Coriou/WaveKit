// WG10 req 1.11: goldens recorded from the WG10 base (before the alias and eviction hunks).
// With no keep port and no merge, pruner output, retention and recordingPath are unchanged.
import { describe, expect, it } from "vitest"
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { EvidenceStore } from "../../../../src/core/scanner/store/evidence-store.js"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import { createLogger } from "../../../../src/utils/logger.js"
import { counterIds, makeObs } from "../../../mocks/scanner/observations.js"

const logger = createLogger({ level: "fatal" })
const DAY = 86_400_000
const T0 = Date.UTC(2026, 9, 9, 12, 0, 0)
const CH = 446_006_250

async function fixture(root: string): Promise<void> {
	const files: [string, number][] = [
		["recordings/dv/d_A/old.wav", T0 - 40 * DAY],
		["recordings/dv/d_A/new.wav", T0 - DAY],
		["recordings/dv/d_B/old.wav", T0 - 40 * DAY],
		["recordings/dv/d_B/new.wav", T0 - DAY],
		["recordings/dv/d_C/old.wav", T0 - 40 * DAY],
		["evidence/d_B/psd.json", T0 - 40 * DAY],
	]
	for (const [rel, mtime] of files) {
		const path = join(root, rel)
		await mkdir(join(path, ".."), { recursive: true })
		await writeFile(path, "x")
		await utimes(path, mtime / 1000, mtime / 1000)
	}
}

describe("WG10 base goldens (req 1.11)", () => {
	it("retention with no keep port deletes the same files", async () => {
		const root = await mkdtemp(join(tmpdir(), "wavekit-golden-"))
		try {
			await fixture(root)
			const store = new EvidenceStore({
				dir: root,
				caps: {
					maxRecordingsMb: 512,
					maxEvidenceMb: 64,
					maxAgeDays: 30,
					minFreeDiskMb: 0,
				},
				logger,
				now: () => T0,
				isDiscoveryLive: id => id === "d_A" || id === "d_B",
			})
			const { deleted } = await store.retention(new Set(["d_A"]))
			expect([...deleted].sort()).toEqual([
				"evidence/d_B/psd.json",
				"recordings/dv/d_B/old.wav",
				"recordings/dv/d_C/old.wav",
			])
			const rel = (p: string | null): string | null =>
				p === null ? null : relative(root, p)
			expect(rel(store.recordingPath("d_A~new.wav"))).toBe(
				"recordings/dv/d_A/new.wav",
			)
			expect(rel(store.recordingPath("d_A~old.wav"))).toBe(
				"recordings/dv/d_A/old.wav",
			)
			expect(store.recordingPath("d_C~old.wav")).toBeNull()
			expect(store.recordingPath("d_A~missing.wav")).toBeNull()
			expect(store.recordingPath("d_A~..x.wav")).toBeNull()
			expect(store.recordingPath("nope")).toBeNull()
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	it("pruneInactive returns the same ids", () => {
		let now = T0
		const store = new DiscoveryStore({
			maxDiscoveries: 10,
			now: () => now,
			newId: counterIds(),
		})
		const ids = [0, 1, 2].map(
			i =>
				store.ingest(
					makeObs({
						id: `o${i}`,
						centreHz: CH + i * 100_000,
						startedAt: T0 + i * DAY,
						blocks: 2,
					}),
				).discoveryId ?? "",
		)
		store.setOperator(ids[0] ?? "", { keep: true })
		now = T0 + 182 * DAY
		expect(store.pruneInactive(180)).toEqual([ids[1]])
		expect(ids).toMatchInlineSnapshot(`
			[
			  "d_00000000000000000000000001",
			  "d_00000000000000000000000002",
			  "d_00000000000000000000000003",
			]
		`)
	})
})
