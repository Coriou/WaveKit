import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "vitest"
import { scanStorageAreas } from "../../../../src/core/storage-report/scan.js"

// Run with: WAVEKIT_BENCH=1 pnpm exec vitest run tests/unit/core/storage-report/scan-benchmark.test.ts
describe.skipIf(process.env["WAVEKIT_BENCH"] !== "1")(
	"storage scan benchmark",
	() => {
		it("scans 50 000 files", { timeout: 300_000 }, async () => {
			const root = await mkdtemp(join(tmpdir(), "wavekit-storage-bench-"))
			try {
				for (let d = 0; d < 500; d++) {
					const dir = join(root, `d${d}`)
					await mkdir(dir)
					await Promise.all(
						Array.from({ length: 100 }, (_, f) =>
							writeFile(join(dir, `f${f}`), "x"),
						),
					)
				}
				const cpu0 = process.cpuUsage()
				const t0 = performance.now()
				const result = await scanStorageAreas([
					{ id: "logs", paths: [root], capBytes: null },
				])
				const wallMs = performance.now() - t0
				const cpu = process.cpuUsage(cpu0)
				console.info(
					`storage scan: wall=${wallMs.toFixed(0)}ms cpu(user+sys)=${((cpu.user + cpu.system) / 1000).toFixed(0)}ms result=${JSON.stringify(result)}`,
				)
			} finally {
				await rm(root, { recursive: true, force: true })
			}
		})
	},
)
