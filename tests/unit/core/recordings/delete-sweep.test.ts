import { describe, expect, it } from "vitest"
import { sweepRecordingDeleteLeftovers } from "../../../../src/core/recordings/delete-sweep.js"
import type { RecordingProtection } from "../../../../src/core/recordings/contract.js"
import type { Logger } from "../../../../src/utils/logger.js"
import { FakeFs, ME, P } from "./delete-sweep-fake.js"

function logger() {
	const calls: Array<[string, unknown, string | undefined]> = []
	const mk = (level: string) => (a: unknown, b?: string) =>
		calls.push([level, a, b])
	const l: Record<string, unknown> = {
		info: mk("info"),
		warn: mk("warn"),
		debug: mk("debug"),
	}
	l["child"] = () => l
	return { log: l as unknown as Logger, calls }
}

export function protection(ready = true): RecordingProtection & {
	state: () => "ready" | "loading"
} {
	return {
		state: () => (ready ? "ready" : "loading"),
		isProtected: () => !ready,
		isDsdFmeFileProtected: () => !ready,
		isScannerFileProtected: () => !ready,
		discoveryHoldsKept: () => !ready,
	}
}

function run(
	fs: FakeFs,
	over: {
		ready?: boolean
		getuid?: (() => number) | undefined
		dsd?: string[]
		scan?: string | null
	} = {},
) {
	const { log, calls } = logger()
	const p = sweepRecordingDeleteLeftovers({
		dsdFmeDirs: over.dsd ?? ["/r"],
		scannerRecordingsDir: over.scan ?? null,
		protection: protection(over.ready ?? true),
		logger: log,
		fs,
		getuid: "getuid" in over ? over.getuid : () => ME,
	})
	return { p, calls }
}

describe("sweepRecordingDeleteLeftovers (WG10 req 1.9)", () => {
	it("unlinks a verified file", async () => {
		const fs = new FakeFs()
		const d = fs.priv("/r", P, ["verified"])
		const { p } = run(fs)
		expect(await p).toEqual({
			found: 1,
			deleted: 1,
			restored: 0,
			removedEmpty: 0,
			left: 0,
		})
		expect(fs.has(`${d}/verified`)).toBe(false)
		expect(fs.has("/r/verified")).toBe(false)
	})

	it("restores a single recording-named entry under its name", async () => {
		const fs = new FakeFs()
		fs.priv("/r", P, ["20260101_101010_12345_x.wav"])
		const res = await run(fs).p
		expect(res.restored).toBe(1)
		expect(fs.has("/r/20260101_101010_12345_x.wav")).toBe(true)
		expect(fs.has(`/r/${P}`)).toBe(false)
	})

	it("a taken name is left, never replaced", async () => {
		const fs = new FakeFs()
		fs.file("/r/a.wav")
		const d = fs.priv("/r", P, ["a.wav"])
		const res = await run(fs).p
		expect(res).toMatchObject({ restored: 0, left: 1 })
		expect(fs.has(`${d}/a.wav`)).toBe(true)
		expect(fs.ops).toEqual([])
	})

	it("removes an empty directory", async () => {
		const fs = new FakeFs()
		fs.priv("/r", P, [])
		expect((await run(fs).p).removedEmpty).toBe(1)
		expect(fs.has(`/r/${P}`)).toBe(false)
	})

	it("sweeps the WAV folder and scanner discovery folders", async () => {
		const fs = new FakeFs()
		fs.dir("/r/WAV")
		fs.priv("/r/WAV", P, ["verified"])
		fs.dir("/s")
		fs.dir("/s/d_abc")
		fs.priv("/s/d_abc", P, ["b.wav"])
		fs.dir("/s/probe-1")
		fs.priv("/s/probe-1", P, ["verified"])
		const res = await run(fs, { scan: "/s" }).p
		expect(res).toMatchObject({ found: 2, deleted: 1, restored: 1 })
		expect(fs.has(`/s/probe-1/${P}/verified`)).toBe(true)
	})

	it("sweeps a lowercase wav folder too (Main, rk2 review minor 4)", async () => {
		const fs = new FakeFs()
		fs.dir("/r/wav")
		fs.priv("/r/wav", P, ["verified"])
		const res = await run(fs).p
		expect(res).toMatchObject({ found: 1, deleted: 1 })
		expect(fs.has(`/r/wav/${P}`)).toBe(false)
	})

	it("WAV and wav naming one directory (case-insensitive disk) are listed once", async () => {
		class CaseFs extends FakeFs {
			private fold = (p: string): string => p.replace("/r/wav", "/r/WAV")
			override lstat(path: string) {
				return super.lstat(this.fold(path))
			}
			override readdir(path: string, limit: number) {
				return super.readdir(this.fold(path), limit)
			}
		}
		const fs = new CaseFs()
		fs.dir("/r/WAV")
		fs.priv("/r/WAV", P, ["verified"])
		const res = await run(fs).p
		expect(res).toMatchObject({ found: 1, deleted: 1, left: 0 })
		expect(fs.ops).toEqual([`unlink /r/WAV/${P}/verified`, `rmdir /r/WAV/${P}`])
	})

	describe("refusals leave everything in place and count left", () => {
		const cases: Array<[string, (fs: FakeFs) => void]> = [
			[
				"a name that is not ours",
				fs => void fs.priv("/r", ".wavekit-delete-abc12", ["verified"]),
			],
			[
				"a longer random part",
				fs => void fs.priv("/r", ".wavekit-delete-abc1234", ["verified"]),
			],
			["a symlink at the directory", fs => void fs.symlink(`/r/${P}`)],
			["another owner", fs => void fs.priv("/r", P, ["verified"], 0o700, 0)],
			["mode 0750", fs => void fs.priv("/r", P, ["verified"], 0o750)],
			[
				"mode 0700 with setgid",
				fs => void fs.priv("/r", P, ["verified"], 0o2700),
			],
			["two entries", fs => void fs.priv("/r", P, ["verified", "a.wav"])],
			[
				"five entries",
				fs =>
					void fs.priv("/r", P, ["a.wav", "b.wav", "c.wav", "d.wav", "e.wav"]),
			],
			[
				"a symlink entry",
				fs => {
					const d = fs.priv("/r", P, [])
					fs.symlink(`${d}/verified`)
				},
			],
			[
				"a symlink named like a recording",
				fs => {
					const d = fs.priv("/r", P, [])
					fs.symlink(`${d}/a.wav`)
				},
			],
			["a WG9 recording entry", fs => void fs.priv("/r", P, ["recording"])],
			[
				"a group-writable parent without the sticky bit",
				fs => {
					fs.dir("/r", ME, 0o775)
					fs.priv("/r", P, ["verified"])
				},
			],
			[
				"an other-writable parent without the sticky bit",
				fs => {
					fs.dir("/r", ME, 0o757)
					fs.priv("/r", P, ["a.wav"])
				},
			],
			["another name", fs => void fs.priv("/r", P, ["notes.txt"])],
			[
				"a directory entry",
				fs => {
					const d = fs.priv("/r", P, [])
					fs.dir(`${d}/verified`)
				},
			],
		]
		for (const [name, build] of cases)
			it(name, async () => {
				const fs = new FakeFs()
				build(fs)
				const before = [...fs.nodes.keys()].sort()
				await run(fs).p
				expect(fs.ops).toEqual([])
				expect([...fs.nodes.keys()].sort()).toEqual(before)
			})

		it("counts a refused directory as left", async () => {
			const fs = new FakeFs()
			fs.priv("/r", P, ["verified"], 0o750)
			expect(await run(fs).p).toEqual({
				found: 1,
				deleted: 0,
				restored: 0,
				removedEmpty: 0,
				left: 1,
			})
		})

		it("a writable parent is counted left; a sticky one is swept", async () => {
			const fs = new FakeFs()
			fs.dir("/r", ME, 0o777)
			fs.priv("/r", P, ["verified"])
			expect(await run(fs).p).toMatchObject({ found: 1, deleted: 0, left: 1 })
			fs.dir("/r", ME, 0o1777)
			expect(await run(fs).p).toMatchObject({ found: 1, deleted: 1, left: 0 })
		})

		it("a symlinked WAV folder is not entered", async () => {
			const fs = new FakeFs()
			fs.symlink("/r/WAV")
			fs.priv("/r/WAV", P, ["verified"])
			await run(fs).p
			expect(fs.ops).toEqual([])
		})

		it("a symlinked configured root is not entered", async () => {
			const fs = new FakeFs()
			fs.nodes.set("/r", { type: "symlink" })
			fs.priv("/r", P, ["verified"])
			await run(fs).p
			expect(fs.ops).toEqual([])
		})

		it("a symlinked discovery folder is not entered", async () => {
			const fs = new FakeFs()
			fs.dir("/s")
			fs.symlink("/s/d_abc")
			fs.priv("/s/d_abc", P, ["verified"])
			await run(fs, { scan: "/s" }).p
			expect(fs.ops).toEqual([])
		})
	})

	it("a store that is not ready deletes and restores nothing", async () => {
		const fs = new FakeFs()
		fs.priv("/r", `${P.slice(0, -1)}1`, ["verified"])
		fs.priv("/r", `${P.slice(0, -1)}2`, ["a.wav"])
		fs.priv("/r", `${P.slice(0, -1)}3`, [])
		const res = await run(fs, { ready: false }).p
		expect(res).toMatchObject({
			found: 3,
			deleted: 0,
			restored: 0,
			removedEmpty: 0,
			left: 3,
		})
		expect(fs.ops).toEqual([])
	})

	it("a protection without state is judged by the probe (fail closed)", async () => {
		const fs = new FakeFs()
		fs.priv("/r", P, ["verified"])
		const { log } = logger()
		const bare = { ...protection(false) } as Partial<
			ReturnType<typeof protection>
		>
		delete bare.state
		const res = await sweepRecordingDeleteLeftovers({
			dsdFmeDirs: ["/r"],
			scannerRecordingsDir: null,
			protection: bare as RecordingProtection,
			logger: log,
			fs,
			getuid: () => ME,
		})
		expect(res.deleted).toBe(0)
		expect(fs.ops).toEqual([])
	})

	it("a throwing protection is not ready", async () => {
		const fs = new FakeFs()
		fs.priv("/r", P, ["verified"])
		const { log } = logger()
		const res = await sweepRecordingDeleteLeftovers({
			dsdFmeDirs: ["/r"],
			scannerRecordingsDir: null,
			protection: {
				...protection(true),
				isScannerFileProtected: () => {
					throw new Error("x")
				},
			},
			logger: log,
			fs,
			getuid: () => ME,
		})
		expect(res.deleted).toBe(0)
	})

	it("acts on nothing without getuid", async () => {
		const fs = new FakeFs()
		fs.priv("/r", P, ["verified"])
		const res = await run(fs, { getuid: () => Number.NaN }).p
		expect(res).toEqual({
			found: 0,
			deleted: 0,
			restored: 0,
			removedEmpty: 0,
			left: 0,
		})
		expect(fs.ops).toEqual([])
		const fs2 = new FakeFs()
		fs2.priv("/r", P, ["verified"])
		const orig = Object.getOwnPropertyDescriptor(process, "getuid")
		Object.defineProperty(process, "getuid", {
			value: undefined,
			configurable: true,
		})
		try {
			const { log } = logger()
			const r = await sweepRecordingDeleteLeftovers({
				dsdFmeDirs: ["/r"],
				scannerRecordingsDir: null,
				protection: protection(),
				logger: log,
				fs: fs2,
			})
			expect(r.found).toBe(0)
			expect(fs2.ops).toEqual([])
		} finally {
			if (orig) Object.defineProperty(process, "getuid", orig)
		}
	})

	it("acts on 64 directories and counts the 65th as left", async () => {
		for (const n of [64, 65]) {
			const fs = new FakeFs()
			for (let i = 0; i < n; i++)
				fs.priv("/r", `.wavekit-delete-${String(i).padStart(6, "0")}`, [
					"verified",
				])
			const res = await run(fs).p
			expect(res.found).toBe(n)
			expect(res.deleted).toBe(64)
			expect(res.left).toBe(n - 64)
		}
	})

	it("lists at most 4096 entries per directory", async () => {
		const fs = new FakeFs()
		for (let i = 0; i < 4096; i++) fs.file(`/r/f${i}`)
		fs.priv("/r", P, ["verified"])
		const res = await run(fs).p
		expect(res.found).toBe(0)
	})

	it("an fs that throws counts, logs fixed text and never rejects", async () => {
		for (const op of ["lstat", "readdir", "unlink", "rmdir", "link"]) {
			const fs = new FakeFs()
			fs.priv("/r", P, ["verified"])
			fs.priv("/r", `${P.slice(0, -1)}9`, ["a.wav"])
			fs.priv("/r", `${P.slice(0, -1)}8`, [])
			fs.throwOn = op
			const { p, calls } = run(fs)
			await expect(p).resolves.toBeDefined()
			const text = JSON.stringify(calls)
			expect(text).not.toContain("/r")
			expect(text).not.toContain("verified")
			expect(text).not.toContain("a.wav")
		}
	})

	it("logs one info line with counts only", async () => {
		const fs = new FakeFs()
		fs.priv("/r", P, ["verified"])
		const { p, calls } = run(fs)
		await p
		const infos = calls.filter(c => c[0] === "info")
		expect(infos).toHaveLength(1)
		expect(infos[0]?.[1]).toMatchObject({ found: 1, deleted: 1, errors: 0 })
		expect(JSON.stringify(calls)).not.toContain(P)
	})
})
