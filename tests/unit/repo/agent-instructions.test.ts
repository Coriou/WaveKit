/**
 * Drift checks for the agent instructions (AGENTS.md, docs/specs/README.md).
 *
 * Instructions are only useful while they match the code: these tests fail when a
 * documented command, path or convention stops existing, when a second instruction
 * source appears, or when the private `.agents/` workspace could leak into git or
 * Docker build contexts.
 */
import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const read = (path: string) => readFileSync(join(root, path), "utf8")
const git = (...args: string[]) =>
	execFileSync("git", args, { cwd: root, encoding: "utf8" })
const tracked = git("ls-files").split("\n").filter(Boolean)

const agents = read("AGENTS.md")
const instructionDocs = ["AGENTS.md", "docs/specs/README.md"]

function withoutFences(markdown: string) {
	return markdown.replace(/```[\s\S]*?```/g, "")
}

function fencedBlocks(markdown: string) {
	return [...markdown.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map(
		m => m[1] ?? "",
	)
}

function codeSpans(markdown: string) {
	return [...withoutFences(markdown).matchAll(/`([^`\n]+)`/g)].map(
		m => m[1] ?? "",
	)
}

describe("agent instructions", () => {
	describe("single canonical source", () => {
		it("AGENTS.md fits every harness's context-file budget", () => {
			// Grok CLI truncates each rules file at 10,000 characters; Codex at 32 KiB.
			expect(agents.length).toBeLessThanOrEqual(10_000)
		})

		it("has no second instruction file at the repository root", () => {
			// CLAUDE.md may only exist as the documented one-line import of AGENTS.md.
			if (existsSync(join(root, "CLAUDE.md"))) {
				expect(read("CLAUDE.md").trim()).toBe("@AGENTS.md")
			}
			const legacy = [
				/^\.kiro\/steering\//,
				/^\.github\/instructions\//,
				/^\.github\/copilot-instructions\.md$/,
				/^(GEMINI|AGENT|Agents|Claude)\.md$/,
				/^\.(cursorrules|windsurfrules|clinerules)$/,
				/^\.cursor\/rules\//,
				/^\.claude\/(CLAUDE|AGENTS)\.md$/,
			]
			expect(tracked.filter(file => legacy.some(re => re.test(file)))).toEqual(
				[],
			)
		})
	})

	describe("commands", () => {
		const scripts = Object.keys(
			(JSON.parse(read("package.json")) as { scripts: Record<string, string> })
				.scripts,
		)
		const makeTargets = [...read("Makefile").matchAll(/^([a-z][\w-]*):/gm)].map(
			m => m[1],
		)
		const shell =
			fencedBlocks(agents).join("\n") + "\n" + codeSpans(agents).join("\n")

		it("every `pnpm run <script>` exists in package.json", () => {
			const used = [...shell.matchAll(/pnpm run ([\w:-]+)/g)].map(m => m[1])
			expect(used.length).toBeGreaterThan(0)
			expect(used.filter(name => !scripts.includes(name!))).toEqual([])
			if (/^pnpm test\b/m.test(shell)) expect(scripts).toContain("test")
		})

		it("every `make <target>` exists in the Makefile", () => {
			const used = [...shell.matchAll(/make ([a-z][\w-]*)/g)].map(m => m[1])
			expect(used.length).toBeGreaterThan(0)
			expect(used.filter(name => !makeTargets.includes(name))).toEqual([])
		})

		it("every `node scripts/...` exists", () => {
			const used = [...shell.matchAll(/node (scripts\/[\w./-]+)/g)].map(
				m => m[1]!,
			)
			expect(used.filter(path => !existsSync(join(root, path)))).toEqual([])
		})
	})

	describe("paths", () => {
		const topLevel = new Set(tracked.map(file => file.split("/")[0]!))

		it.each(instructionDocs)("repository paths named in %s exist", doc => {
			const missing = codeSpans(read(doc))
				.filter(span => !/[\s<>{}*]|\.\.\.|path\/to/.test(span))
				.filter(span => topLevel.has(span.replace(/\/$/, "").split("/")[0]!))
				.filter(span => {
					const path = join(root, span)
					// Docs name runtime ESM specifiers (`.js`) for TypeScript sources.
					return !existsSync(path) && !existsSync(path.replace(/\.js$/, ".ts"))
				})
			expect(missing).toEqual([])
		})

		it("relative Markdown links in tracked docs resolve", () => {
			const broken: string[] = []
			for (const file of tracked.filter(f => f.endsWith(".md"))) {
				if (!existsSync(join(root, file))) continue
				for (const m of withoutFences(read(file)).matchAll(
					/\]\(([^)\s]+)\)/g,
				)) {
					const target = decodeURI(m[1]!.split("#")[0]!)
					if (!target || /^[a-z][\w+.-]*:/i.test(target)) continue
					if (!existsSync(resolve(root, dirname(file), target))) {
						broken.push(`${file} -> ${m[1]}`)
					}
				}
			}
			expect(broken).toEqual([])
		})
	})

	describe("conventions match tooling", () => {
		it("named compiler flags are enabled in tsconfig.base.json", () => {
			const options = (
				JSON.parse(read("tsconfig.base.json")) as {
					compilerOptions: Record<string, unknown>
				}
			).compilerOptions
			const flags = codeSpans(agents).filter(span => span in options)
			expect(flags).toEqual(
				expect.arrayContaining([
					"noUncheckedIndexedAccess",
					"verbatimModuleSyntax",
				]),
			)
			expect(flags.filter(flag => options[flag] !== true)).toEqual([])
		})

		it("named lint rules are errors in eslint.config.js", () => {
			const config = read("eslint.config.js")
			const rules = codeSpans(agents).flatMap(span =>
				[...span.matchAll(/@typescript-eslint\/[\w-]+/g)].map(m => m[0]),
			)
			expect(rules.length).toBeGreaterThan(0)
			expect(
				rules.filter(
					rule => !new RegExp(`"${rule}":\\s*(\\[\\s*)?"error"`).test(config),
				),
			).toEqual([])
		})

		it("formatting claims match .prettierrc", () => {
			const prettier = JSON.parse(read(".prettierrc")) as Record<
				string,
				unknown
			>
			expect(agents).toMatch(
				/Tabs, no semicolons, double quotes, `x => \.\.\.`/,
			)
			expect(prettier).toMatchObject({
				useTabs: true,
				semi: false,
				arrowParens: "avoid",
			})
			expect(prettier["singleQuote"]).not.toBe(true)
		})

		it("spec directories hold the three spec files", () => {
			const specRoots = ["docs/specs", ".kiro/specs"].filter(dir =>
				existsSync(join(root, dir)),
			)
			const incomplete = specRoots.flatMap(dir =>
				readdirSync(join(root, dir))
					.filter(name => statSync(join(root, dir, name)).isDirectory())
					.filter(name =>
						["requirements.md", "design.md", "tasks.md"].some(
							file => !existsSync(join(root, dir, name, file)),
						),
					)
					.map(name => `${dir}/${name}`),
			)
			expect(incomplete).toEqual([])
		})
	})

	describe("private workspace", () => {
		it("git ignores .agents/ and nothing under it is tracked", () => {
			expect(git("check-ignore", ".agents/lane-status.md").trim()).toBe(
				".agents/lane-status.md",
			)
			expect(tracked.filter(file => file.startsWith(".agents/"))).toEqual([])
		})

		it("Docker build contexts exclude .agents and .claude", () => {
			const ignored = read(".dockerignore")
				.split("\n")
				.map(line => line.trim())
			expect(ignored).toEqual(expect.arrayContaining([".agents", ".claude"]))
		})

		it.each(instructionDocs)("%s names no machine-specific home paths", doc => {
			expect(read(doc)).not.toMatch(
				/\/(Users|home)\/[^/\s]+\/|~\/\.claude\/projects/,
			)
		})
	})
})
