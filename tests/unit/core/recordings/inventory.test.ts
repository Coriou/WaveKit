import { createHash } from "node:crypto"
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	readlink,
	rm,
	symlink,
	unlink,
	utimes,
	writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import fc from "fast-check"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	RECORDINGS_HEADER_READ_BYTES,
	RECORDINGS_IN_PROGRESS_MS,
	RECORDINGS_SCAN_CONCURRENCY,
	RECORDINGS_SCAN_MAX_FILES,
} from "@wavekit/api-types"
import {
	RecordingInventoryError,
	createRecordingInventory,
} from "../../../../src/core/recordings/inventory.js"
import type {
	RecordingFileHandle,
	RecordingFsPort,
	RecordingInventoryOptions,
	RecordingStats,
} from "../../../../src/core/recordings/inventory.js"
import type { Logger } from "../../../../src/utils/logger.js"

// ---------------------------------------------------------------------------------------------
// Helpers

function wav(dataBytes: number, rate = 8000, channels = 1, bits = 16): Buffer {
	const b = Buffer.alloc(44 + dataBytes)
	b.write("RIFF", 0, "ascii")
	b.writeUInt32LE(36 + dataBytes, 4)
	b.write("WAVE", 8, "ascii")
	b.write("fmt ", 12, "ascii")
	b.writeUInt32LE(16, 16)
	b.writeUInt16LE(1, 20)
	b.writeUInt16LE(channels, 22)
	b.writeUInt32LE(rate, 24)
	b.writeUInt32LE((rate * channels * bits) / 8, 28)
	b.writeUInt16LE((channels * bits) / 8, 32)
	b.writeUInt16LE(bits, 34)
	b.write("data", 36, "ascii")
	b.writeUInt32LE(dataBytes, 40)
	return b
}

function fakeLogger(): { logger: Logger; warn: ReturnType<typeof vi.fn> } {
	const warn = vi.fn()
	const l: Record<string, unknown> = {
		warn,
		info: vi.fn(),
		debug: vi.fn(),
		error: vi.fn(),
		trace: vi.fn(),
		fatal: vi.fn(),
	}
	l["child"] = () => l
	return { logger: l as unknown as Logger, warn }
}

function errno(code: string): Error {
	return Object.assign(new Error(code), { code })
}

const DSD = (hhmmss: string, rest = "1_GROUP_TGT_100_SRC_2001"): string =>
	`20261016_${hhmmss}_01234_${rest}.wav`

type FNode =
	| { t: "dir" }
	| { t: "link" }
	| { t: "file"; size: number; mtimeMs: number; data: Uint8Array }

/** In-memory read-only fs behind the inventory's port, instrumented. */
class FakeFs implements RecordingFsPort {
	readonly nodes = new Map<string, FNode>()
	readonly real = new Map<string, string>()
	calls = 0
	active = 0
	maxActive = 0
	delayMs = 0
	opens = 0
	readdirs = 0
	readLengths: number[] = []
	afterReaddir: ((dir: string) => void) | null = null

	dir(p: string): this {
		const parent = path.dirname(p)
		if (parent !== p && !this.nodes.has(parent)) this.dir(parent)
		this.nodes.set(p, { t: "dir" })
		return this
	}

	file(p: string, mtimeMs: number, data: Uint8Array = WAV_1S): this {
		this.dir(path.dirname(p))
		this.nodes.set(p, { t: "file", size: data.length, mtimeMs, data })
		return this
	}

	link(p: string): this {
		this.dir(path.dirname(p))
		this.nodes.set(p, { t: "link" })
		return this
	}

	private async step<T>(fn: () => T): Promise<T> {
		this.calls++
		this.active++
		this.maxActive = Math.max(this.maxActive, this.active)
		try {
			if (this.delayMs > 0) await delay(this.delayMs)
			else await Promise.resolve()
			return fn()
		} finally {
			this.active--
		}
	}

	readdir(dir: string): Promise<string[]> {
		return this.step(() => {
			this.readdirs++
			const n = this.nodes.get(dir)
			if (!n) throw errno("ENOENT")
			if (n.t !== "dir") throw errno("ENOTDIR")
			const out: string[] = []
			for (const p of this.nodes.keys())
				if (p !== dir && path.dirname(p) === dir) out.push(path.basename(p))
			this.afterReaddir?.(dir)
			return out
		})
	}

	lstat(p: string): Promise<RecordingStats> {
		return this.step(() => {
			const n = this.nodes.get(p)
			if (!n) throw errno("ENOENT")
			return {
				isFile: () => n.t === "file",
				isDirectory: () => n.t === "dir",
				isSymbolicLink: () => n.t === "link",
				size: n.t === "file" ? n.size : 0,
				mtimeMs: n.t === "file" ? n.mtimeMs : 0,
			}
		})
	}

	realpath(p: string): Promise<string> {
		return this.step(() => {
			if (!this.nodes.has(p)) throw errno("ENOENT")
			return this.real.get(p) ?? p
		})
	}

	open(p: string): Promise<RecordingFileHandle> {
		return this.step(() => {
			this.opens++
			const n = this.nodes.get(p)
			if (!n) throw errno("ENOENT")
			if (n.t === "link") throw errno("ELOOP")
			if (n.t !== "file") throw errno("EISDIR")
			const data = n.data
			return {
				read: (buf: Uint8Array, off: number, len: number, pos: number) =>
					this.step(() => {
						this.readLengths.push(len)
						const chunk = data.subarray(pos, pos + len)
						buf.set(chunk, off)
						return { bytesRead: chunk.length }
					}),
				close: () => this.step(() => undefined),
			}
		})
	}
}

const WAV_1S = new Uint8Array(wav(16_000))
const NOW = Date.UTC(2026, 9, 16, 12, 0, 0)
const OLD = NOW - 60_000

function fakeInventory(
	fs: FakeFs,
	extra: Partial<RecordingInventoryOptions> = {},
): ReturnType<typeof createRecordingInventory> {
	return createRecordingInventory({
		dsdFmeDirs: () => [{ decoderId: "a", dir: "/r/dsd" }],
		scannerRecordingsDir: () => "/r/scan",
		now: () => NOW,
		logger: fakeLogger().logger,
		fs,
		...extra,
	})
}

/** Every file, dir and link under `root`, with content hashes and times (never following links). */
async function treeHash(root: string): Promise<string> {
	const h = createHash("sha256")
	const walk = async (p: string): Promise<void> => {
		const st = await lstat(p)
		h.update(`${path.relative(root, p)}|${st.mode}|${st.size}|${st.mtimeMs}\n`)
		if (st.isSymbolicLink()) h.update(await readlink(p))
		else if (st.isFile()) h.update(await readFile(p))
		else if (st.isDirectory() && (st.mode & 0o700) === 0o700)
			for (const n of (await readdir(p)).sort()) await walk(path.join(p, n))
	}
	await walk(root)
	return h.digest("hex")
}

const REFUSED = [
	"dsd:01~20261016_120000_01234_1_GROUP_TGT_1_SRC_2.wav",
	"dsd:10000~20261016_120000_01234_1_GROUP_TGT_1_SRC_2.wav",
	"dsd:0~TEMP_20261016_120000_ABCD.wav",
	"dsd:0~../20261016_120000_01234_1_GROUP_TGT_1_SRC_2.wav",
	"dsd:0~20261016_120000_01234_a/b.wav",
	"dsd:0~20261016_120000_01234_a b.wav",
	"scan:d_abc~../../etc/passwd.wav",
	"scan:probe-1~x.wav",
	"scan:d_abc~x.WAV",
	"/app/decoded_calls/x.wav",
	"",
	"dsd:0~..%2F20261016_120000_01234_1_GROUP_TGT_1_SRC_2.wav",
	"dsd:0~20261016_120000_01234_1\\..\\x.wav",
	"scan:d_abc~..\\..\\x.wav",
	"scan:d_abc/../d_x~y.wav",
	"scan:d_abc~x.wav\0",
	"scan:d_abc~x.wav/",
]

// ---------------------------------------------------------------------------------------------
// Hostile trees on the real filesystem

describe("recordings inventory on a hostile tree", () => {
	let root = ""
	const restore: string[] = []

	afterEach(async () => {
		for (const p of restore.splice(0)) await chmod(p, 0o755).catch(() => {})
		if (root) await rm(root, { recursive: true, force: true })
		root = ""
	})

	async function build(): Promise<{
		options: RecordingInventoryOptions
		warn: ReturnType<typeof vi.fn>
		now: number
	}> {
		root = await mkdtemp(path.join(tmpdir(), "wk-rec-"))
		const now = Date.now() + 60_000
		const old = (now - 30_000) / 1000
		const put = async (
			p: string,
			data: Buffer = wav(16_000),
		): Promise<void> => {
			await mkdir(path.dirname(p), { recursive: true })
			await writeFile(p, data)
			await utimes(p, old, old)
		}
		const a = path.join(root, "dsdA")
		const c = path.join(root, "dsdC")
		await put(path.join(a, DSD("120000")))
		await put(path.join(a, "TEMP_20261016_120000_ABCD.wav"))
		await put(path.join(a, DSD("120001", "1_GROUP_TGT_1_SRC_2")))
		const fresh = (now - RECORDINGS_IN_PROGRESS_MS + 1000) / 1000
		await utimes(
			path.join(a, DSD("120001", "1_GROUP_TGT_1_SRC_2")),
			fresh,
			fresh,
		)
		await symlink(DSD("120000"), path.join(a, DSD("120002")))
		await mkdir(path.join(a, DSD("120003")))
		await put(path.join(a, "20261016_120004_01234_a b_TGT_1_SRC_2.wav"))
		await put(path.join(a, "20261016_120005_01234_é_TGT_1_SRC_2.wav"))
		await put(path.join(a, DSD("120006").replace(".wav", ".WAV")))
		await put(path.join(a, "..wav"))
		await symlink(DSD("120008"), path.join(a, DSD("120008")))
		await put(
			path.join(a, "20261316_120009_01234_1_UNIT_TGT_5_SRC_x.wav"),
			Buffer.from("not a wav"),
		)
		await put(path.join(c, "20261016_130000_00001_X_PRIVATE_TGT_7_SRC_8.wav"))
		await symlink(root, path.join(root, "alias"))
		await symlink(c, path.join(root, "dsdLink"))

		const s = path.join(root, "scan")
		await put(path.join(s, "dv", "d_abc", "call-1.wav"))
		await put(path.join(s, "dv", "d_abc", "bad name.wav"))
		await put(path.join(s, "dv", "d_abc", "TEMP_20261016_120000_ABCD.wav"))
		await put(path.join(s, "dv", "probe-1", "call-2.wav"))
		await symlink(path.join(s, "dv", "d_abc"), path.join(s, "dv", "d_link"))
		await put(path.join(s, "analog", "d_def", "a-1.wav"))
		await symlink(
			path.join(s, "analog", "d_def", "a-1.wav"),
			path.join(s, "analog", "d_def", "link.wav"),
		)
		await symlink("d_loop", path.join(s, "analog", "d_loop"))
		await put(path.join(s, "analog", "d_locked", "x.wav"))
		const locked = path.join(s, "analog", "d_locked")
		await chmod(locked, 0o000)
		restore.push(locked)

		const { logger, warn } = fakeLogger()
		return {
			now,
			warn,
			options: {
				dsdFmeDirs: () => [
					{ decoderId: "a", dir: a },
					{ decoderId: "b", dir: path.join(root, "alias", "dsdA") },
					{ decoderId: "c", dir: c },
					{ decoderId: "l", dir: path.join(root, "dsdLink") },
					{ decoderId: "m", dir: path.join(root, "missing") },
				],
				scannerRecordingsDir: () => s,
				discoveryCentreHz: id => (id === "d_abc" ? 446_000_000 : Number.NaN),
				now: () => now,
				logger,
			},
		}
	}

	it("lists only eligible recordings, resolves them, and leaves the tree untouched", async () => {
		const { options, warn } = await build()
		const before = await treeHash(root)
		const inv = createRecordingInventory(options)
		const page = await inv.list({ limit: "200" })
		const ids = page.items.map(i => i.id).sort()
		expect(ids).toEqual(
			[
				`dsd:0~${DSD("120000")}`,
				"dsd:0~20261316_120009_01234_1_UNIT_TGT_5_SRC_x.wav",
				"dsd:1~20261016_130000_00001_X_PRIVATE_TGT_7_SRC_8.wav",
				"scan:d_abc~call-1.wav",
				"scan:d_def~a-1.wav",
			].sort(),
		)
		const good = page.items.find(i => i.id === `dsd:0~${DSD("120000")}`)
		expect(good).toMatchObject({
			kind: "dsd-fme-call",
			decoderId: "a",
			discoveryId: null,
			startedAtLocal: "2026-10-16T12:00:00",
			bytes: 16_044,
			durationMs: 1000,
			callType: "group",
			talkgroup: "100",
			source: "2001",
			frequencyHz: null,
		})
		const badDate = page.items.find(i => i.id.includes("20261316"))
		expect(badDate).toMatchObject({
			startedAtLocal: null,
			durationMs: null,
			callType: "unit",
			talkgroup: "5",
			source: null,
		})
		expect(page.items.find(i => i.id.startsWith("dsd:1~"))?.decoderId).toBe("c")
		expect(
			page.items.find(i => i.id === "scan:d_abc~call-1.wav"),
		).toMatchObject({
			kind: "scanner-dv",
			decoderId: null,
			discoveryId: "d_abc",
			frequencyHz: 446_000_000,
			durationMs: 1000,
			startedAtLocal: null,
			callType: null,
		})
		expect(
			page.items.find(i => i.id === "scan:d_def~a-1.wav")?.frequencyHz,
		).toBeNull()
		expect(page.items.find(i => i.id === "scan:d_def~a-1.wav")?.kind).toBe(
			"scanner-analog",
		)

		for (const item of page.items) {
			const p = await inv.resolve(item.id)
			expect(p).not.toBeNull()
			expect(path.isAbsolute(p ?? "")).toBe(true)
		}
		for (const id of [
			`dsd:0~${DSD("120001", "1_GROUP_TGT_1_SRC_2")}`, // fresh
			`dsd:0~${DSD("120002")}`, // symlinked file
			`dsd:0~${DSD("120003")}`, // directory
			`dsd:0~${DSD("120008")}`, // loop
			`dsd:0~${DSD("125959")}`, // absent
			`dsd:2~${DSD("120000")}`, // index past the source list
			"dsd:3~20261016_130000_00001_X_PRIVATE_TGT_7_SRC_8.wav",
			"scan:d_link~call-1.wav", // symlinked discovery folder
			"scan:d_def~link.wav",
			"scan:d_loop~x.wav",
			"scan:d_locked~x.wav",
		])
			expect(await inv.resolve(id)).toBeNull()

		if (process.getuid?.() !== 0) {
			expect(warn).toHaveBeenCalledTimes(1)
			const [fields, text] = warn.mock.calls[0] as [
				Record<string, unknown>,
				string,
			]
			expect(fields["dirErrors"]).toBe(1)
			expect(text).toBe("Recordings inventory scan skipped entries")
			expect(JSON.stringify(warn.mock.calls)).not.toContain(root)
			expect(JSON.stringify(warn.mock.calls)).not.toContain("d_locked")
		}
		expect(await treeHash(root)).toBe(before)
	})

	it("refuses a file replaced by a symlink between list and resolve", async () => {
		const { options } = await build()
		const inv = createRecordingInventory(options)
		const page = await inv.list({})
		const id = "dsd:1~20261016_130000_00001_X_PRIVATE_TGT_7_SRC_8.wav"
		expect(page.items.some(i => i.id === id)).toBe(true)
		const file = path.join(root, "dsdC", id.slice("dsd:1~".length))
		await unlink(file)
		await symlink(path.join(root, "dsdA", DSD("120000")), file)
		expect(await inv.resolve(id)).toBeNull()
	})

	it("does not enter a symlinked dv folder or a symlinked scanner root", async () => {
		const { options } = await build()
		const s2 = path.join(root, "scan2")
		await mkdir(s2)
		await symlink(path.join(root, "scan", "dv"), path.join(s2, "dv"))
		const inv = createRecordingInventory({
			...options,
			dsdFmeDirs: () => [],
			scannerRecordingsDir: () => s2,
		})
		expect((await inv.list({})).items).toEqual([])
		expect(await inv.resolve("scan:d_abc~call-1.wav")).toBeNull()
		const inv2 = createRecordingInventory({
			...options,
			dsdFmeDirs: () => [],
			scannerRecordingsDir: () => path.join(root, "scanLink"),
		})
		await symlink(path.join(root, "scan"), path.join(root, "scanLink"))
		expect((await inv2.list({})).items).toEqual([])
		expect(await inv2.resolve("scan:d_abc~call-1.wav")).toBeNull()
	})

	it("handles a null scanner dir and missing directories", async () => {
		const { logger, warn } = fakeLogger()
		const inv = createRecordingInventory({
			dsdFmeDirs: () => [{ decoderId: "a", dir: "/nonexistent/wk-rec/x" }],
			scannerRecordingsDir: () => null,
			logger,
		})
		const page = await inv.list(undefined)
		expect(page).toMatchObject({ items: [], scannedFiles: 0, truncated: false })
		expect(warn).not.toHaveBeenCalled()
		const inv2 = createRecordingInventory({
			dsdFmeDirs: () => [],
			scannerRecordingsDir: () => "/nonexistent/wk-rec/scan",
			logger,
		})
		expect((await inv2.list({})).items).toEqual([])
	})
})

// ---------------------------------------------------------------------------------------------
// Ids and races (fake fs)

describe("recordings inventory ids", () => {
	it("refuses bad ids before any filesystem call", async () => {
		const fs = new FakeFs().file(`/r/dsd/${DSD("120000")}`, OLD)
		const inv = fakeInventory(fs)
		for (const id of REFUSED) expect(await inv.resolve(id)).toBeNull()
		expect(await inv.resolve(42 as unknown as string)).toBeNull()
		expect(fs.calls).toBe(0)
	})

	it("refuses traversal shapes and an index past the list", async () => {
		const fs = new FakeFs()
			.file(`/r/dsd/${DSD("120000")}`, OLD)
			.file("/r/scan/dv/d_abc/call-1.wav", OLD)
		const inv = fakeInventory(fs)
		expect(await inv.resolve(`dsd:0~${DSD("120000")}`)).toBe(
			`/r/dsd/${DSD("120000")}`,
		)
		expect(await inv.resolve("scan:d_abc~call-1.wav")).toBe(
			"/r/scan/dv/d_abc/call-1.wav",
		)
		expect(await inv.resolve(`dsd:1~${DSD("120000")}`)).toBeNull()
		expect(
			await inv.resolve(`dsd:0~20261016_120000_01234_.._TGT_1_SRC_..wav`),
		).toBeNull()
		expect(await inv.resolve("scan:d_abc~..wav")).toBeNull()
		expect(await inv.resolve("scan:d_abc~...wav")).toBeNull()
	})

	it("skips a file deleted between readdir and lstat, without a warning", async () => {
		const fs = new FakeFs()
			.file(`/r/dsd/${DSD("120000")}`, OLD)
			.file(`/r/dsd/${DSD("120001")}`, OLD)
		fs.afterReaddir = dir => {
			if (dir === "/r/dsd") fs.nodes.delete(`/r/dsd/${DSD("120001")}`)
		}
		const { logger, warn } = fakeLogger()
		const page = await fakeInventory(fs, { logger }).list({})
		expect(page.items.map(i => i.id)).toEqual([`dsd:0~${DSD("120000")}`])
		expect(page.scannedFiles).toBe(2)
		expect(warn).not.toHaveBeenCalled()
	})

	it("drops a file that becomes a symlink between lstat and open", async () => {
		const fs = new FakeFs().file(`/r/dsd/${DSD("120000")}`, OLD)
		const orig = fs.lstat.bind(fs)
		fs.lstat = async p => {
			const st = await orig(p)
			if (p.endsWith(".wav")) fs.nodes.set(p, { t: "link" })
			return st
		}
		expect((await fakeInventory(fs).list({})).items).toEqual([])
	})

	it("gives a shared directory to the first decoder only", async () => {
		const fs = new FakeFs()
			.file(`/r/dsd/${DSD("120000")}`, OLD)
			.dir("/r/alias")
			.file(`/r/dsd2/${DSD("120001")}`, OLD)
		fs.real.set("/r/alias", "/r/dsd")
		const inv = fakeInventory(fs, {
			dsdFmeDirs: () => [
				{ decoderId: "a", dir: "/r/dsd" },
				{ decoderId: "b", dir: "/r/alias" },
				{ decoderId: "c", dir: "/r/dsd2" },
			],
		})
		const page = await inv.list({})
		expect(page.items.map(i => [i.id, i.decoderId]).sort()).toEqual([
			[`dsd:0~${DSD("120000")}`, "a"],
			[`dsd:1~${DSD("120001")}`, "c"],
		])
		expect(await inv.resolve(`dsd:1~${DSD("120001")}`)).toBe(
			`/r/dsd2/${DSD("120001")}`,
		)
	})

	it("counts a throwing centre lookup and source callbacks, logging no path", async () => {
		const fs = new FakeFs().file("/r/scan/dv/d_abc/c.wav", OLD)
		const { logger, warn } = fakeLogger()
		const page = await fakeInventory(fs, {
			logger,
			dsdFmeDirs: () => {
				throw new Error("/secret/dir")
			},
			discoveryCentreHz: () => {
				throw new Error("/secret/lookup")
			},
		}).list({})
		expect(page.items[0]?.frequencyHz).toBeNull()
		expect(warn).toHaveBeenCalledTimes(1)
		const [fields] = warn.mock.calls[0] as [Record<string, unknown>]
		expect(fields).toMatchObject({ sourceErrors: 1, lookupErrors: 1 })
		expect(JSON.stringify(warn.mock.calls)).not.toContain("secret")
	})

	it("refuses an invalid query with fixed text", async () => {
		const inv = fakeInventory(new FakeFs())
		for (const q of [
			{ limit: "10abc" },
			{ evil: "/etc" },
			"x",
			{ kind: "x" },
		]) {
			const err = await inv.list(q).catch((e: unknown) => e)
			expect(err).toBeInstanceOf(RecordingInventoryError)
			expect((err as RecordingInventoryError).code).toBe(
				"RECORDINGS_QUERY_INVALID",
			)
			expect((err as Error).message).toBe("Invalid recordings query")
		}
	})
})

// ---------------------------------------------------------------------------------------------
// Bounds and caches (fake fs)

function manyFiles(n: number, mtimeMs = OLD): FakeFs {
	const fs = new FakeFs().dir("/r/dsd")
	for (let i = 0; i < n; i++) {
		const t = String(100000 + i).padStart(6, "0")
		fs.file(`/r/dsd/20261016_${t}_01234_1_GROUP_TGT_1_SRC_2.wav`, mtimeMs)
	}
	return fs
}

describe("recordings inventory bounds", () => {
	it("examines at most 2000 names", async () => {
		const at = await fakeInventory(manyFiles(RECORDINGS_SCAN_MAX_FILES)).list(
			{},
		)
		expect(at).toMatchObject({ scannedFiles: 2000, truncated: false })
		const over = await fakeInventory(
			manyFiles(RECORDINGS_SCAN_MAX_FILES + 1),
		).list({ limit: 200 })
		expect(over).toMatchObject({ scannedFiles: 2000, truncated: true })
		expect(over.scannedAt).toBe(new Date(NOW).toISOString())
	})

	it("keeps at most 8 fs operations in flight", async () => {
		const fs = manyFiles(120)
		fs.file("/r/scan/dv/d_a/x.wav", OLD).file("/r/scan/analog/d_b/y.wav", OLD)
		for (let i = 0; i < 30; i++) fs.file(`/r/scan/dv/d_${i}x/z.wav`, OLD)
		fs.delayMs = 1
		const page = await fakeInventory(fs).list({ limit: 200 })
		expect(page.items).toHaveLength(152)
		expect(fs.maxActive).toBeLessThanOrEqual(RECORDINGS_SCAN_CONCURRENCY)
		expect(fs.maxActive).toBeGreaterThan(1)
	})

	it("reads one window of at most 4096 bytes per uncached header", async () => {
		const fs = new FakeFs().file(
			`/r/dsd/${DSD("120000")}`,
			OLD,
			new Uint8Array(wav(20_000)),
		)
		const page = await fakeInventory(fs).list({})
		expect(page.items[0]?.durationMs).toBe(1250)
		expect(fs.readLengths).toEqual([RECORDINGS_HEADER_READ_BYTES])
	})

	it("caches headers by path, size and mtime", async () => {
		let now = NOW
		const fs = new FakeFs().file(`/r/dsd/${DSD("120000")}`, OLD)
		const inv = fakeInventory(fs, { now: () => now })
		await inv.list({})
		expect(fs.opens).toBe(1)
		now += 3000
		await inv.list({})
		expect(fs.opens).toBe(1)
		fs.file(`/r/dsd/${DSD("120000")}`, OLD + 1)
		now += 3000
		await inv.list({})
		expect(fs.opens).toBe(2)
		fs.file(`/r/dsd/${DSD("120000")}`, OLD + 1, new Uint8Array(wav(8000)))
		now += 3000
		expect((await inv.list({})).items[0]?.durationMs).toBe(500)
		expect(fs.opens).toBe(3)
	})

	it("bounds the header cache at 4096 entries, oldest dropped", async () => {
		let now = NOW
		const fs = manyFiles(2000, OLD)
		const inv = fakeInventory(fs, { now: () => now })
		const setAll = (m: number): void => {
			for (const n of fs.nodes.values()) if (n.t === "file") n.mtimeMs = m
		}
		for (const m of [OLD, OLD - 1, OLD - 2]) {
			setAll(m)
			await inv.list({})
			now += 3000
		}
		expect(fs.opens).toBe(6000)
		await inv.list({}) // OLD - 2: cached
		expect(fs.opens).toBe(6000)
		now += 3000
		setAll(OLD - 1) // entries 2000..3999: still cached
		await inv.list({})
		expect(fs.opens).toBe(6000)
		now += 3000
		setAll(OLD) // 1904 of these were evicted
		await inv.list({})
		expect(fs.opens).toBe(6000 + 6000 - 4096)
	})

	it("shares one scan between concurrent lists and caches it for 2 s", async () => {
		let now = NOW
		const fs = manyFiles(10)
		fs.delayMs = 1
		const inv = fakeInventory(fs, { now: () => now })
		const [a, b] = await Promise.all([inv.list({}), inv.list({ limit: 2 })])
		expect(a.items).toHaveLength(10)
		expect(b.items).toHaveLength(2)
		expect(fs.readdirs).toBe(1)
		now += 1999
		await inv.list({})
		expect(fs.readdirs).toBe(1)
		now += 1
		await inv.list({})
		expect(fs.readdirs).toBe(2)
		now -= 10_000 // clock stepped back: rescan
		await inv.list({})
		expect(fs.readdirs).toBe(3)
	})

	it("re-reads sources on every scan", async () => {
		let now = NOW
		let dirs = [{ decoderId: "a", dir: "/r/dsd" }]
		const fs = manyFiles(1).file(`/r/dsd2/${DSD("120000")}`, OLD)
		const inv = fakeInventory(fs, { now: () => now, dsdFmeDirs: () => dirs })
		expect((await inv.list({})).items).toHaveLength(1)
		dirs = [...dirs, { decoderId: "b", dir: "/r/dsd2" }]
		expect(await inv.resolve(`dsd:1~${DSD("120000")}`)).toBe(
			`/r/dsd2/${DSD("120000")}`,
		)
		now += 3000
		expect((await inv.list({ decoderId: "b" })).items).toHaveLength(1)
	})
})

// ---------------------------------------------------------------------------------------------
// Property 8

type Place = "dsd" | "dv" | "analog" | "probe"
type NameKind = "call" | "temp" | "upper" | "space" | "scan"
type Kind = "file" | "link" | "dir"

interface Spec {
	place: Place
	name: NameKind
	kind: Kind
	fresh: boolean
}

function nameFor(s: Spec, i: number): string {
	const t = String(100000 + i)
	switch (s.name) {
		case "call":
			return `20261016_${t}_01234_1_GROUP_TGT_${i}_SRC_2.wav`
		case "temp":
			return `TEMP_20261016_${t}_ABCD.wav`
		case "upper":
			return `20261016_${t}_01234_1_GROUP_TGT_1_SRC_2.WAV`
		case "space":
			return `20261016_${t}_01234_a b_TGT_1_SRC_2.wav`
		case "scan":
			return `rec-${i}.wav`
	}
}

describe("recordings inventory property", () => {
	it("lists exactly the eligible files and resolves them", async () => {
		// Feature: web-gaps-8, Property 8: Inventory eligibility
		// Validates: Requirements 4.2, 4.3, 4.5
		const spec = fc.record({
			place: fc.constantFrom<Place>("dsd", "dv", "analog", "probe"),
			name: fc.constantFrom<NameKind>("call", "temp", "upper", "space", "scan"),
			kind: fc.constantFrom<Kind>("file", "file", "link", "dir"),
			fresh: fc.boolean(),
		})
		await fc.assert(
			fc.asyncProperty(fc.array(spec, { maxLength: 30 }), async specs => {
				const fs = new FakeFs().dir("/r/dsd").dir("/r/scan")
				const expected = new Map<string, string>()
				const refused: string[] = []
				specs.forEach((s, i) => {
					const name = nameFor(s, i)
					const folder =
						s.place === "dsd"
							? "/r/dsd"
							: s.place === "probe"
								? "/r/scan/dv/probe-1"
								: `/r/scan/${s.place}/d_${i}`
					const p = `${folder}/${name}`
					const m = s.fresh ? NOW - RECORDINGS_IN_PROGRESS_MS + 1 : OLD
					if (s.kind === "file") fs.file(p, m)
					else if (s.kind === "link") fs.link(p)
					else fs.dir(p)
					const nameOk =
						s.place === "dsd"
							? s.name === "call"
							: s.place !== "probe" &&
								s.name !== "upper" &&
								s.name !== "space" &&
								s.name !== "temp"
					const id = s.place === "dsd" ? `dsd:0~${name}` : `scan:d_${i}~${name}`
					if (nameOk && s.kind === "file" && !s.fresh) expected.set(id, p)
					else if (s.place !== "probe") refused.push(id)
				})
				const inv = fakeInventory(fs)
				const page = await inv.list({ limit: 200 })
				expect(page.items.map(i => i.id).sort()).toEqual(
					[...expected.keys()].sort(),
				)
				for (const item of page.items) {
					expect(item.kind).toBe(
						item.id.startsWith("dsd:")
							? "dsd-fme-call"
							: expected.get(item.id)?.includes("/dv/")
								? "scanner-dv"
								: "scanner-analog",
					)
					expect(await inv.resolve(item.id)).toBe(expected.get(item.id))
				}
				for (const id of refused) expect(await inv.resolve(id)).toBeNull()
			}),
			{ numRuns: 100 },
		)
	})
})
