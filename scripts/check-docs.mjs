#!/usr/bin/env node
// Documentation checks, run in CI by the docs job.
//
//   node scripts/check-docs.mjs                 relative links and images in the user docs resolve
//   node scripts/check-docs.mjs --since=<ref>   also: code changed since <ref> without its page
//                                               (docs/doc-map.json) changing too
//
// Broken links fail. A stale page is a warning (a GitHub annotation in CI), unless every
// commit that touched the code carries the trailer `Docs: none` (the change is invisible to users)
// or names the page in `Docs: <path>`. Pass --strict to make stale pages fail as well.

import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join, normalize, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")

/** The pages checked for links: what a user or an agent reads first. */
export function userDocs(repo = root) {
	const md = dir =>
		readdirSync(join(repo, dir))
			.filter(f => f.endsWith(".md"))
			.map(f => join(dir, f))
	const files = [
		"readme.md",
		"CONTRIBUTING.md",
		"AGENTS.md",
		...md("docs"),
		...md("docs/web"),
	]
	for (const pkg of readdirSync(join(repo, "packages")))
		if (existsSync(join(repo, "packages", pkg, "README.md")))
			files.push(join("packages", pkg, "README.md"))
	files.push("web/mock/README.md")
	return files.filter(f => existsSync(join(repo, f)))
}

/** Markdown and HTML link targets in `text`, outside fenced code blocks. */
export function linkTargets(text) {
	const out = []
	let fenced = false
	for (const line of text.split("\n")) {
		if (/^\s*(```|~~~)/.test(line)) {
			fenced = !fenced
			continue
		}
		if (fenced) continue
		const bare = line.replace(/`[^`]*`/g, "")
		for (const m of bare.matchAll(
			/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g,
		))
			out.push(m[1])
		for (const m of bare.matchAll(/\b(?:src|srcset|href)="([^"]+)"/g))
			out.push(m[1])
	}
	return out
}

/** Relative targets in `file` that do not exist on disk. */
export function brokenLinks(file, repo = root) {
	const text = readFileSync(join(repo, file), "utf8")
	const broken = []
	for (const target of linkTargets(text)) {
		if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) continue
		const path = decodeURI(target.split("#")[0] ?? "")
		if (path === "") continue
		const abs = path.startsWith("/")
			? join(repo, path)
			: normalize(join(repo, dirname(file), path))
		if (!existsSync(abs)) broken.push(target)
	}
	return broken
}

/**
 * Pages whose code changed in `changed` while the page did not. `commits` lists each commit in
 * the range with its files and its `Docs:` trailers: a code file is covered when every commit
 * that touched it says `Docs: none` or names one of the entry's pages, so one commit's trailer
 * never excuses another commit's change.
 */
export function stalePages(changed, map, commits = []) {
	const touched = new Set(changed)
	const stale = []
	for (const entry of map.entries) {
		const excused = file => {
			const by = commits.filter(c => c.files.includes(file))
			return (
				by.length > 0 &&
				by.every(c =>
					c.trailers.some(
						t => t.toLowerCase() === "none" || entry.docs.includes(t),
					),
				)
			)
		}
		if (entry.docs.some(d => touched.has(d))) continue
		const hits = changed.filter(
			f => entry.code.some(prefix => f.startsWith(prefix)) && !excused(f),
		)
		if (hits.length > 0) stale.push({ docs: entry.docs, code: hits })
	}
	return stale
}

/** `git log --name-only` output with a `@@<trailers>` header per commit, parsed. */
export function parseCommits(log) {
	const commits = []
	for (const line of log.split("\n")) {
		if (line.startsWith("@@")) {
			const trailers = line
				.slice(2)
				.split("|")
				.map(t => t.trim())
				.filter(Boolean)
			commits.push({ trailers, files: [] })
		} else if (line.trim() !== "" && commits.length > 0) {
			commits[commits.length - 1]?.files.push(line.trim())
		}
	}
	return commits
}

function git(...args) {
	return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim()
}

function main() {
	const args = new Map(
		process.argv.slice(2).map(a => {
			const [k, v] = a.replace(/^--/, "").split("=")
			return [k ?? "", v ?? "true"]
		}),
	)
	const ci = process.env["GITHUB_ACTIONS"] === "true"
	let failed = false

	for (const file of userDocs()) {
		for (const target of brokenLinks(file)) {
			failed = true
			console.log(
				ci
					? `::error file=${file}::broken link ${target}`
					: `${file}: broken link ${target}`,
			)
		}
	}

	const since = args.get("since")
	if (since && !/^0+$/.test(since)) {
		const map = JSON.parse(
			readFileSync(join(root, "docs/doc-map.json"), "utf8"),
		)
		let changed
		try {
			changed = git("diff", "--name-only", `${since}...HEAD`)
				.split("\n")
				.filter(Boolean)
		} catch {
			// A force push or a shallow clone: the base is not in the history.
			console.log(
				`docs: ${since} is not in this history, page freshness not checked`,
			)
			changed = []
		}
		// Merges are left out: their files come from the commits they bring in.
		const commits =
			changed.length > 0
				? parseCommits(
						git(
							"log",
							"--no-merges",
							"--name-only",
							"--format=@@%(trailers:key=Docs,valueonly,separator=|)",
							`${since}..HEAD`,
						),
					)
				: []
		for (const s of stalePages(changed, map, commits)) {
			const msg = `${s.code.length} file(s) changed under ${s.code[0]}${s.code.length > 1 ? " and others" : ""} without ${s.docs.join(" or ")}. Update the page, or add a "Docs: none" trailer if users see no change.`
			if (args.has("strict")) failed = true
			const level = args.has("strict") ? "error" : "warning"
			console.log(
				ci ? `::${level} file=${s.docs[0]}::${msg}` : `${level}: ${msg}`,
			)
		}
	}

	if (failed) process.exit(1)
	console.log("docs: ok")
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
	main()
