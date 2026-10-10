/**
 * scripts/agents-setup.mjs: per-worktree link to the shared local agent memory.
 * Runs against throwaway git repositories and worktrees, never the real checkout.
 */
import { execFileSync, spawnSync } from "node:child_process"
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readlinkSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

const script = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../../../scripts/agents-setup.mjs",
)

let sandbox: string
let main: string
let worktree: string
let claudeConfig: string

const isolatedEnv = (extra: Record<string, string> = {}) => {
	const env: NodeJS.ProcessEnv = {
		PATH: process.env["PATH"],
		HOME: sandbox,
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		CLAUDE_CONFIG_DIR: claudeConfig,
		...extra,
	}
	return env
}

const git = (cwd: string, ...args: string[]) =>
	execFileSync(
		"git",
		["-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
		{
			cwd,
			env: isolatedEnv(),
			encoding: "utf8",
		},
	)

const setup = (
	cwd: string,
	args: string[] = [],
	env: Record<string, string> = {},
) =>
	spawnSync(process.execPath, [script, ...args], {
		cwd,
		env: isolatedEnv(env),
		encoding: "utf8",
	})

const memoryDir = (name: string) => {
	const dir = join(sandbox, name)
	mkdirSync(dir, { recursive: true })
	writeFileSync(join(dir, "MEMORY.md"), `- ${name}\n`)
	return realpathSync(dir)
}

beforeEach(() => {
	sandbox = realpathSync(mkdtempSync(join(tmpdir(), "wavekit-agents-setup-")))
	claudeConfig = join(sandbox, "claude-config")
	main = join(sandbox, "main")
	worktree = join(sandbox, "wt")
	mkdirSync(main)
	git(main, "init", "-q")
	writeFileSync(join(main, ".gitignore"), "/.agents/\n")
	git(main, "add", ".gitignore")
	git(main, "commit", "-q", "-m", "init")
	git(main, "worktree", "add", "-q", "--detach", worktree)
})

afterEach(() => {
	rmSync(sandbox, { recursive: true, force: true })
})

describe("agents-setup", () => {
	it("links the directory named by WAVEKIT_AGENT_MEMORY_DIR and is idempotent", () => {
		const shared = memoryDir("shared")
		const first = setup(main, [], { WAVEKIT_AGENT_MEMORY_DIR: shared })
		expect(first.status).toBe(0)
		expect(readlinkSync(join(main, ".agents/memory"))).toBe(shared)

		const second = setup(main, [], {
			WAVEKIT_AGENT_MEMORY_DIR: memoryDir("other"),
		})
		expect(second.status).toBe(0)
		expect(second.stdout).toContain("ok")
		expect(readlinkSync(join(main, ".agents/memory"))).toBe(shared)
		expect(git(main, "status", "--porcelain")).toBe("")
	})

	it("gives a fresh worktree the main checkout's memory", () => {
		const shared = memoryDir("shared")
		mkdirSync(join(main, ".agents"))
		symlinkSync(shared, join(main, ".agents/memory"), "dir")

		expect(setup(worktree, ["--check"]).status).toBe(1)
		const result = setup(worktree)
		expect(result.status).toBe(0)
		expect(realpathSync(join(worktree, ".agents/memory"))).toBe(shared)
		expect(setup(worktree, ["--check"]).status).toBe(0)
		expect(git(worktree, "status", "--porcelain")).toBe("")
	})

	it("falls back to Claude Code's auto-memory for the main checkout", () => {
		const mainPath = git(main, "worktree", "list", "--porcelain")
			.split("\n")[0]!
			.slice("worktree ".length)
		const autoMemory = join(
			claudeConfig,
			"projects",
			mainPath.replace(/[^A-Za-z0-9]/g, "-"),
			"memory",
		)
		mkdirSync(autoMemory, { recursive: true })

		expect(setup(worktree).status).toBe(0)
		expect(realpathSync(join(worktree, ".agents/memory"))).toBe(
			realpathSync(autoMemory),
		)
	})

	it("does nothing when no shared memory exists", () => {
		const result = setup(worktree)
		expect(result.status).toBe(0)
		expect(result.stdout).toContain("WAVEKIT_AGENT_MEMORY_DIR")
		expect(existsSync(join(worktree, ".agents"))).toBe(false)
	})

	it("refuses to link when .agents/ is not git-ignored", () => {
		writeFileSync(join(worktree, ".gitignore"), "")
		const result = setup(worktree, [], {
			WAVEKIT_AGENT_MEMORY_DIR: memoryDir("shared"),
		})
		expect(result.status).toBe(1)
		expect(result.stderr).toContain("not git-ignored")
		expect(existsSync(join(worktree, ".agents"))).toBe(false)
	})

	it("never replaces an existing link", () => {
		const mine = memoryDir("mine")
		mkdirSync(join(worktree, ".agents"))
		symlinkSync(mine, join(worktree, ".agents/memory"), "dir")

		const result = setup(worktree, [], {
			WAVEKIT_AGENT_MEMORY_DIR: memoryDir("shared"),
		})
		expect(result.status).toBe(0)
		expect(readlinkSync(join(worktree, ".agents/memory"))).toBe(mine)
	})

	it("reports a broken link instead of fixing it", () => {
		mkdirSync(join(worktree, ".agents"))
		symlinkSync(join(sandbox, "gone"), join(worktree, ".agents/memory"), "dir")

		const result = setup(worktree, [], {
			WAVEKIT_AGENT_MEMORY_DIR: memoryDir("shared"),
		})
		expect(result.status).toBe(1)
		expect(lstatSync(join(worktree, ".agents/memory")).isSymbolicLink()).toBe(
			true,
		)
		expect(readlinkSync(join(worktree, ".agents/memory"))).toBe(
			join(sandbox, "gone"),
		)
	})

	it("refuses a memory directory that a repository could commit", () => {
		const docs = join(main, "docs")
		mkdirSync(docs)

		const result = setup(worktree, [], { WAVEKIT_AGENT_MEMORY_DIR: docs })
		expect(result.status).toBe(1)
		expect(result.stderr).toContain("trackable")
		expect(existsSync(join(worktree, ".agents"))).toBe(false)
	})

	it("refuses an ignored memory directory that still tracks files", () => {
		const shared = join(main, "private")
		mkdirSync(shared)
		writeFileSync(join(shared, "MEMORY.md"), "- leaked\n")
		git(main, "add", "private/MEMORY.md")
		git(main, "commit", "-q", "-m", "track")
		writeFileSync(join(main, ".gitignore"), "/.agents/\n/private/\n")

		const result = setup(main, [], { WAVEKIT_AGENT_MEMORY_DIR: shared })
		expect(result.status).toBe(1)
		expect(existsSync(join(main, ".agents"))).toBe(false)
	})

	it("flags an existing link whose target is trackable", () => {
		const docs = join(main, "docs")
		mkdirSync(docs)
		mkdirSync(join(worktree, ".agents"))
		symlinkSync(docs, join(worktree, ".agents/memory"), "dir")

		const result = setup(worktree, ["--check"])
		expect(result.status).toBe(1)
		expect(readlinkSync(join(worktree, ".agents/memory"))).toBe(docs)
	})
})
