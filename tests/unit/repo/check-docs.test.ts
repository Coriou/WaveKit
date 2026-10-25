/**
 * The documentation checker (scripts/check-docs.mjs): link extraction, broken links in the
 * user docs, and the code-to-page map that flags stale pages.
 */
import { execFileSync } from "node:child_process"
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

import {
	brokenLinks,
	checkFreshness,
	commitsInRange,
	linkTargets,
	parseTrailers,
	resolveBase,
	splitZ,
	stalePages,
	userDocs,
} from "../../../scripts/check-docs.mjs"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")

const MAP = {
	entries: [
		{ code: ["web/src/features/"], docs: ["docs/WEB-APP.md"] },
		{ code: ["src/api/routes/"], docs: ["docs/API.md"] },
	],
}

describe("check-docs", () => {
	it("finds Markdown and HTML targets, not those in code", () => {
		const text = [
			'[a](docs/A.md) ![b](img/b.png "title") <img src="c.svg">',
			"`[not](this.md)`",
			"```",
			"[nor](that.md)",
			"```",
		].join("\n")
		expect(linkTargets(text)).toEqual(["docs/A.md", "img/b.png", "c.svg"])
	})

	it("finds no broken link in the user docs", () => {
		const broken = userDocs(root).flatMap(f =>
			brokenLinks(f, root).map(t => `${f}: ${t}`),
		)
		expect(broken).toEqual([])
	})

	it("flags mapped code that changed without its page", () => {
		const changed = [
			"web/src/features/map/engine.ts",
			"src/api/routes/x.ts",
			"docs/API.md",
		]
		expect(stalePages(changed, MAP)).toEqual([
			{ docs: ["docs/WEB-APP.md"], code: ["web/src/features/map/engine.ts"] },
		])
	})

	it("accepts a Docs: none trailer, or one that names the page", () => {
		const file = "web/src/features/map/engine.ts"
		const none = [{ files: [file], trailers: ["none"] }]
		const named = [{ files: [file], trailers: ["docs/WEB-APP.md"] }]
		expect(stalePages([file], MAP, none)).toEqual([])
		expect(stalePages([file], MAP, named)).toEqual([])
	})

	it("lets a trailer excuse only its own commit's files", () => {
		const a = "web/src/features/map/engine.ts"
		const b = "web/src/features/activity/rows.ts"
		const commits = [
			{ files: [a], trailers: ["none"] },
			{ files: [a, b], trailers: [] },
		]
		expect(stalePages([a, b], MAP, commits)).toEqual([
			{ docs: ["docs/WEB-APP.md"], code: [a, b] },
		])
		expect(
			stalePages([a], MAP, [
				{ files: [a], trailers: ["none"] },
				{ files: [b], trailers: [] },
			]),
		).toEqual([])
	})

	it("gives a file to the entry with the longest matching prefix", () => {
		const map = {
			entries: [
				{ code: ["src/core/"], docs: ["docs/ARCHITECTURE.md"] },
				{ code: ["src/core/scanner/"], docs: ["docs/SCANNER.md"] },
			],
		}
		expect(stalePages(["src/core/scanner/a.ts"], map)).toEqual([
			{ docs: ["docs/SCANNER.md"], code: ["src/core/scanner/a.ts"] },
		])
		expect(
			stalePages(["src/core/scanner/a.ts", "docs/SCANNER.md"], map),
		).toEqual([])
	})

	it("splits NUL-delimited names without trimming them", () => {
		expect(splitZ(" lead.ts\0trail.ts \0a b.ts\0")).toEqual([
			" lead.ts",
			"trail.ts ",
			"a b.ts",
		])
		expect(parseTrailers("none\0docs/API.md, docs/CLI.md\n")).toEqual([
			"none",
			"docs/API.md",
			"docs/CLI.md",
		])
	})

	it("maps only pages that exist", () => {
		const map = JSON.parse(
			readFileSync(join(root, "docs/doc-map.json"), "utf8"),
		) as {
			entries: { code: string[]; docs: string[] }[]
		}
		for (const e of map.entries)
			for (const p of e.docs) expect(existsSync(join(root, p)), p).toBe(true)
	})
})

const MAP_REPO = {
	entries: [{ code: ["src/"], docs: ["docs/PAGE.md"] }],
}

describe(
	"check-docs page freshness in a git history",
	{ timeout: 30_000 },
	() => {
		const dirs: string[] = []
		afterEach(() => {
			for (const d of dirs.splice(0))
				rmSync(d, { recursive: true, force: true })
		})

		function repo(): {
			dir: string
			git: (...args: string[]) => string
			write: (path: string, text: string) => void
			commit: (message: string, ...paths: string[]) => string
		} {
			const dir = mkdtempSync(join(tmpdir(), "check-docs-"))
			dirs.push(dir)
			const git = (...args: string[]): string =>
				execFileSync("git", args, {
					cwd: dir,
					encoding: "utf8",
					stdio: ["ignore", "pipe", "pipe"],
				}).trim()
			const write = (path: string, text: string): void => {
				mkdirSync(dirname(join(dir, path)), { recursive: true })
				writeFileSync(join(dir, path), text)
			}
			const commit = (message: string, ...paths: string[]): string => {
				git("add", "--", ...paths)
				git("commit", "-q", "-m", message)
				return git("rev-parse", "HEAD")
			}
			git("init", "-q", "-b", "main")
			git("config", "user.email", "test@example.invalid")
			git("config", "user.name", "Test")
			git("config", "commit.gpgsign", "false")
			write("docs/PAGE.md", "page\n")
			write("src/a.ts", "a\n")
			commit("init", "docs/PAGE.md", "src/a.ts")
			return { dir, git, write, commit }
		}

		it("fails a change without its page and accepts the trailers", () => {
			const r = repo()
			const base = r.git("rev-parse", "HEAD")
			r.write("src/a.ts", "a2\n")
			r.commit("change", "src/a.ts")
			expect(checkFreshness(base, MAP_REPO, r.dir).stale).toEqual([
				{ docs: ["docs/PAGE.md"], code: ["src/a.ts"] },
			])
			r.write("src/b.ts", "b\n")
			r.commit("refactor\n\nDocs: none", "src/b.ts")
			r.write("src/c.ts", "c\n")
			r.commit("covered\n\nDocs: docs/PAGE.md", "src/c.ts")
			const mid = r.git("rev-parse", "HEAD~2")
			expect(checkFreshness(mid, MAP_REPO, r.dir).stale).toEqual([])
			r.write("src/d.ts", "d\n")
			r.commit("wrong page\n\nDocs: docs/OTHER.md", "src/d.ts")
			expect(checkFreshness(mid, MAP_REPO, r.dir).stale).toEqual([
				{ docs: ["docs/PAGE.md"], code: ["src/d.ts"] },
			])
		})

		it("keeps leading and trailing spaces in file names", () => {
			const r = repo()
			const base = r.git("rev-parse", "HEAD")
			r.write("src/ lead.ts", "x\n")
			r.write("src/trail.ts ", "y\n")
			r.commit("odd names", "src/ lead.ts", "src/trail.ts ")
			const commits = commitsInRange(base, r.dir)
			expect(commits.map(c => c.files)).toEqual([
				["src/ lead.ts", "src/trail.ts "],
			])
			expect(checkFreshness(base, MAP_REPO, r.dir).stale).toEqual([
				{ docs: ["docs/PAGE.md"], code: ["src/ lead.ts", "src/trail.ts "] },
			])
			r.write("src/ lead.ts", "x2\n")
			r.commit("odd names again\n\nDocs: none", "src/ lead.ts")
			const mid = r.git("rev-parse", "HEAD~1")
			expect(checkFreshness(mid, MAP_REPO, r.dir).stale).toEqual([])
		})

		it("passes a clean merge of commits that carried their own trailers", () => {
			const r = repo()
			const base = r.git("rev-parse", "HEAD")
			r.git("checkout", "-q", "-b", "side")
			r.write("src/side.ts", "s\n")
			r.commit("side\n\nDocs: none", "src/side.ts")
			r.git("checkout", "-q", "main")
			r.write("src/main.ts", "m\n")
			r.commit("main\n\nDocs: none", "src/main.ts")
			r.git("merge", "-q", "--no-ff", "-m", "merge side", "side")
			const commits = commitsInRange(base, r.dir)
			const merge = commits.find(c => c.merge)
			expect(merge?.files).toEqual([])
			expect(checkFreshness(base, MAP_REPO, r.dir).stale).toEqual([])
		})

		it("checks a change made inside a merge against the merge's own trailer", () => {
			const evil = (message: string): { dir: string; base: string } => {
				const r = repo()
				const base = r.git("rev-parse", "HEAD")
				r.git("checkout", "-q", "-b", "side")
				r.write("src/side.ts", "s\n")
				r.commit("side\n\nDocs: none", "src/side.ts")
				r.git("checkout", "-q", "main")
				r.git("merge", "-q", "--no-ff", "--no-commit", "side")
				r.write("src/a.ts", "changed in the merge\n")
				r.git("add", "src/a.ts")
				r.git("commit", "-q", "-m", message)
				return { dir: r.dir, base }
			}
			const bare = evil("merge side")
			expect(checkFreshness(bare.base, MAP_REPO, bare.dir).stale).toEqual([
				{ docs: ["docs/PAGE.md"], code: ["src/a.ts"] },
			])
			const excused = evil("merge side\n\nDocs: none")
			expect(checkFreshness(excused.base, MAP_REPO, excused.dir).stale).toEqual(
				[],
			)
		})

		it("falls back to the merge base with the main branch on a first push", () => {
			const r = repo()
			r.git("update-ref", "refs/remotes/origin/main", "HEAD")
			const main = r.git("rev-parse", "HEAD")
			r.write("src/a.ts", "a2\n")
			r.commit("change", "src/a.ts")
			for (const since of ["", "0".repeat(40), "deadbeef".repeat(5)]) {
				expect(resolveBase(since, r.dir)).toMatchObject({
					base: main,
					via: "origin/main",
				})
				expect(checkFreshness(since, MAP_REPO, r.dir).stale).toHaveLength(1)
			}
		})

		it("does not double-fail a clean merge of distant edits to one file", () => {
			const r = repo()
			const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`)
			r.write("src/a.ts", `${lines.join("\n")}\n`)
			r.commit("long file\n\nDocs: none", "src/a.ts")
			const base = r.git("rev-parse", "HEAD")
			r.git("checkout", "-q", "-b", "side")
			r.write("src/a.ts", `${["side", ...lines.slice(1)].join("\n")}\n`)
			r.commit("side edit\n\nDocs: none", "src/a.ts")
			r.git("checkout", "-q", "main")
			r.write("src/a.ts", `${[...lines.slice(0, -1), "main"].join("\n")}\n`)
			r.commit("main edit\n\nDocs: none", "src/a.ts")
			r.git("merge", "-q", "--no-ff", "-m", "merge side", "side")
			expect(commitsInRange(base, r.dir).find(c => c.merge)?.files).toEqual([])
			expect(checkFreshness(base, MAP_REPO, r.dir).stale).toEqual([])
		})

		it("checks a conflict resolved by taking one side wholesale", () => {
			const r = repo()
			const base = r.git("rev-parse", "HEAD")
			r.git("checkout", "-q", "-b", "side")
			r.write("src/a.ts", "side\n")
			r.commit("side\n\nDocs: none", "src/a.ts")
			r.git("checkout", "-q", "main")
			r.write("src/a.ts", "main\n")
			r.write("docs/PAGE.md", "page for main\n")
			r.commit("main with page", "src/a.ts", "docs/PAGE.md")
			const before = r.git("rev-parse", "HEAD")
			expect(() => r.git("merge", "-q", "--no-ff", "side")).toThrow()
			r.git("checkout", "--theirs", "src/a.ts")
			r.git("add", "src/a.ts")
			r.git("commit", "-q", "--no-edit")
			expect(commitsInRange(before, r.dir).find(c => c.merge)?.files).toEqual([
				"src/a.ts",
			])
			// The page changed on main, so the full range is fresh; the merge alone is not.
			expect(checkFreshness(base, MAP_REPO, r.dir).stale).toEqual([])
			expect(checkFreshness(before, MAP_REPO, r.dir).stale).toEqual([
				{ docs: ["docs/PAGE.md"], code: ["src/a.ts"] },
			])
			r.git("commit", "-q", "--amend", "-m", "merge side\n\nDocs: none")
			expect(checkFreshness(before, MAP_REPO, r.dir).stale).toEqual([])
		})

		it("checks HEAD's own commit when the fallback base is HEAD", () => {
			const r = repo()
			r.write("src/a.ts", "a2\n")
			r.commit("change", "src/a.ts")
			r.git("update-ref", "refs/remotes/origin/main", "HEAD")
			const parent = r.git("rev-parse", "HEAD~1")
			const result = checkFreshness("deadbeef".repeat(5), MAP_REPO, r.dir)
			expect(result.base).toBe(parent)
			expect(result.warning).toMatch(/not in this history.*HEAD's own commit/)
			expect(result.stale).toEqual([
				{ docs: ["docs/PAGE.md"], code: ["src/a.ts"] },
			])
		})

		it("checks a root commit whole when it is HEAD and on the fallback", () => {
			const r = repo()
			r.git("update-ref", "refs/remotes/origin/main", "HEAD")
			const result = checkFreshness("", MAP_REPO, r.dir)
			expect(result.via).toBe("the root commit")
			expect(result.stale).toEqual([])
			const r2 = repo()
			r2.git("commit", "-q", "--amend", "-m", "init without page")
			r2.git("rm", "-q", "--cached", "docs/PAGE.md")
			r2.git("commit", "-q", "--amend", "-m", "init without page")
			r2.git("update-ref", "refs/remotes/origin/main", "HEAD")
			expect(checkFreshness("", MAP_REPO, r2.dir).stale).toEqual([
				{ docs: ["docs/PAGE.md"], code: ["src/a.ts"] },
			])
		})

		it("tries the fallback when the given base shares no history", () => {
			const r = repo()
			const main = r.git("rev-parse", "HEAD")
			r.git("update-ref", "refs/remotes/origin/main", "HEAD")
			r.git("checkout", "-q", "--orphan", "other")
			r.git("commit", "-q", "-m", "orphan")
			const orphan = r.git("rev-parse", "HEAD")
			r.git("checkout", "-q", "main")
			r.write("src/a.ts", "a2\n")
			r.commit("change", "src/a.ts")
			const result = checkFreshness(orphan, MAP_REPO, r.dir)
			expect(result.base).toBe(main)
			expect(result.warning).toMatch(/shares no history with HEAD/)
			expect(result.stale).toHaveLength(1)
		})

		it("skips with a reason when no base can be found", () => {
			const r = repo()
			const result = checkFreshness("0".repeat(40), MAP_REPO, r.dir)
			expect(result.stale).toEqual([])
			expect(result.skipped).toMatch(/first push.*origin\/main/)
		})

		it("names a shallow clone as the reason", () => {
			const src = repo()
			src.write("src/a.ts", "a2\n")
			src.commit("change", "src/a.ts")
			const dir = mkdtempSync(join(tmpdir(), "check-docs-shallow-"))
			dirs.push(dir)
			execFileSync(
				"git",
				["clone", "-q", "--depth=1", `file://${src.dir}`, join(dir, "c")],
				{ stdio: "ignore" },
			)
			const missing = src.git("rev-parse", "HEAD~1")
			const result = checkFreshness(
				missing,
				MAP_REPO,
				join(dir, "c"),
				"nope/main",
			)
			expect(result.stale).toEqual([])
			expect(result.skipped).toMatch(/not in this history.*shallow clone/)
		})
	},
)
