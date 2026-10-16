/**
 * Makes the storage areas count every file at most once and never drop one (WG4 req 3).
 * Roots are compared by real path (symlinked ancestors and case aliases resolve to the same
 * directory); a root is treated as covered by another root only when that root's walk,
 * which never follows symlinks, actually reaches it.
 */
import path from "node:path"

import type { StorageAreaSource } from "./contract.js"
import type { StorageScanFs } from "./scan.js"

type RootKind = "dir" | "file" | "link" | "other" | "missing"

interface Root {
	text: string
	/** Real path, following a symlink root. */
	real: string
	/** Real parent plus the name: where the walker meets the entry itself (no follow). */
	place: string
	kind: RootKind
}

/** The entry a walk visits for this root: a symlink root is the link, not its target. */
function position(root: Root): string {
	return root.kind === "link" ? root.place : root.real
}

/** `child` is `parent` or below it (path components, so `..calls` is inside). */
export function isPathInside(child: string, parent: string): boolean {
	const rel = path.relative(parent, child)
	if (rel === "") return true
	return (
		rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
	)
}

function errnoCode(err: unknown): string | undefined {
	if (typeof err === "object" && err !== null && "code" in err) {
		const code = (err as { code: unknown }).code
		return typeof code === "string" ? code : undefined
	}
	return undefined
}

/**
 * The real path of `p`; for a missing path, the real path of its deepest existing ancestor
 * with the rest appended. The text path when the fs cannot resolve paths.
 */
async function realOf(fs: StorageScanFs, p: string): Promise<string> {
	const resolveReal = fs.realpath
	if (resolveReal === undefined) return p
	const rest: string[] = []
	let current = p
	for (;;) {
		try {
			return path.join(await resolveReal(current), ...rest)
		} catch (err: unknown) {
			const code = errnoCode(err)
			const parent = path.dirname(current)
			if ((code !== "ENOENT" && code !== "ENOTDIR") || parent === current)
				return p
			rest.unshift(path.basename(current))
			current = parent
		}
	}
}

async function kindOf(fs: StorageScanFs, p: string): Promise<RootKind> {
	try {
		const stat = await fs.lstat(p)
		if (stat.isSymbolicLink()) return "link"
		if (stat.isDirectory()) return "dir"
		if (stat.isFile()) return "file"
		return "other"
	} catch {
		return "missing"
	}
}

const COUNTED: readonly RootKind[] = ["dir", "file", "link"]

/** Two roots that are the same counted entry (same kind, same visited position). */
function sameEntry(left: Root, right: Root): boolean {
	return (
		left.kind === right.kind &&
		COUNTED.includes(left.kind) &&
		position(left) === position(right)
	)
}

/**
 * Where `inner` sits in `outer`'s walk, as the path the walker visits; null when that walk
 * does not reach it. The walk reaches it when it is the same entry, or when `outer` is a
 * real directory and `inner`'s entry (a file, a real directory, or a symlink itself, by
 * its real parent) is at or under `outer`'s real path: every component of a real path is
 * a real directory, so the walk passes no symlink on the way. A symlink root's target is
 * never reached through the link.
 */
function reachedAt(inner: Root, outer: Root): string | null {
	if (sameEntry(inner, outer)) return outer.text
	if (outer.kind !== "dir" || !COUNTED.includes(inner.kind)) return null
	const at = position(inner)
	if (!isPathInside(at, outer.real)) return null
	return path.join(outer.text, path.relative(outer.real, at))
}

/**
 * Inside one area a root another of its roots reaches is dropped (the first of two equal
 * roots stays). Across areas a root another area's root reaches is excluded from that
 * outer area; when two areas share a root it is excluded from the earlier one, so the
 * later area keeps it. Explicit `exclude` entries are kept.
 */
export async function disjointStorageAreas(
	areas: readonly StorageAreaSource[],
	fs: StorageScanFs,
): Promise<StorageAreaSource[]> {
	const resolved: Root[][] = []
	for (const area of areas) {
		const roots: Root[] = []
		for (const text of new Set(area.paths.map(p => path.resolve(p)))) {
			roots.push({
				text,
				real: await realOf(fs, text),
				place: path.join(
					await realOf(fs, path.dirname(text)),
					path.basename(text),
				),
				kind: "missing",
			})
		}
		resolved.push(roots)
	}
	// Kinds (one lstat each) only for roots that overlap another by real path; disjoint
	// roots need none, so the common case costs no extra fs call.
	const all = resolved.flat()
	for (const root of all) {
		const overlaps = all.some(
			other =>
				other !== root &&
				[root.real, root.place].some(mine =>
					[other.real, other.place].some(
						theirs => isPathInside(mine, theirs) || isPathInside(theirs, mine),
					),
				),
		)
		if (overlaps) root.kind = await kindOf(fs, root.text)
	}
	const kept = resolved.map(roots =>
		roots.filter(
			(root, index) =>
				!roots.some((other, otherIndex) => {
					if (otherIndex === index || reachedAt(root, other) === null)
						return false
					// The same entry twice: the first stays.
					return !sameEntry(root, other) || otherIndex < index
				}),
		),
	)
	return areas.map((area, index) => {
		const exclude = [...(area.exclude ?? [])]
		const roots = kept[index] ?? []
		kept.forEach((others, otherIndex) => {
			if (otherIndex === index) return
			for (const inner of others) {
				for (const outer of roots) {
					const at = reachedAt(inner, outer)
					if (at === null) continue
					if (sameEntry(inner, outer) && otherIndex < index) continue
					if (!exclude.includes(at)) exclude.push(at)
				}
			}
		})
		const { exclude: _explicit, ...rest } = area
		return {
			...rest,
			paths: roots.map(root => root.text),
			...(exclude.length > 0 ? { exclude } : {}),
		}
	})
}
