/**
 * Recordings catalogue benchmark (not collected by vitest): a synthetic tree of WK_BENCH_FILES
 * (default 50 000, the bound) small WAV files in FILES × 0.15 scanner discovery folders, newest
 * folders last in walk order, in a temporary directory. Protection is on (500 kept keys), and
 * before every timed listing a change lands: a new recording indexed, a keep toggled and an
 * owner frequency changed. Reports, with the load average:
 *
 * - first_usable_ms: the first `list` answer (partial while `indexing`, at most the 750 ms wait);
 * - build_ms: the whole first build;
 * - page_ms p50/p95 over 20 warm listings (limit 200, then a filtered one), core time, and the
 *   process CPU time per listing (cpu_ms, both kinds), which host contention does not inflate;
 * - warm_fs_calls: filesystem calls made by two warm listings with no change (must be 0).
 *
 * Run: pnpm exec esbuild tests/unit/core/recordings/bench-inventory.ts --bundle
 *   --platform=node --format=esm --packages=external --outfile=<tmp>/bench.mjs && node <tmp>/bench.mjs
 */

import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { loadavg, tmpdir } from "node:os"
import * as path from "node:path"
import { performance } from "node:perf_hooks"
import {
	createRecordingInventory,
	nodeRecordingFs,
} from "../../../../src/core/recordings/inventory.js"
import type { RecordingFsPort } from "../../../../src/core/recordings/inventory.js"
import { createLogger } from "../../../../src/utils/logger.js"

/** WK_BENCH_FILES (default 50 000, the catalogue bound) in FILES × 0.15 folders. */
const FILES = Number(process.env["WK_BENCH_FILES"] ?? 50_000)
const FOLDERS = Math.round(FILES * 0.15)

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

function pct(xs: number[], p: number): number {
	const s = [...xs].sort((a, b) => a - b)
	return s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? Number.NaN
}

/** The Node port, counting every call. */
function counted(): { fs: RecordingFsPort; calls: () => number } {
	let n = 0
	const wrap =
		<A extends unknown[], R>(f: (...a: A) => R) =>
		(...a: A): R => {
			n++
			return f(...a)
		}
	return {
		fs: {
			opendir: wrap(nodeRecordingFs.opendir),
			lstat: wrap(nodeRecordingFs.lstat),
			stat: wrap(nodeRecordingFs.stat),
			realpath: wrap(nodeRecordingFs.realpath),
			open: wrap(nodeRecordingFs.open),
		},
		calls: () => n,
	}
}

async function main(): Promise<void> {
	// The catalogue's timers are unref'd (a server keeps the loop alive); so does this.
	const keepAlive = setInterval(() => undefined, 1_000)
	const root = await mkdtemp(path.join(tmpdir(), "wk-rec-bench-"))
	try {
		const scan = path.join(root, "scan")
		const data = wav(160)
		const base = Date.now() / 1000 - 2 * FILES
		let k = 0
		for (let f = 0; f < FOLDERS; f++) {
			const d = path.join(scan, "analog", `d_${String(f).padStart(6, "0")}`)
			await mkdir(d, { recursive: true })
			const n =
				Math.floor(((f + 1) * FILES) / FOLDERS) -
				Math.floor((f * FILES) / FOLDERS)
			for (let i = 0; i < n; i++) {
				const p = path.join(d, `analog-${i}.wav`)
				await writeFile(p, data)
				const t = base + k++
				await utimes(p, t, t)
			}
			await utimes(d, base + k, base + k)
		}
		const logger = createLogger({ level: "error" })
		const { fs, calls } = counted()
		// Protection on: 500 kept keys, read at list time like the keep service's.
		const kept = new Set<string>()
		for (let f = 0; f < 500; f++)
			kept.add(`scan:d_${String(f * 3).padStart(6, "0")}~analog-0.wav`)
		// Folders whose owner moved (a merge changes one owner, not every folder's).
		const moved = new Map<string, number>()
		const inv = createRecordingInventory({
			dsdFmeDirs: () => [],
			scannerRecordingsDir: () => scan,
			discoveryOwner: id => ({
				id,
				frequencyHz: 446_006_250 + (moved.get(id) ?? 0),
			}),
			protection: {
				isProtected: key => kept.has(key),
				isDsdFmeFileProtected: () => true,
				isScannerFileProtected: () => true,
				discoveryHoldsKept: () => true,
			},
			logger,
			fs,
		})
		const t0 = performance.now()
		const first = await inv.list({ limit: 200 })
		const firstUsable = performance.now() - t0
		await inv.start?.()
		const build = performance.now() - t0
		const done = await inv.list({ limit: 1 })
		if (done.scannedFiles !== FILES)
			throw new Error(
				`unexpected catalogue size ${done.scannedFiles} truncated=${String(done.truncated)}`,
			)
		const page: number[] = []
		const filtered: number[] = []
		// A change before every listing: a new recording indexed (an insert into the view), a
		// keep toggled and an owner frequency changed (both read at list time).
		let added = 0
		const change = async (): Promise<void> => {
			const f = added % FOLDERS
			const d = `d_${String(f).padStart(6, "0")}`
			const p = path.join(scan, "analog", d, `new-${added}.wav`)
			await writeFile(p, data)
			const t = base + FILES + added
			await utimes(p, t, t)
			added++
			await inv.touchDiscoveries?.([d])
			const k = `scan:${d}~analog-0.wav`
			if (kept.has(k)) kept.delete(k)
			else kept.add(k)
			moved.set(d, (moved.get(d) ?? 0) === 0 ? 12_500 : 0)
			inv.ownersChanged?.([d])
		}
		const warmBefore = calls()
		await inv.list({ limit: 200 })
		await inv.list({ limit: 200, q: "446.006", kept: "false" })
		const warmCalls = calls() - warmBefore
		// CPU time of the process per listing: what a loaded host's scheduling does not inflate.
		const cpu: number[] = []
		const cpuMs = (c: NodeJS.CpuUsage): number => (c.user + c.system) / 1000
		for (let run = 0; run < 20; run++) {
			await change()
			let t = performance.now()
			let c = process.cpuUsage()
			await inv.list({ limit: 200 })
			page.push(performance.now() - t)
			cpu.push(cpuMs(process.cpuUsage(c)))
			await change()
			t = performance.now()
			c = process.cpuUsage()
			await inv.list({ limit: 200, q: "446.006", kept: "false" })
			filtered.push(performance.now() - t)
			cpu.push(cpuMs(process.cpuUsage(c)))
		}
		inv.close?.()
		const [l1, l5, l15] = loadavg()
		process.stdout.write(
			`files=${FILES} folders=${FOLDERS} first_usable_ms=${firstUsable.toFixed(0)} ` +
				`first_indexing=${String(first.indexing)} first_listed=${first.scannedFiles} ` +
				`first_newest=${first.items[0]?.discoveryId ?? "none"} build_ms=${build.toFixed(0)} ` +
				`page_p50_ms=${pct(page, 0.5).toFixed(2)} page_p95_ms=${pct(page, 0.95).toFixed(2)} ` +
				`filtered_p50_ms=${pct(filtered, 0.5).toFixed(2)} filtered_p95_ms=${pct(filtered, 0.95).toFixed(2)} ` +
				`cpu_p50_ms=${pct(cpu, 0.5).toFixed(2)} cpu_p95_ms=${pct(cpu, 0.95).toFixed(2)} ` +
				`warm_fs_calls=${warmCalls} ` +
				`loadavg=${[l1, l5, l15].map(x => (x ?? 0).toFixed(2)).join(",")}\n`,
		)
	} finally {
		clearInterval(keepAlive)
		await rm(root, { recursive: true, force: true })
	}
}

void main().catch((err: unknown) => {
	process.stderr.write(`bench failed: ${String(err)}\n`)
	process.exitCode = 1
})
