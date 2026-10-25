#!/usr/bin/env node
// Documentation checks, run in CI by the docs job.
//
//   node scripts/check-docs.mjs                 relative links and images in the user docs resolve
//   node scripts/check-docs.mjs --since=<ref>   also: code changed since <ref> without its page
//                                               (docs/doc-map.json) changing too
//   --fallback=<ref>                            base used when <ref> is empty, all zeros or not in
//                                               this history (default origin/main)
//
// Both fail: a broken link, and mapped code that changed without its page unless every commit
// that touched the code carries the trailer `Docs: none` (the change is invisible to users) or
// names the page in `Docs: <path>`. When no base can be found (a shallow clone without
// origin/main), freshness is skipped with a warning rather than failing on a git error.

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

/** The longest prefix in `prefixes` that `file` starts with, or -1. */
function matchLength(file, prefixes) {
	let best = -1
	for (const p of prefixes)
		if (file.startsWith(p) && p.length > best) best = p.length
	return best
}

/** True when a `Docs:` trailer value is `none`, in any case. */
function isNone(trailer) {
	return trailer.toLowerCase() === "none"
}

/**
 * Pages whose code changed in `changed` while the page did not. A file belongs to the entry (or
 * entries) with the longest matching code prefix, so a narrow entry such as `src/core/scanner/`
 * takes its files away from a broad one such as `src/core/`.
 *
 * `commits` lists each commit in the range with its files and its `Docs:` trailers: a code file
 * is covered when every commit that touched it says `Docs: none` or names one of the entry's
 * pages (`Docs: docs/API.md`: the change is described by that page as it already stands, or the
 * page was updated in another commit). One commit's trailer never excuses another commit's change.
 */
export function stalePages(changed, map, commits = []) {
	const touched = new Set(changed)
	const longest = new Map(
		changed.map(f => [
			f,
			Math.max(-1, ...map.entries.map(e => matchLength(f, e.code))),
		]),
	)
	const stale = []
	for (const entry of map.entries) {
		const excused = file => {
			const by = commits.filter(c => c.files.includes(file))
			return (
				by.length > 0 &&
				by.every(c => c.trailers.some(t => isNone(t) || entry.docs.includes(t)))
			)
		}
		if (entry.docs.some(d => touched.has(d))) continue
		const hits = changed.filter(f => {
			const len = matchLength(f, entry.code)
			return len >= 0 && len === longest.get(f) && !excused(f)
		})
		if (hits.length > 0) stale.push({ docs: entry.docs, code: hits })
	}
	return stale
}

/** NUL-delimited git output (`-z`) split losslessly: names keep every space they have. */
export function splitZ(out) {
	return out.split("\0").filter(f => f !== "")
}

/** `Docs:` trailer values, NUL separated, split further on commas and trimmed. */
export function parseTrailers(out) {
	return out
		.split(/[\0\n,]/)
		.map(t => t.trim())
		.filter(Boolean)
}

function gitIn(repo, ...args) {
	return execFileSync("git", args, {
		cwd: repo,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	})
}

function tryGit(repo, ...args) {
	try {
		return gitIn(repo, ...args).trim()
	} catch {
		return undefined
	}
}

/**
 * Every commit in `base..HEAD` with its `Docs:` trailers and the files it changed.
 *
 * Ordinary commits list the files they changed against their parent. A merge lists only the
 * files whose merged content differs from every parent (`git diff-tree --cc`): conflict
 * resolutions and changes made in the merge itself. A clean merge lists nothing, so the commits
 * it brings in are judged on their own trailers and are not failed a second time; an evil merge
 * is judged on its own `Docs:` trailer.
 */
export function commitsInRange(base, repo = root) {
	const shas = gitIn(repo, "rev-list", "--reverse", `${base}..HEAD`)
		.split("\n")
		.filter(Boolean)
	return shas.map(sha => {
		const parents = gitIn(repo, "rev-list", "--parents", "-n", "1", sha)
			.trim()
			.split(" ")
		const merge = parents.length > 2
		const files = splitZ(
			merge
				? gitIn(
						repo,
						"diff-tree",
						"--cc",
						"--name-only",
						"-z",
						"--no-commit-id",
						sha,
					)
				: gitIn(
						repo,
						"diff-tree",
						"-r",
						"--root",
						"--name-only",
						"-z",
						"--no-commit-id",
						sha,
					),
		)
		const trailers = parseTrailers(
			gitIn(
				repo,
				"log",
				"-1",
				"--format=%(trailers:key=Docs,valueonly,separator=%x00)",
				sha,
			),
		)
		return { sha, merge, trailers, files }
	})
}

/**
 * The commit to compare HEAD with. `since` is the last checked commit (the pull request base,
 * or the commit before a push). It is unusable on the first push of a branch (all zeros or
 * empty), after a force push (not in this history) and in a shallow clone; then the merge base
 * with `fallback` (origin/main) stands in. Returns `{ base }`, or `{ reason }` when neither works.
 */
export function resolveBase(since, repo = root, fallback = "origin/main") {
	const usable =
		since !== "" &&
		!/^0+$/.test(since) &&
		tryGit(repo, "cat-file", "-e", `${since}^{commit}`) !== undefined
	const from = usable ? since : fallback
	const base = tryGit(repo, "merge-base", from, "HEAD")
	if (base) return { base, via: usable ? since : fallback }
	const shallow =
		tryGit(repo, "rev-parse", "--is-shallow-repository") === "true"
	const what =
		since === "" || /^0+$/.test(since)
			? "no base commit was given (first push of a branch)"
			: `${since} is not in this history`
	return {
		reason: `${what} and ${fallback} has no common ancestor here${shallow ? " (shallow clone: fetch with fetch-depth: 0)" : ""}`,
	}
}

/** Stale pages for the range since `since`, or the reason the range could not be checked. */
export function checkFreshness(
	since,
	map,
	repo = root,
	fallback = "origin/main",
) {
	const r = resolveBase(since, repo, fallback)
	if (!r.base) return { stale: [], skipped: r.reason ?? "no base" }
	const changed = splitZ(
		gitIn(repo, "diff", "--name-only", "-z", r.base, "HEAD"),
	)
	const commits = changed.length > 0 ? commitsInRange(r.base, repo) : []
	return { stale: stalePages(changed, map, commits), base: r.base, via: r.via }
}

function main() {
	const args = new Map(
		process.argv.slice(2).map(a => {
			const [k, ...v] = a.replace(/^--/, "").split("=")
			return [k ?? "", v.length > 0 ? v.join("=") : "true"]
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

	if (args.has("since")) {
		const map = JSON.parse(
			readFileSync(join(root, "docs/doc-map.json"), "utf8"),
		)
		const result = checkFreshness(
			args.get("since") ?? "",
			map,
			root,
			args.get("fallback") ?? "origin/main",
		)
		if (result.skipped) {
			const msg = `page freshness not checked: ${result.skipped}`
			console.log(ci ? `::warning::${msg}` : `docs: ${msg}`)
		} else if (result.via !== args.get("since")) {
			console.log(`docs: checking page freshness against ${result.via}`)
		}
		for (const s of result.stale) {
			failed = true
			const msg = `${s.code.length} file(s) changed under ${s.code[0]}${s.code.length > 1 ? " and others" : ""} without ${s.docs.join(" or ")}. Update the page, or end each commit message with "Docs: none" (users see no change) or "Docs: <page>" (the page already covers it).`
			console.log(ci ? `::error file=${s.docs[0]}::${msg}` : `error: ${msg}`)
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
