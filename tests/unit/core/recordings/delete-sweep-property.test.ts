import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { sweepRecordingDeleteLeftovers } from "../../../../src/core/recordings/delete-sweep.js"
import type { Logger } from "../../../../src/utils/logger.js"
import { FakeFs, ME } from "./delete-sweep-fake.js"

const quiet: Logger = (() => {
	const l: Record<string, unknown> = { info() {}, warn() {}, debug() {} }
	l["child"] = () => l
	return l as unknown as Logger
})()

const nameArb = fc.constantFrom(
	".wavekit-delete-abc123",
	".wavekit-delete-Zz9xY0",
	".wavekit-delete-abc12",
	".wavekit-delete-abc!23",
	"other",
)
const entryArb = fc.constantFrom(
	"verified",
	"a.wav",
	"b.wav",
	"recording",
	"x.txt",
)
const specArb = fc.record({
	name: nameArb,
	kind: fc.constantFrom("dir", "dir", "dir", "symlink", "file"),
	uid: fc.constantFrom(ME, ME, 0),
	mode: fc.constantFrom(0o700, 0o700, 0o750, 0o2700, 0o755),
	entries: fc.uniqueArray(entryArb, { maxLength: 5 }),
	entryKind: fc.constantFrom("file", "file", "symlink"),
	taken: fc.boolean(),
})

// Feature: web-gaps-10, Property 3: Sweep touches only provable leftovers
// Validates: Requirements 1.9
describe("Property 3: Sweep touches only provable leftovers", () => {
	it("every mutation is inside a provably-ours private directory, and nothing changes while not ready", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.array(specArb, { maxLength: 6 }),
				fc.boolean(),
				fc.boolean(),
				async (specs, ready, symlinkRoot) => {
					const fs = new FakeFs()
					if (symlinkRoot) fs.nodes.set("/r", { type: "symlink" })
					const provable = new Set<string>()
					const keepers: string[] = []
					specs.forEach((s, i) => {
						const parent = i % 2 === 0 ? "/r" : "/r/WAV"
						if (parent === "/r/WAV" && !fs.has("/r/WAV")) fs.dir("/r/WAV")
						const d = `${parent}/${s.name}`
						if (fs.has(d)) return
						if (s.kind === "dir") {
							fs.dir(d, s.uid, s.mode)
							for (const e of s.entries)
								if (s.entryKind === "symlink") fs.symlink(`${d}/${e}`)
								else fs.file(`${d}/${e}`)
							if (s.taken) fs.file(`${parent}/a.wav`)
							const ours =
								/^\.wavekit-delete-[A-Za-z0-9]{6}$/.test(s.name) &&
								s.uid === ME &&
								s.mode === 0o700 &&
								!symlinkRoot
							if (ours) provable.add(d)
							else keepers.push(d, ...s.entries.map(e => `${d}/${e}`))
						} else if (s.kind === "symlink") fs.symlink(d)
						else fs.file(d)
					})
					const before = new Map(fs.nodes)
					await sweepRecordingDeleteLeftovers({
						dsdFmeDirs: ["/r"],
						scannerRecordingsDir: null,
						protection: {
							state: () => (ready ? "ready" : "loading"),
							isProtected: () => !ready,
							isDsdFmeFileProtected: () => !ready,
							isScannerFileProtected: () => !ready,
							discoveryHoldsKept: () => !ready,
						},
						logger: quiet,
						fs,
						getuid: () => ME,
					})
					if (!ready || symlinkRoot) expect(fs.ops).toEqual([])
					for (const op of fs.ops) {
						const path = op.slice(op.indexOf(" ") + 1)
						const isRestore = op.startsWith("link ")
						const dir = isRestore
							? [...provable].find(
									d =>
										d.slice(0, d.lastIndexOf("/")) ===
										path.slice(0, path.lastIndexOf("/")),
								)
							: [...provable].find(d => path === d || path.startsWith(`${d}/`))
						expect(dir).toBeDefined()
					}
					// Nothing that is not provably ours changed, and no file was replaced.
					for (const k of keepers) expect(fs.has(k)).toBe(before.has(k))
					for (const [k, v] of before)
						if (v.type === "file" && !fs.has(k)) {
							const inProvable = [...provable].some(d => k.startsWith(`${d}/`))
							expect(inProvable).toBe(true)
						}
				},
			),
			{ numRuns: 200 },
		)
	})
})
