#!/usr/bin/env node
// Links this worktree's `.agents/memory` to the shared local agent memory so
// every harness (and every git worktree) reads the same memory index.
//
// Idempotent: an existing `.agents/memory` is never replaced. Refuses (exit 1)
// unless git ignores the link and the memory directory itself can't be
// committed to any repository, because this repository is public.
//
// Memory source, first match wins:
//   1. $WAVEKIT_AGENT_MEMORY_DIR
//   2. the main checkout's `.agents/memory` (when run from a linked worktree)
//   3. Claude Code's auto-memory directory for the main checkout
//
// Usage: node scripts/agents-setup.mjs [--check]
//   --check  report only; exit 1 when the link is missing, broken or not private
import { execFileSync, spawnSync } from "node:child_process"
import {
	existsSync,
	lstatSync,
	mkdirSync,
	realpathSync,
	statSync,
	symlinkSync,
} from "node:fs"
import { homedir } from "node:os"
import { dirname, join, relative } from "node:path"

const check = process.argv.includes("--check")

function git(...args) {
	return execFileSync("git", args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	}).trim()
}

function isDirectory(path) {
	try {
		return statSync(path).isDirectory()
	} catch {
		return false
	}
}

function fail(message) {
	console.error(`agents-setup: ${message}`)
	process.exit(1)
}

let root
try {
	root = git("rev-parse", "--show-toplevel")
} catch {
	fail("not inside a git worktree")
}

const linkPath = join(root, ".agents", "memory")

// A memory directory must never be publishable: refuse one inside a git work
// tree unless every enclosing repository ignores it and tracks nothing beneath
// it. Repositories are found on the filesystem (every ancestor holding `.git`),
// not through git's own discovery, which environment settings can narrow; any
// git failure while checking one leaves the target unverified and is refused.
const discoveryEnv = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_COMMON_DIR",
	"GIT_INDEX_FILE",
	"GIT_CEILING_DIRECTORIES",
	"GIT_DISCOVERY_ACROSS_FILESYSTEM",
]

function inspect(...args) {
	const env = { ...process.env, LC_ALL: "C", LANGUAGE: "" }
	for (const name of discoveryEnv) delete env[name]
	return spawnSync("git", args, { encoding: "utf8", env })
}

function enclosingRepos(dir) {
	const repos = []
	for (let current = dir; ; current = dirname(current)) {
		if (existsSync(join(current, ".git"))) repos.push(current)
		if (dirname(current) === current) return repos
	}
}

function exposure(dir) {
	for (const repo of enclosingRepos(dir)) {
		const path = relative(repo, dir) || "."
		const ignored = inspect("-C", repo, "check-ignore", "-q", path)
		if (ignored.status === 1)
			return `it is trackable by the git repository at ${repo}`
		if (ignored.status !== 0)
			return `git could not verify it: ${ignored.stderr.trim().split("\n")[0]}`
		const files = inspect("-C", repo, "ls-files", "--", path)
		if (files.status !== 0) return "git could not verify it"
		if (files.stdout.trim() !== "")
			return `it is trackable: the git repository at ${repo} tracks files beneath it`
	}
	return null
}

function requirePrivate(target) {
	try {
		git("-C", root, "check-ignore", "-q", ".agents/memory")
	} catch {
		fail(
			".agents/ is not git-ignored here; refusing to link private memory into a tracked path",
		)
	}
	const problem = exposure(target)
	if (problem)
		fail(`refusing ${target}: ${problem}; choose a private directory`)
}

let existing = null
try {
	existing = lstatSync(linkPath)
} catch {
	// No link yet.
}

if (existing) {
	if (!isDirectory(linkPath))
		fail(
			`${linkPath} exists but does not resolve to a directory; fix or remove it by hand`,
		)
	const target = realpathSync(linkPath)
	requirePrivate(target)
	console.log(`agents-setup: ok, .agents/memory -> ${target}`)
	process.exit(0)
}

if (check)
	fail(".agents/memory is missing; run `node scripts/agents-setup.mjs`")

const mainRoot = git("-C", root, "worktree", "list", "--porcelain")
	.split("\n")
	.find(line => line.startsWith("worktree "))
	?.slice("worktree ".length)

const claudeConfig = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")
const candidates = [
	process.env.WAVEKIT_AGENT_MEMORY_DIR,
	mainRoot && mainRoot !== root
		? join(mainRoot, ".agents", "memory")
		: undefined,
	mainRoot
		? join(
				claudeConfig,
				"projects",
				mainRoot.replace(/[^A-Za-z0-9]/g, "-"),
				"memory",
			)
		: undefined,
].filter(candidate => candidate !== undefined && candidate !== "")

const source = candidates.find(isDirectory)
if (!source) {
	console.log(
		"agents-setup: no shared memory found; set WAVEKIT_AGENT_MEMORY_DIR to a local directory to enable it",
	)
	process.exit(0)
}

const target = realpathSync(source)
requirePrivate(target)
if (!existsSync(join(root, ".agents"))) mkdirSync(join(root, ".agents"))
symlinkSync(target, linkPath, "dir")
console.log(`agents-setup: linked .agents/memory -> ${target}`)
