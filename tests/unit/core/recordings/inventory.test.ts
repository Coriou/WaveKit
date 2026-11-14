import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	readlink,
	rename,
	rm,
	symlink,
	unlink,
	utimes,
	writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { Readable } from "node:stream"
import { setTimeout as delay } from "node:timers/promises"
import fc from "fast-check"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	RECORDINGS_CATALOGUE_MAX,
	RECORDINGS_CATALOGUE_MAX_FOLDERS,
	RECORDINGS_HEADER_READ_BYTES,
	RECORDINGS_IN_PROGRESS_MS,
	RECORDINGS_SCAN_CONCURRENCY,
	RECORDINGS_SCAN_MAX_FILES,
} from "@wavekit/api-types"
import type { RecordingsChangedEventData } from "@wavekit/api-types"
import {
	RECORDINGS_ID_MAX_LENGTH,
	RecordingInventoryError,
	createRecordingInventory,
	nodeRecordingFs,
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
	| { t: "dir"; ino: number }
	| { t: "link"; ino: number }
	| { t: "fifo"; ino: number }
	| { t: "file"; size: number; mtimeMs: number; data: Uint8Array; ino: number }

let nextIno = 1

/** In-memory read-only fs behind the inventory's port, instrumented. */
class FakeFs implements RecordingFsPort {
	readonly nodes = new Map<string, FNode>()
	readonly children = new Map<string, Set<string>>()
	readonly real = new Map<string, string>()
	/** Directory mtimes (default 0). */
	readonly dirTimes = new Map<string, number>()
	calls = 0
	active = 0
	maxActive = 0
	delayMs = 0
	opens = 0
	readdirs = 0
	lstats = 0
	liveHandles = 0
	maxLiveHandles = 0
	readLengths: number[] = []
	afterReaddir: ((dir: string) => void) | null = null
	beforeOpen: ((p: string) => void) | null = null

	put(p: string, node: FNode): this {
		const parent = path.dirname(p)
		if (parent !== p) {
			if (!this.nodes.has(parent)) this.dir(parent)
			let set = this.children.get(parent)
			if (!set) this.children.set(parent, (set = new Set()))
			set.add(path.basename(p))
		}
		this.nodes.set(p, node)
		return this
	}

	dir(p: string): this {
		return this.put(p, { t: "dir", ino: nextIno++ })
	}

	file(p: string, mtimeMs: number, data: Uint8Array = WAV_1S): this {
		return this.put(p, {
			t: "file",
			size: data.length,
			mtimeMs,
			data,
			ino: nextIno++,
		})
	}

	link(p: string): this {
		return this.put(p, { t: "link", ino: nextIno++ })
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

	private statsOf(n: FNode, p?: string): RecordingStats {
		return {
			isFile: () => n.t === "file",
			isDirectory: () => n.t === "dir",
			isSymbolicLink: () => n.t === "link",
			size: n.t === "file" ? n.size : 0,
			mtimeMs:
				n.t === "file"
					? n.mtimeMs
					: p !== undefined
						? (this.dirTimes.get(p) ?? 0)
						: 0,
			dev: 1,
			ino: n.ino,
		}
	}

	opendir(dir: string): Promise<AsyncIterable<string>> {
		return this.step(() => {
			this.readdirs++
			const n = this.nodes.get(dir)
			if (!n) throw errno("ENOENT")
			if (n.t !== "dir") throw errno("ENOTDIR")
			const names = [...(this.children.get(dir) ?? [])]
			this.afterReaddir?.(dir)
			const step = <T>(fn: () => T): Promise<T> => this.step(fn)
			return {
				[Symbol.asyncIterator]: () => {
					let i = 0
					return {
						next: () =>
							step(
								(): IteratorResult<string> =>
									i < names.length
										? { done: false, value: names[i++] ?? "" }
										: { done: true, value: undefined },
							),
						return: () =>
							step(
								(): IteratorResult<string> => ({
									done: true,
									value: undefined,
								}),
							),
					}
				},
			}
		})
	}

	lstat(p: string): Promise<RecordingStats> {
		return this.step(() => {
			this.lstats++
			const n = this.nodes.get(p)
			if (!n) throw errno("ENOENT")
			return this.statsOf(n, p)
		})
	}

	stat(p: string): Promise<RecordingStats> {
		return this.step(() => {
			const n = this.nodes.get(this.real.get(p) ?? p)
			if (!n) throw errno("ENOENT")
			return this.statsOf(n)
		})
	}

	realpath(p: string): Promise<string> {
		return this.step(() => {
			if (!this.nodes.has(p)) throw errno("ENOENT")
			return this.real.get(p) ?? p
		})
	}

	open(p: string): Promise<RecordingFileHandle> {
		this.beforeOpen?.(p)
		return this.step(() => {
			this.opens++
			const n = this.nodes.get(p)
			if (!n) throw errno("ENOENT")
			if (n.t === "link") throw errno("ELOOP")
			if (n.t === "dir") throw errno("EISDIR")
			const data = n.t === "file" ? n.data : new Uint8Array(0)
			const stats = this.statsOf(n)
			this.liveHandles++
			this.maxLiveHandles = Math.max(this.maxLiveHandles, this.liveHandles)
			let closed = false
			return {
				read: (buf: Uint8Array, off: number, len: number, pos: number) =>
					this.step(() => {
						this.readLengths.push(len)
						const chunk = data.subarray(pos, pos + len)
						buf.set(chunk, off)
						return { bytesRead: chunk.length }
					}),
				stat: () => this.step(() => stats),
				close: () =>
					this.step(() => {
						if (!closed) this.liveHandles--
						closed = true
					}),
				createReadStream: () => Readable.from([Buffer.from(data)]),
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
		// scannedFiles counts the catalogue (the files listed), not the names examined
		expect(page.scannedFiles).toBe(1)
		expect(warn).not.toHaveBeenCalled()
	})

	it("drops a file that becomes a symlink between lstat and open", async () => {
		const fs = new FakeFs().file(`/r/dsd/${DSD("120000")}`, OLD)
		const orig = fs.lstat.bind(fs)
		fs.lstat = async p => {
			const st = await orig(p)
			if (p.endsWith(".wav")) fs.nodes.set(p, { t: "link", ino: nextIno++ })
			return st
		}
		expect((await fakeInventory(fs).list({})).items).toEqual([])
	})

	it("drops a file whose discovery folder became a symlink between enumeration and lstat", async () => {
		const file = "/r/scan/dv/d_x/call.wav"
		const fs = new FakeFs()
			.file(file, OLD)
			.file("/out/call.wav", OLD - 5, new Uint8Array(wav(8000)))
		const outside = fs.nodes.get("/out/call.wav")
		const swap = (): void => {
			if (!outside) return
			fs.nodes.set("/r/scan/dv/d_x", { t: "link", ino: nextIno++ })
			fs.nodes.set(file, outside)
			fs.real.set(file, "/out/call.wav")
		}
		const orig = fs.lstat.bind(fs)
		let armed = true
		fs.lstat = async p => {
			if (armed && p === file) {
				armed = false
				swap()
			}
			return orig(p)
		}
		const { logger, warn } = fakeLogger()
		const inv = fakeInventory(fs, { logger })
		const page = await inv.list({})
		expect(page.items).toEqual([])
		expect(warn).not.toHaveBeenCalled()
		expect(fs.liveHandles).toBe(0)
		expect(fs.readLengths).toEqual([])
		// resolve with the folder link back as a real directory but the file still escaping.
		fs.nodes.set("/r/scan/dv/d_x", { t: "dir", ino: nextIno++ })
		expect(await inv.resolve("scan:d_x~call.wav")).toBeNull()
		expect(await inv.open("scan:d_x~call.wav")).toBeNull()
		expect(fs.liveHandles).toBe(0)
	})

	it.each([
		["made fresh", NOW],
		["touched to another old mtime", OLD - 1],
	])(
		"drops a file whose mtime was %s between lstat and open",
		async (_label, m) => {
			const p = `/r/dsd/${DSD("120000")}`
			const fs = new FakeFs().file(p, OLD).file(`/r/dsd/${DSD("120001")}`, OLD)
			fs.beforeOpen = q => {
				const n = fs.nodes.get(q)
				if (q === p && n?.t === "file") n.mtimeMs = m
			}
			const page = await fakeInventory(fs).list({})
			expect(page.items.map(i => i.id)).toEqual([`dsd:0~${DSD("120001")}`])
			expect(fs.liveHandles).toBe(0)
		},
	)

	it("takes bytes and modifiedAt from the opened file's fstat", async () => {
		const fs = new FakeFs().file(`/r/dsd/${DSD("120000")}`, OLD)
		const item = (await fakeInventory(fs).list({})).items[0]
		expect(item?.bytes).toBe(WAV_1S.length)
		expect(item?.modifiedAt).toBe(new Date(OLD).toISOString())
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
		// The build counts the source error; the listing (which reads owners from memory at list
		// time) counts the lookup error.
		expect(warn).toHaveBeenCalledTimes(2)
		const fields = warn.mock.calls.map(c => c[0] as Record<string, unknown>)
		expect(fields[0]).toMatchObject({ sourceErrors: 1, lookupErrors: 0 })
		expect(fields[1]).toMatchObject({ sourceErrors: 0, lookupErrors: 1 })
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
	it("lists at most the catalogue bound, newest first, and says the oldest were left out", async () => {
		expect(RECORDINGS_CATALOGUE_MAX).toBe(50_000)
		const max = 40
		const tree = (n: number): FakeFs => {
			const fs = new FakeFs().dir("/r/dsd")
			for (let i = 0; i < n; i++) {
				const t = String(100000 + i).padStart(6, "0")
				fs.file(`/r/dsd/20261016_${t}_01234_1_GROUP_TGT_1_SRC_2.wav`, OLD + i)
			}
			return fs
		}
		const at = await fakeInventory(tree(max), { catalogueMax: max }).list({
			limit: 200,
		})
		expect(at).toMatchObject({
			scannedFiles: max,
			truncated: false,
			truncatedBefore: null,
		})
		const overFs = tree(max + 1)
		const overInv = fakeInventory(overFs, { catalogueMax: max })
		const over = await overInv.list({ limit: 200 })
		expect(over).toMatchObject({ scannedFiles: max, truncated: true })
		// Only the oldest file (OLD + 0) is left out.
		expect(over.truncatedBefore).toBe(new Date(OLD).toISOString())
		expect(over.items.map(i => i.modifiedAt)).toEqual(
			Array.from({ length: max }, (_, k) =>
				new Date(OLD + max - k).toISOString(),
			),
		)
		expect(over.counts?.total).toBe(max)
		// A full re-read keeps the left-out file out without opening it again.
		const opens = overFs.opens
		overInv.invalidate?.()
		const again = await overInv.list({ limit: 200 })
		expect(again).toMatchObject({ scannedFiles: max, truncated: true })
		expect(overFs.opens).toBe(opens)
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

	// The catalogue re-opens a file only when its lstat identity (dev, ino, size, mtime) changed.
	it("re-reads a header only when the file changed", async () => {
		const fs = new FakeFs().file(`/r/dsd/${DSD("120000")}`, OLD)
		const inv = fakeInventory(fs)
		await inv.list({})
		expect(fs.readLengths.length).toBe(1)
		inv.invalidate?.()
		await inv.list({})
		expect(fs.readLengths.length).toBe(1)
		fs.file(`/r/dsd/${DSD("120000")}`, OLD + 1)
		inv.invalidate?.()
		await inv.list({})
		expect(fs.readLengths.length).toBe(2)
		fs.file(`/r/dsd/${DSD("120000")}`, OLD + 1, new Uint8Array(wav(8000)))
		inv.invalidate?.()
		expect((await inv.list({})).items[0]?.durationMs).toBe(500)
		expect(fs.readLengths.length).toBe(3)
	})

	it("shares the first build between concurrent lists; a warm list makes no fs call", async () => {
		let now = NOW
		const fs = manyFiles(10)
		fs.delayMs = 1
		const inv = fakeInventory(fs, { now: () => now })
		const [a, b] = await Promise.all([inv.list({}), inv.list({ limit: 2 })])
		expect(a.items).toHaveLength(10)
		expect(b.items).toHaveLength(2)
		expect(fs.readdirs).toBe(1)
		const calls = fs.calls
		now += 60_000
		await inv.list({})
		now -= 120_000 // clock stepped back
		await inv.list({ limit: 3 })
		expect(fs.calls).toBe(calls)
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

// ---------------------------------------------------------------------------------------------
// Adversarial review fixes: handle verification, FIFOs, budgets, id length

/** A dsd-fme call name giving an id of exactly `idLength` characters at index 0. */
function dsdNameForIdLength(idLength: number): string {
	const head = "20261016_120000_01234_"
	const tail = "_GROUP_TGT_1_SRC_2.wav"
	return (
		head +
		"a".repeat(idLength - "dsd:0~".length - head.length - tail.length) +
		tail
	)
}

describe("recordings inventory handle bounds and budgets", () => {
	it("keeps at most 8 live handles and 8 fs operations in flight at 2000 files", async () => {
		const fs = manyFiles(RECORDINGS_SCAN_MAX_FILES)
		const page = await fakeInventory(fs).list({ limit: 200 })
		expect(page).toMatchObject({ scannedFiles: 2000, truncated: false })
		expect(fs.opens).toBe(2000)
		expect(fs.liveHandles).toBe(0)
		expect(fs.maxLiveHandles).toBeLessThanOrEqual(RECORDINGS_SCAN_CONCURRENCY)
		expect(fs.maxLiveHandles).toBeGreaterThan(1)
		expect(fs.maxActive).toBeLessThanOrEqual(RECORDINGS_SCAN_CONCURRENCY)
	})

	it("enters at most the folder bound, newest directory change first", async () => {
		expect(RECORDINGS_CATALOGUE_MAX_FOLDERS).toBe(20_000)
		const max = 30
		const tree = (n: number): FakeFs => {
			const fs = new FakeFs().dir("/r/dsd").dir("/r/scan/dv")
			for (let i = 0; i < n; i++) {
				const d = `/r/scan/dv/d_${String(i).padStart(5, "0")}`
				fs.file(`${d}/x.wav`, OLD + i)
				// a directory's mtime is its last entry change
				fs.dirTimes.set(d, OLD + i)
			}
			return fs
		}
		const at = await fakeInventory(tree(max), {
			catalogueMaxFolders: max,
		}).list({ limit: 200 })
		expect(at).toMatchObject({ scannedFiles: max, truncated: false })
		const over = await fakeInventory(tree(max + 1), {
			catalogueMaxFolders: max,
		}).list({ limit: 200 })
		expect(over).toMatchObject({ scannedFiles: max, truncated: true })
		// The folder changed least recently is the one left out.
		expect(over.items.map(i => i.discoveryId)).not.toContain("d_00000")
		expect(over.items[0]?.discoveryId).toBe(`d_${String(max).padStart(5, "0")}`)
	})

	it("reads at most twice the catalogue bound of names per folder", async () => {
		const max = 10
		const tree = (n: number): FakeFs => {
			const fs = new FakeFs().dir("/r/dsd").file(`/r/dsd/${DSD("000000")}`, OLD)
			for (let i = 1; i < n; i++)
				fs.file(`/r/dsd/x${i}.txt`, OLD, new Uint8Array(0))
			return fs
		}
		const at = await fakeInventory(tree(2 * max), { catalogueMax: max }).list(
			{},
		)
		expect(at).toMatchObject({ scannedFiles: 1, truncated: false })
		const over = await fakeInventory(tree(2 * max + 1), {
			catalogueMax: max,
		}).list({})
		expect(over.truncated).toBe(true)
	})

	it("drops a FIFO or another file swapped in between lstat and open", async () => {
		for (const swap of ["fifo", "file"] as const) {
			const p = `/r/dsd/${DSD("120000")}`
			const fs = new FakeFs().file(p, OLD).file(`/r/dsd/${DSD("120001")}`, OLD)
			fs.beforeOpen = q => {
				if (q !== p) return
				if (swap === "fifo") fs.nodes.set(q, { t: "fifo", ino: nextIno++ })
				else fs.file(q, OLD)
			}
			const page = await fakeInventory(fs).list({})
			expect(page.items.map(i => i.id)).toEqual([`dsd:0~${DSD("120001")}`])
			expect(fs.readLengths).toHaveLength(1)
			expect(fs.liveHandles).toBe(0)
		}
	})

	it("lists ids up to 100 characters, counts and refuses longer ones without fs calls", async () => {
		expect(RECORDINGS_ID_MAX_LENGTH).toBe(100)
		const n100 = dsdNameForIdLength(100)
		const n101 = dsdNameForIdLength(101)
		expect(`dsd:0~${n100}`).toHaveLength(100)
		const fs = new FakeFs()
			.file(`/r/dsd/${n100}`, OLD)
			.file(`/r/dsd/${n101}`, OLD)
		const { logger, warn } = fakeLogger()
		const inv = fakeInventory(fs, { logger })
		const page = await inv.list({ limit: 1 })
		expect(page.items.map(i => i.id)).toEqual([`dsd:0~${n100}`])
		expect(page.scannedFiles).toBe(1)
		expect(warn).toHaveBeenCalledTimes(1)
		expect((warn.mock.calls[0] as [Record<string, unknown>])[0]).toMatchObject({
			longIds: 1,
		})
		expect(JSON.stringify(warn.mock.calls)).not.toContain("aaaa")
		expect(await inv.resolve(`dsd:0~${n100}`)).toBe(`/r/dsd/${n100}`)
		const calls = fs.calls
		expect(await inv.resolve(`dsd:0~${n101}`)).toBeNull()
		expect(await inv.open(`dsd:0~${n101}`)).toBeNull()
		expect(fs.calls).toBe(calls)
	})

	it("opens a verified handle and refuses a fresh file swapped in before the open", async () => {
		const p = `/r/dsd/${DSD("120000")}`
		const fs = new FakeFs().file(p, OLD)
		const inv = fakeInventory(fs)
		const opened = await inv.open(`dsd:0~${DSD("120000")}`)
		expect(opened?.name).toBe(DSD("120000"))
		await opened?.handle.close()
		fs.beforeOpen = () => fs.file(p, NOW)
		// resolve opens and verifies too: the fresh replacement is refused.
		expect(await inv.resolve(`dsd:0~${DSD("120000")}`)).toBeNull()
		expect(await inv.open(`dsd:0~${DSD("120000")}`)).toBeNull()
		expect(fs.liveHandles).toBe(0)
	})
})

describe("recordings inventory open on the real filesystem", () => {
	let root = ""

	afterEach(async () => {
		if (root) await rm(root, { recursive: true, force: true })
		root = ""
	})

	async function setup(): Promise<{
		now: number
		scan: string
		dsd: string
		outside: string
		put: (p: string, data?: Buffer, fresh?: boolean) => Promise<void>
	}> {
		root = await mkdtemp(path.join(tmpdir(), "wk-rec-open-"))
		const now = Date.now() + 60_000
		const put = async (
			p: string,
			data: Buffer = wav(16_000),
			fresh = false,
		): Promise<void> => {
			await mkdir(path.dirname(p), { recursive: true })
			await writeFile(p, data)
			const t = (fresh ? now : now - 30_000) / 1000
			await utimes(p, t, t)
		}
		const scan = path.join(root, "scan")
		const dsd = path.join(root, "dsd")
		const outside = path.join(root, "outside")
		await put(path.join(scan, "dv", "d_x", "call.wav"))
		await put(path.join(dsd, DSD("120000")))
		await put(path.join(outside, "call.wav"), Buffer.from("SECRET-OUTSIDE"))
		return { now, scan, dsd, outside, put }
	}

	function inventoryOver(
		s: Awaited<ReturnType<typeof setup>>,
		fs: RecordingFsPort = nodeRecordingFs,
	): ReturnType<typeof createRecordingInventory> {
		return createRecordingInventory({
			dsdFmeDirs: () => [{ decoderId: "a", dir: s.dsd }],
			scannerRecordingsDir: () => s.scan,
			now: () => s.now,
			logger: fakeLogger().logger,
			fs,
		})
	}

	async function readAll(h: RecordingFileHandle): Promise<Buffer> {
		const chunks: Buffer[] = []
		for await (const c of h.createReadStream({ autoClose: true }))
			chunks.push(Buffer.from(c as Uint8Array))
		return Buffer.concat(chunks)
	}

	it("streams an eligible file through the verified handle", async () => {
		const s = await setup()
		const opened = await inventoryOver(s).open("scan:d_x~call.wav")
		expect(opened?.name).toBe("call.wav")
		const bytes = await readAll(opened?.handle as RecordingFileHandle)
		expect(bytes.equals(wav(16_000))).toBe(true)
	})

	it("refuses a discovery folder swapped for a symlink to an outside directory before the open", async () => {
		const s = await setup()
		const folder = path.join(s.scan, "dv", "d_x")
		let swapped = false
		const fs: RecordingFsPort = {
			...nodeRecordingFs,
			open: async (p, flags) => {
				if (!swapped && p === path.join(folder, "call.wav")) {
					swapped = true
					await rename(folder, `${folder}-orig`)
					await symlink(s.outside, folder)
				}
				return nodeRecordingFs.open(p, flags)
			},
		}
		const before = await treeHash(s.outside)
		expect(await inventoryOver(s, fs).open("scan:d_x~call.wav")).toBeNull()
		expect(swapped).toBe(true)
		// O_NOFOLLOW alone would have opened the outside file: the handle checks refuse it.
		const raw = await nodeRecordingFs.open(path.join(folder, "call.wav"), 0)
		await raw.close()
		expect(await treeHash(s.outside)).toBe(before)
	})

	it("refuses a FIFO, directly and swapped in between lstat and open", async ctx => {
		const s = await setup()
		const fifo = path.join(s.dsd, DSD("120001"))
		try {
			execFileSync("mkfifo", [fifo])
		} catch {
			ctx.skip()
			return
		}
		const inv = inventoryOver(s)
		const page = await inv.list({})
		expect(page.items.map(i => i.id)).not.toContain(`dsd:0~${DSD("120001")}`)
		expect(await inv.resolve(`dsd:0~${DSD("120001")}`)).toBeNull()
		expect(await inv.open(`dsd:0~${DSD("120001")}`)).toBeNull()

		const target = path.join(s.dsd, DSD("120000"))
		const swapIn = async (): Promise<void> => {
			await unlink(target)
			execFileSync("mkfifo", [target])
		}
		let armed = true
		const fs: RecordingFsPort = {
			...nodeRecordingFs,
			open: async (p, flags) => {
				if (armed && p === target) {
					armed = false
					await swapIn()
				}
				return nodeRecordingFs.open(p, flags)
			},
		}
		const swapped = await inventoryOver(s, fs).list({})
		expect(swapped.items.map(i => i.id)).toEqual(["scan:d_x~call.wav"])

		await unlink(target)
		await s.put(target)
		armed = true
		expect(await inventoryOver(s, fs).open(`dsd:0~${DSD("120000")}`)).toBeNull()
	}, 5_000)

	it("lists nothing and resolves null when the discovery folder becomes a symlink between enumeration and lstat", async () => {
		const s = await setup()
		const folder = path.join(s.scan, "dv", "d_x")
		const file = path.join(folder, "call.wav")
		let swapped = false
		const fs: RecordingFsPort = {
			...nodeRecordingFs,
			lstat: async p => {
				if (!swapped && p === file) {
					swapped = true
					await rename(folder, `${folder}-orig`)
					await symlink(s.outside, folder)
				}
				return nodeRecordingFs.lstat(p)
			},
		}
		const before = await treeHash(s.outside)
		const inv = inventoryOver(s, fs)
		const page = await inv.list({})
		expect(swapped).toBe(true)
		expect(page.items.map(i => i.id)).toEqual([`dsd:0~${DSD("120000")}`])
		expect(await inv.resolve("scan:d_x~call.wav")).toBeNull()
		expect(await inv.open("scan:d_x~call.wav")).toBeNull()
		expect(await treeHash(s.outside)).toBe(before)
	})

	it("refuses a file made fresh after resolve", async () => {
		const s = await setup()
		const inv = inventoryOver(s)
		const id = `dsd:0~${DSD("120000")}`
		const target = path.join(s.dsd, DSD("120000"))
		expect(await inv.resolve(id)).toBe(target)
		await unlink(target)
		await s.put(target, wav(16_000), true)
		expect(await inv.open(id)).toBeNull()
	})
})

describe("recordings inventory scanner kinds", () => {
	it("resolves a dv recording when the analog folder cannot be read", async () => {
		const fs = new FakeFs()
			.file("/r/scan/dv/d_x/call.wav", OLD)
			.dir("/r/scan/analog")
		const lstat = fs.lstat.bind(fs)
		fs.lstat = async (p: string) => {
			if (p === "/r/scan/analog")
				throw Object.assign(new Error("denied"), { code: "EACCES" })
			return await lstat(p)
		}
		const inventory = fakeInventory(fs)
		expect(await inventory.resolve("scan:d_x~call.wav")).toBe(
			"/r/scan/dv/d_x/call.wav",
		)
		const opened = await inventory.open("scan:d_x~call.wav")
		expect(opened?.name).toBe("call.wav")
		await opened?.handle.close()
	})
})

// ---------------------------------------------------------------------------------------------
// WG9 lane RK: golden of today's items (captured from the frozen WG8 code), protection and
// invalidation

describe("recordings inventory WG9 kept and invalidate", () => {
	let root = ""

	afterEach(async () => {
		if (root) await rm(root, { recursive: true, force: true })
		root = ""
	})

	const MTIME_S = 1_792_000_000
	const NOW = MTIME_S * 1000 + 60_000

	async function setup(): Promise<{ dsd: string; scan: string }> {
		root = await mkdtemp(path.join(tmpdir(), "wk-rec-kept-"))
		const dsd = path.join(root, "dsd")
		const scan = path.join(root, "scan")
		const put = async (p: string): Promise<void> => {
			await mkdir(path.dirname(p), { recursive: true })
			await writeFile(p, wav(16_000))
			await utimes(p, MTIME_S, MTIME_S)
		}
		await put(path.join(dsd, DSD("120000")))
		await put(path.join(scan, "dv", "d_x", "call.wav"))
		return { dsd, scan }
	}

	function over(
		s: { dsd: string; scan: string },
		extra: Partial<RecordingInventoryOptions> = {},
	): ReturnType<typeof createRecordingInventory> {
		return createRecordingInventory({
			dsdFmeDirs: () => [{ decoderId: "a", dir: s.dsd }],
			scannerRecordingsDir: () => s.scan,
			discoveryCentreHz: () => 446_000_000,
			now: () => NOW,
			logger: fakeLogger().logger,
			...extra,
		})
	}

	const GOLDEN = [
		{
			id: `dsd:0~${DSD("120000")}`,
			kind: "dsd-fme-call",
			decoderId: "a",
			discoveryId: null,
			startedAtLocal: "2026-10-16T12:00:00",
			modifiedAt: new Date(MTIME_S * 1000).toISOString(),
			bytes: 16_044,
			durationMs: 1000,
			callType: "group",
			talkgroup: "100",
			source: "2001",
			frequencyHz: null,
			key: `dsd~${DSD("120000")}`,
			ownerDiscoveryId: null,
		},
		{
			id: "scan:d_x~call.wav",
			kind: "scanner-dv",
			decoderId: null,
			discoveryId: "d_x",
			startedAtLocal: null,
			modifiedAt: new Date(MTIME_S * 1000).toISOString(),
			bytes: 16_044,
			durationMs: 1000,
			callType: null,
			talkgroup: null,
			source: null,
			frequencyHz: 446_000_000,
			key: "scan:d_x~call.wav",
			ownerDiscoveryId: null,
		},
	]

	it("without protection lists the items exactly (golden, no kept property)", async () => {
		const page = await over(await setup()).list({})
		const items = [...page.items].sort((a, b) => a.id.localeCompare(b.id))
		expect(items).toStrictEqual(GOLDEN)
		for (const item of items) expect(Object.hasOwn(item, "kept")).toBe(false)
		expect(JSON.stringify(items)).toBe(JSON.stringify(GOLDEN))
	})

	it("with protection marks each item kept from the port at list time (fail closed)", async () => {
		const kept = new Set<string>()
		let ready = true
		const asked: string[] = []
		const protection = {
			isProtected: (k: string) => {
				asked.push(k)
				return !ready || kept.has(k)
			},
			isDsdFmeFileProtected: () => true,
			isScannerFileProtected: () => true,
			discoveryHoldsKept: () => true,
		}
		const inv = over(await setup(), { protection })
		const keptOf = async () =>
			Object.fromEntries((await inv.list({})).items.map(i => [i.id, i.kept]))
		expect(await keptOf()).toEqual({
			[GOLDEN[0]?.id ?? ""]: false,
			[GOLDEN[1]?.id ?? ""]: false,
		})
		// Keys, never inventory ids or paths: the dsd index is not part of the key.
		expect(asked.sort()).toEqual([`dsd~${DSD("120000")}`, "scan:d_x~call.wav"])
		kept.add("scan:d_x~call.wav")
		expect((await keptOf())["scan:d_x~call.wav"]).toBe(true)
		ready = false
		expect(Object.values(await keptOf())).toEqual([true, true])
		const page = await inv.list({})
		for (const item of page.items) {
			const { kept: _k, ...rest } = item
			expect(GOLDEN).toContainEqual(rest)
		}
	})

	it("invalidate drops the 2 s listing cache, including a scan already in flight", async () => {
		const s = await setup()
		const inv = over(s)
		expect((await inv.list({})).items).toHaveLength(2)
		await rm(path.join(s.dsd, DSD("120000")))
		expect((await inv.list({})).items).toHaveLength(2)
		inv.invalidate?.()
		expect((await inv.list({})).items).toHaveLength(1)
		const inflight = inv.list({})
		await rm(path.join(s.scan, "dv", "d_x", "call.wav"))
		inv.invalidate?.()
		await inflight
		expect((await inv.list({})).items).toHaveLength(0)
	})

	it("open returns the opened path and the verified fstat additively", async () => {
		const s = await setup()
		const opened = await over(s).open(`dsd:0~${DSD("120000")}`)
		expect(opened?.name).toBe(DSD("120000"))
		expect(opened?.path).toBe(path.join(s.dsd, DSD("120000")))
		const st = await lstat(path.join(s.dsd, DSD("120000")))
		expect(opened?.stat.ino).toBe(st.ino)
		expect(opened?.stat.dev).toBe(st.dev)
		expect(opened?.stat.size).toBe(16_044)
		await opened?.handle.close()
	})
})

// ---------------------------------------------------------------------------------------------
// The catalogue: newest first whatever the walk order, memory-only listings, writers

/** Every page of a listing, following nextCursor. */
async function allPages(
	inv: ReturnType<typeof createRecordingInventory>,
	query: Record<string, unknown> = {},
): Promise<string[]> {
	const ids: string[] = []
	let cursor: string | null = null
	for (let n = 0; n < 1000; n++) {
		const page = await inv.list({
			limit: 200,
			...query,
			...(cursor !== null ? { cursor } : {}),
		})
		ids.push(...page.items.map(i => i.id))
		cursor = page.nextCursor
		if (cursor === null) break
	}
	return ids
}

/**
 * `folders` discovery folders under dv, `perFolder` files each. Folder ids ascend in walk order
 * and so do the files' mtimes: the newest recordings sort last in directory order.
 */
function scannerTree(folders: number, perFolder: number): FakeFs {
	const fs = new FakeFs().dir("/r/dsd").dir("/r/scan/dv")
	let k = 0
	for (let f = 0; f < folders; f++) {
		const d = `/r/scan/dv/d_${String(f).padStart(5, "0")}`
		for (let i = 0; i < perFolder; i++) fs.file(`${d}/r-${i}.wav`, OLD + k++)
		fs.dirTimes.set(d, OLD + k)
	}
	return fs
}

describe("recordings catalogue", () => {
	it("lists the newest recordings first past 2000 files, and every file exactly once across pages", async () => {
		const fs = scannerTree(300, 8) // 2400 files
		const inv = fakeInventory(fs)
		const first = await inv.list({ limit: 50 })
		expect(first.truncated).toBe(false)
		expect(first.scannedFiles).toBe(2400)
		expect(first.items[0]?.id).toBe("scan:d_00299~r-7.wav")
		expect(first.items[0]?.modifiedAt).toBe(new Date(OLD + 2399).toISOString())
		const ids = await allPages(inv)
		expect(ids).toHaveLength(2400)
		expect(new Set(ids).size).toBe(2400)
		expect(ids[ids.length - 1]).toBe("scan:d_00000~r-0.wav")
	})

	it("at 10 000 recordings, warm listings, filters and pages make no fs call", async () => {
		const fs = scannerTree(1500, 7) // 10 500 files
		fs.file(`/r/dsd/${DSD("120000")}`, OLD)
		const inv = fakeInventory(fs, { discoveryCentreHz: () => 446_006_250 })
		expect((await inv.list({})).scannedFiles).toBe(10_501)
		const calls = fs.calls
		await allPages(inv)
		await inv.list({ kind: "dsd-fme-call" })
		await inv.list({ minHz: "446000000", maxHz: "446100000", q: "446.006" })
		await inv.list({ discoveryId: "d_00042", kept: "false" })
		expect(fs.calls).toBe(calls)
	})

	it("answers from a partial first build, marked indexing, with the newest folders first", async () => {
		const fs = scannerTree(60, 8)
		fs.delayMs = 2
		const inv = fakeInventory(fs)
		const t0 = performance.now()
		const page = await inv.list({ limit: 5 })
		expect(performance.now() - t0).toBeLessThan(5_000)
		expect(page.indexing).toBe(true)
		expect(page.scannedFiles).toBeLessThan(480)
		expect(page.items[0]?.discoveryId).toBe("d_00059")
		await inv.start?.()
		const done = await inv.list({ limit: 5 })
		expect(done.indexing).toBe(false)
		expect(done.scannedFiles).toBe(480)
	})

	it("filters server side and counts the whole catalogue", async () => {
		const fs = new FakeFs()
			.file(`/r/dsd/${DSD("120000", "1_GROUP_TGT_446_SRC_2001")}`, OLD + 3)
			.file(`/r/dsd/${DSD("120001", "1_GROUP_TGT_9_SRC_446")}`, OLD + 2)
			.file("/r/scan/analog/d_01K446ZZ/analog-4466.wav", OLD + 1)
			.file("/r/scan/dv/d_B/call.wav", OLD)
		const owner: Record<string, { id: string; frequencyHz: number }> = {
			d_01K446ZZ: { id: "d_B", frequencyHz: 466_012_500 },
			d_B: { id: "d_B", frequencyHz: 466_012_500 },
		}
		const kept = new Set([`dsd~${DSD("120000", "1_GROUP_TGT_446_SRC_2001")}`])
		const inv = fakeInventory(fs, {
			discoveryOwner: id => owner[id] ?? null,
			protection: {
				isProtected: k => kept.has(k),
				isDsdFmeFileProtected: () => true,
				isScannerFileProtected: () => true,
				discoveryHoldsKept: () => true,
			},
		})
		const ids = async (q: Record<string, unknown>): Promise<string[]> =>
			(await inv.list(q)).items.map(i => i.id)
		const all = await inv.list({})
		expect(all.counts).toEqual({
			total: 4,
			kept: 1,
			bytes: 4 * WAV_1S.length,
			byKind: { "dsd-fme-call": 2, "scanner-dv": 1, "scanner-analog": 1 },
		})
		expect(all.items.find(i => i.kind === "scanner-analog")).toMatchObject({
			discoveryId: "d_01K446ZZ",
			ownerDiscoveryId: "d_B",
			frequencyHz: 466_012_500,
		})
		// "446" is in a talkgroup and a radio id, in the analog folder id and file name (never
		// searched) and in no frequency: only the two calls match.
		expect(await ids({ q: "446" })).toEqual([
			`dsd:0~${DSD("120000", "1_GROUP_TGT_446_SRC_2001")}`,
			`dsd:0~${DSD("120001", "1_GROUP_TGT_9_SRC_446")}`,
		])
		expect(await ids({ q: "466.0125" })).toHaveLength(2)
		expect(await ids({ talkgroup: "446" })).toHaveLength(1)
		expect(await ids({ source: "446" })).toHaveLength(1)
		expect(await ids({ kept: "true" })).toHaveLength(1)
		expect(await ids({ kept: "false" })).toHaveLength(3)
		// a discovery matches its own folder and the folders it owns through merge aliases
		expect(await ids({ discoveryId: "d_B" })).toEqual([
			"scan:d_01K446ZZ~analog-4466.wav",
			"scan:d_B~call.wav",
		])
		expect(await ids({ discoveryId: "d_01K446ZZ" })).toHaveLength(2)
		expect(await ids({ minHz: 466_000_000, maxHz: 466_100_000 })).toHaveLength(
			2,
		)
		expect(await ids({ maxHz: 400_000_000 })).toEqual([])
		expect(
			await ids({
				since: new Date(OLD + 1).toISOString(),
				until: new Date(OLD + 2).toISOString(),
			}),
		).toHaveLength(2)
		const filtered = await inv.list({ kind: "dsd-fme-call", limit: 1 })
		expect(filtered.matched).toBe(2)
		expect(filtered.counts?.total).toBe(4)
		expect(filtered.nextCursor).not.toBeNull()
		for (const bad of [
			{ kept: "yes" },
			{ discoveryId: "probe-1" },
			{ talkgroup: "9a" },
			{ minHz: "-1" },
			{ since: "2026-11-14" },
			{ q: "" },
			{ q: "x".repeat(65) },
		])
			await expect(inv.list(bad)).rejects.toBeInstanceOf(
				RecordingInventoryError,
			)
	})

	it("invalidate(id) re-checks only that file, and the next listing waits for it", async () => {
		const name = DSD("120000")
		const fs = manyFiles(50).file(`/r/dsd/${name}`, OLD)
		const inv = fakeInventory(fs)
		expect((await inv.list({})).scannedFiles).toBe(51)
		fs.nodes.delete(`/r/dsd/${name}`)
		fs.children.get("/r/dsd")?.delete(name)
		const before = fs.calls
		const rev = (await inv.list({})).revision ?? 0
		inv.invalidate?.(`dsd:0~${name}`)
		const page = await inv.list({ limit: 200 })
		expect(page.scannedFiles).toBe(50)
		expect(page.items.map(i => i.id)).not.toContain(`dsd:0~${name}`)
		expect(page.revision).toBeGreaterThan(rev)
		// the dsd directory check and one lstat: never a rescan
		expect(fs.calls - before).toBeLessThanOrEqual(3)
	})

	it("lists a file still being written once it settled, by the injected clock", async () => {
		let now = NOW
		const name = DSD("120000")
		const fs = new FakeFs().file(`/r/dsd/${name}`, NOW - 1_000)
		const inv = fakeInventory(fs, { now: () => now })
		expect((await inv.list({})).items).toHaveLength(0)
		now += RECORDINGS_IN_PROGRESS_MS - 2_000
		expect((await inv.list({})).items).toHaveLength(0)
		now += 1_000
		expect((await inv.list({})).items.map(i => i.id)).toEqual([`dsd:0~${name}`])
	})

	it("re-indexes a touched discovery and announces changes as counts only", async () => {
		const fs = new FakeFs().dir("/r/dsd").file("/r/scan/dv/d_A/one.wav", OLD)
		const inv = fakeInventory(fs)
		const events: RecordingsChangedEventData[] = []
		inv.onChange?.(e => events.push(e))
		await inv.start?.()
		fs.file("/r/scan/dv/d_A/two.wav", OLD + 1).file(
			"/r/scan/analog/d_N/three.wav",
			OLD + 2,
		)
		await inv.touchDiscoveries?.(["d_A", "d_N", "../x"])
		const page = await inv.list({})
		expect(page.items.map(i => i.id)).toEqual([
			"scan:d_N~three.wav",
			"scan:d_A~two.wav",
			"scan:d_A~one.wav",
		])
		await vi.waitFor(
			() => expect(events.at(-1)?.revision).toBe(page.revision),
			{ timeout: 3_000 },
		)
		const last = events.at(-1)
		expect(Object.keys(last ?? {}).sort()).toEqual([
			"added",
			"changed",
			"indexing",
			"removed",
			"revision",
		])
		expect(events.reduce((n, e) => n + e.added, 0)).toBe(3)
		inv.close?.()
	})

	it("drops a whole folder that became a symlink at the next re-index", async () => {
		const fs = new FakeFs()
			.dir("/r/dsd")
			.file("/r/scan/dv/d_A/one.wav", OLD)
			.file("/r/scan/dv/d_B/two.wav", OLD)
		const inv = fakeInventory(fs)
		expect((await inv.list({})).items).toHaveLength(2)
		fs.link("/r/scan/dv/d_A")
		await inv.touchDiscoveries?.(["d_A"])
		expect((await inv.list({})).items.map(i => i.id)).toEqual([
			"scan:d_B~two.wav",
		])
	})
})
