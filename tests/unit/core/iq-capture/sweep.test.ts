import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import fc from "fast-check"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
	captureDirIdentitySync,
	ensureCaptureDir,
	openVerifiedCaptureSync,
} from "../../../../src/core/iq-capture/fs-guard.js"
import {
	isSweepable,
	sweepCaptureDir,
	type SweepFs,
} from "../../../../src/core/iq-capture/sweep.js"

const UID = process.getuid?.() ?? 0
const ID = "0f8fad5b-d9cb-469f-a165-70867728950e"
let base: string

beforeAll(async () => {
	base = fs.realpathSync(await fsp.mkdtemp(path.join(tmpdir(), "iqcap-sweep-")))
})
afterAll(async () => {
	await fsp.rm(base, { recursive: true, force: true })
})

let n = 0
async function freshRoot(): Promise<string> {
	const root = path.join(base, `r${n++}`)
	await fsp.mkdir(root)
	return root
}

describe("ensureCaptureDir", () => {
	it("creates iq-captures with mode 0700", async () => {
		const root = await freshRoot()
		const got = await ensureCaptureDir(root, UID)
		expect(got).toEqual({ dir: path.join(root, "iq-captures") })
		expect(fs.statSync(path.join(root, "iq-captures")).mode & 0o777).toBe(0o700)
	})
	it("refuses a symlinked directory", async () => {
		const root = await freshRoot()
		const target = await freshRoot()
		await fsp.chmod(target, 0o700)
		await fsp.symlink(target, path.join(root, "iq-captures"))
		expect(await ensureCaptureDir(root, UID)).toEqual({ refused: "symlink" })
	})
	it("refuses a symlinked root", async () => {
		const root = await freshRoot()
		const link = path.join(base, `link${n++}`)
		await fsp.symlink(root, link)
		expect(await ensureCaptureDir(link, UID)).toEqual({ refused: "symlink" })
	})
	it("refuses a file, a group-accessible dir and a foreign owner", async () => {
		const r1 = await freshRoot()
		await fsp.writeFile(path.join(r1, "iq-captures"), "")
		expect(await ensureCaptureDir(r1, UID)).toEqual({
			refused: "not-directory",
		})
		const r2 = await freshRoot()
		await fsp.mkdir(path.join(r2, "iq-captures"), { mode: 0o750 })
		await fsp.chmod(path.join(r2, "iq-captures"), 0o750)
		expect(await ensureCaptureDir(r2, UID)).toEqual({ refused: "mode" })
		const r3 = await freshRoot()
		expect(await ensureCaptureDir(r3, UID + 1)).toEqual({
			refused: "not-owner",
		})
		expect(await ensureCaptureDir(await freshRoot(), null)).toEqual({
			refused: "not-owner",
		})
	})
	it("refuses a relative root", async () => {
		expect(await ensureCaptureDir("relative/dir", UID)).toEqual({
			refused: "root-invalid",
		})
	})
})

describe("openVerifiedCaptureSync", () => {
	async function dirWith() {
		const root = await freshRoot()
		const got = await ensureCaptureDir(root, UID)
		if (!("dir" in got)) throw new Error("dir")
		return { root, dir: got.dir }
	}
	it("opens a proven file and refuses every unproven one", async () => {
		const { root, dir } = await dirWith()
		const file = path.join(dir, `${ID}.cf32`)
		await fsp.writeFile(file, Buffer.alloc(80), { mode: 0o600 })
		const ok = openVerifiedCaptureSync(root, file, 80, UID)
		expect(ok?.size).toBe(80)
		if (ok) fs.closeSync(ok.fd)
		// wrong expected size, foreign uid, mode, not multiple of 8, symlink, directory
		expect(openVerifiedCaptureSync(root, file, 88, UID)).toBeNull()
		expect(openVerifiedCaptureSync(root, file, 80, UID + 1)).toBeNull()
		await fsp.chmod(file, 0o640)
		expect(openVerifiedCaptureSync(root, file, 80, UID)).toBeNull()
		await fsp.chmod(file, 0o600)
		const odd = path.join(dir, "odd.cf32")
		await fsp.writeFile(odd, Buffer.alloc(81), { mode: 0o600 })
		expect(openVerifiedCaptureSync(root, odd, null, UID)).toBeNull()
		const link = path.join(
			dir,
			`${"1".repeat(8)}-0000-4000-8000-000000000000.cf32`,
		)
		await fsp.symlink(file, link)
		expect(openVerifiedCaptureSync(root, link, null, UID)).toBeNull()
		const big = path.join(dir, "big.cf32")
		await fsp.writeFile(big, Buffer.alloc(1_536_008), { mode: 0o600 })
		expect(openVerifiedCaptureSync(root, big, null, UID)).toBeNull()
		expect(openVerifiedCaptureSync(root, dir, null, UID)).toBeNull()
		expect(
			openVerifiedCaptureSync(root, path.join(root, "..", "x.cf32"), null, UID),
		).toBeNull()
	})
	it("refuses when an ancestor became a symlink", async () => {
		const { root, dir } = await dirWith()
		const file = path.join(dir, `${ID}.cf32`)
		await fsp.writeFile(file, Buffer.alloc(8), { mode: 0o600 })
		const moved = `${dir}-real`
		await fsp.rename(dir, moved)
		await fsp.symlink(moved, dir)
		expect(openVerifiedCaptureSync(root, file, 8, UID)).toBeNull()
	})
})

// Feature: web-gaps-11, Property 13: Sweep touches only provable captures
// Validates: Requirements 6.4, 6.7
describe("Property 13: sweep touches only provable captures", () => {
	const hex = fc.constantFrom(..."0123456789abcdef".split(""))
	const hexs = (k: number) =>
		fc.array(hex, { minLength: k, maxLength: k }).map(a => a.join(""))
	const uuid = fc
		.tuple(
			hexs(8),
			hexs(4),
			hexs(3),
			fc.constantFrom("8", "9", "a", "b"),
			hexs(3),
			hexs(12),
		)
		.map(([a, b, c, v, d, e]) => `${a}-${b}-4${c}-${v}${d}-${e}`)
	const name = fc.oneof(
		uuid.map(u => `${u}.cf32`),
		uuid.map(u => `${u}.cf32.tmp`),
		uuid.map(u => `${u.toUpperCase()}.cf32`),
		uuid.map(u => `${u}.cf32.bak`),
		uuid,
		fc
			.stringMatching(/^[a-zA-Z0-9._-]{1,20}$/)
			.filter(s => s !== "." && s !== ".."),
	)
	const kind = fc.constantFrom("file", "dir", "symlink", "dangling")
	const entries = fc.uniqueArray(
		fc.record({ name, kind, foreign: fc.boolean() }),
		{ selector: e => e.name, maxLength: 6 },
	)

	it("removes only regular grammar files owned by this uid", async () => {
		await fc.assert(
			fc.asyncProperty(entries, async list => {
				const root = await freshRoot()
				const got = await ensureCaptureDir(root, UID)
				if (!("dir" in got)) throw new Error("dir")
				const dir = got.dir
				const outside = path.join(root, "outside.cf32")
				await fsp.writeFile(outside, "keep")
				const foreign = new Set<string>()
				for (const e of list) {
					const p = path.join(dir, e.name)
					if (e.kind === "file") await fsp.writeFile(p, "x", { mode: 0o600 })
					else if (e.kind === "dir") await fsp.mkdir(p)
					else if (e.kind === "symlink") await fsp.symlink(outside, p)
					else await fsp.symlink(path.join(root, "nope"), p)
					if (e.foreign) foreign.add(e.name)
				}
				// Owner variation through an lstat fake over the real one.
				const io: SweepFs = {
					readdir: d => fsp.readdir(d),
					lstat: async f => {
						const st = await fsp.lstat(f)
						return {
							isFile: () => st.isFile(),
							isSymbolicLink: () => st.isSymbolicLink(),
							uid: foreign.has(path.basename(f)) ? UID + 1 : st.uid,
						}
					},
					unlink: f => fsp.unlink(f),
				}
				const result = await sweepCaptureDir(dir, { uid: UID, fs: io })
				const left = new Set(await fsp.readdir(dir))
				let removed = 0
				for (const e of list) {
					const shouldGo =
						e.kind === "file" && !e.foreign && isSweepable(e.name)
					expect(left.has(e.name)).toBe(!shouldGo)
					if (shouldGo) removed++
				}
				expect(result.removed).toBe(removed)
				expect(result.left).toBe(list.length - removed)
				expect(await fsp.readFile(outside, "utf8")).toBe("keep")
				await fsp.rm(root, { recursive: true, force: true })
			}),
			{ numRuns: 100 },
		)
	}, 30_000)

	it("removes nothing when the uid is unknown", async () => {
		const root = await freshRoot()
		const got = await ensureCaptureDir(root, UID)
		if (!("dir" in got)) throw new Error("dir")
		await fsp.writeFile(path.join(got.dir, `${ID}.cf32`), "x")
		expect(await sweepCaptureDir(got.dir, { uid: null })).toEqual({
			removed: 0,
			left: 1,
			failed: 0,
		})
	})
})

describe("sweep re-proves the directory before each unlink (review BLOCKING)", () => {
	it("a directory swapped for a symlink after the listing deletes nothing outside", async () => {
		const root = await freshRoot()
		const got = await ensureCaptureDir(root, UID)
		const dir = "dir" in got ? got.dir : ""
		await fsp.writeFile(path.join(dir, `${ID}.cf32`), "x", { mode: 0o600 })
		const outside = path.join(base, `outside-${n++}`)
		await fsp.mkdir(outside, { mode: 0o700 })
		const victim = path.join(outside, `${ID}.cf32`)
		await fsp.writeFile(victim, "must stay", { mode: 0o600 })
		const identity = captureDirIdentitySync(root, dir)
		expect(identity).not.toBeNull()
		const io: SweepFs = {
			readdir: async d => {
				const names = await fsp.readdir(d)
				await fsp.rename(dir, `${dir}.old`)
				await fsp.symlink(outside, dir)
				return names
			},
			lstat: f => fsp.lstat(f),
			unlink: f => fsp.unlink(f),
		}
		const res = await sweepCaptureDir(dir, {
			uid: UID,
			fs: io,
			guard: { root, identity: identity! },
		})
		expect(fs.existsSync(victim)).toBe(true)
		expect(res.removed).toBe(0)
		expect(res.refused).toBe(true)
	})
})
