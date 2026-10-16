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
	real: string
	kind: RootKind
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

/**
 * Where `inner` sits in `outer`'s walk, as the path the walker visits; null when that walk
 * does not reach it. The walk reaches it when `outer` is a real directory and `inner` is a
 * file or real directory (not a symlink, which its own area counts as a link) whose real
 * path is at or under `outer`'s: every component of a real path is a real directory, so
 * the walk passes no symlink on the way.
 */
function reachedAt(inner: Root, outer: Root): string | null {
	if (outer.kind !== "dir") return null
	if (inner.kind !== "dir" && inner.kind !== "file") return null
	if (!isPathInside(inner.real, outer.real)) return null
	return path.join(outer.text, path.relative(outer.real, inner.real))
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
			roots.push({ text, real: await realOf(fs, text), kind: "missing" })
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
				(isPathInside(root.real, other.real) ||
					isPathInside(other.real, root.real)),
		)
		if (overlaps) root.kind = await kindOf(fs, root.text)
	}
	const kept = resolved.map(roots =>
		roots.filter(
			(root, index) =>
				!roots.some((other, otherIndex) => {
					if (otherIndex === index || reachedAt(root, other) === null)
						return false
					// Equal real paths: the first stays.
					const equal = root.real === other.real && other.kind === root.kind
					return !equal || otherIndex < index
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
					if (inner.real === outer.real && otherIndex < index) continue
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
