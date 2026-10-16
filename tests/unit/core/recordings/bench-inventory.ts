/**
 * WG8 recordings inventory benchmark (not collected by vitest): 2 000 synthetic WAV files in a
 * temporary directory: cold `list`, a listing-cache hit, and a header-cache-warm rescan, median
 * of 3, with the load average.
 *
 * Run: pnpm exec esbuild tests/unit/core/recordings/bench-inventory.ts --bundle
 *   --platform=node --format=esm --packages=external --outfile=<tmp>/bench.mjs && node <tmp>/bench.mjs
 */

import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { loadavg, tmpdir } from "node:os"
import * as path from "node:path"
import { performance } from "node:perf_hooks"
import { createRecordingInventory } from "../../../../src/core/recordings/inventory.js"
import { createLogger } from "../../../../src/utils/logger.js"

const FILES = 2000

function wav(dataBytes: number): Buffer {
	const b = Buffer.alloc(44 + dataBytes)
	b.write("RIFF", 0, "ascii")
	b.writeUInt32LE(36 + dataBytes, 4)
	b.write("WAVEfmt ", 8, "ascii")
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

function median(xs: number[]): number {
	const s = [...xs].sort((a, b) => a - b)
	return s[Math.floor(s.length / 2)] ?? Number.NaN
}

async function main(): Promise<void> {
	const root = await mkdtemp(path.join(tmpdir(), "wk-rec-bench-"))
	try {
		const dsd = path.join(root, "dsd")
		await mkdir(dsd)
		const data = wav(16_000)
		const old = (Date.now() - 60_000) / 1000
		for (let i = 0; i < FILES; i++) {
			const t = String(100000 + i)
			const p = path.join(dsd, `20261016_${t}_01234_1_GROUP_TGT_1_SRC_2.wav`)
			await writeFile(p, data)
			await utimes(p, old, old)
		}
		const logger = createLogger({ level: "error" })
		const cold: number[] = []
		const hit: number[] = []
		const warm: number[] = []
		for (let run = 0; run < 3; run++) {
			let now = Date.now()
			const inv = createRecordingInventory({
				dsdFmeDirs: () => [{ decoderId: "a", dir: dsd }],
				scannerRecordingsDir: () => null,
				now: () => now,
				logger,
			})
			let t = performance.now()
			const page = await inv.list({ limit: 200 })
			cold.push(performance.now() - t)
			if (page.scannedFiles !== FILES) throw new Error("unexpected scan size")
			// Listing-cache hit: same clock, served from the 2 s snapshot.
			t = performance.now()
			await inv.list({ limit: 200 })
			hit.push(performance.now() - t)
			// Header-cache-warm rescan (listing cache expired) with every header cached.
			now += 3000
			t = performance.now()
			await inv.list({ limit: 200 })
			warm.push(performance.now() - t)
		}
		const [l1, l5, l15] = loadavg()
		process.stdout.write(
			`files=${FILES} cold_median_ms=${median(cold).toFixed(1)} ` +
				`listing_hit_median_ms=${median(hit).toFixed(2)} header_warm_rescan_median_ms=${median(warm).toFixed(1)} ` +
				`cold=${cold.map(x => x.toFixed(1)).join(",")} hit=${hit.map(x => x.toFixed(2)).join(",")} ` +
				`warm=${warm.map(x => x.toFixed(1)).join(",")} ` +
				`loadavg=${[l1, l5, l15].map(x => (x ?? 0).toFixed(2)).join(",")}\n`,
		)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}

void main().catch((err: unknown) => {
	process.stderr.write(`bench failed: ${String(err)}\n`)
	process.exitCode = 1
})
