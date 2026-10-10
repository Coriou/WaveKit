#!/usr/bin/env node
// Links this worktree's `.agents/memory` to the shared local agent memory so
// every harness (and every git worktree) reads the same memory index.
//
// Idempotent: an existing `.agents/memory` is never replaced. Refuses to create
// the link unless git ignores it, because this repository is public.
//
// Memory source, first match wins:
//   1. $WAVEKIT_AGENT_MEMORY_DIR
//   2. the main checkout's `.agents/memory` (when run from a linked worktree)
//   3. Claude Code's auto-memory directory for the main checkout
//
// Usage: node scripts/agents-setup.mjs [--check]
//   --check  report only; exit 1 when the link is missing or broken
import { execFileSync } from "node:child_process"
import {
	existsSync,
	lstatSync,
	mkdirSync,
	realpathSync,
	statSync,
	symlinkSync,
} from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

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
	console.log(`agents-setup: ok, .agents/memory -> ${realpathSync(linkPath)}`)
	process.exit(0)
}

if (check)
	fail(".agents/memory is missing; run `node scripts/agents-setup.mjs`")

try {
	git("-C", root, "check-ignore", "-q", ".agents/memory")
} catch {
	fail(
		".agents/ is not git-ignored here; refusing to link private memory into a tracked path",
	)
}

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
if (!existsSync(join(root, ".agents"))) mkdirSync(join(root, ".agents"))
symlinkSync(target, linkPath, "dir")
console.log(`agents-setup: linked .agents/memory -> ${target}`)
