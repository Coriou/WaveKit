/**
 * Startup sweep of `<root>/iq-captures` (WG11 req 6.6, Property 13): captures never survive a
 * restart. Removes only entries proven to be ours: a name of the capture grammar
 * (`<uuid v4>.cf32`) or its temporary twin (`<uuid v4>.cf32.tmp`), a regular file (lstat, never
 * followed), owned by this uid. Everything else is left in place and counted.
 */
import type { Stats } from "node:fs"
import * as fsp from "node:fs/promises"
import path from "node:path"
import { IQ_CAPTURE_FILE_PATTERN } from "../scanner/iq-capture-contract.js"
import { processUid, unlinkProvenSync, type DirIdentity } from "./fs-guard.js"

export const IQ_CAPTURE_TMP_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.cf32\.tmp$/

export interface SweepResult {
	removed: number
	/** Entries left in place (other names, links, directories, foreign owners). */
	left: number
	/** Removals that failed (left too). */
	failed: number
	/** The directory was no longer the proven one: the sweep stopped (review BLOCKING). */
	refused?: boolean
}

export interface SweepFs {
	readdir(dir: string): Promise<string[]>
	lstat(file: string): Promise<Pick<Stats, "isFile" | "isSymbolicLink" | "uid">>
	unlink(file: string): Promise<void>
}

const realFs: SweepFs = {
	readdir: dir => fsp.readdir(dir),
	lstat: file => fsp.lstat(file),
	unlink: file => fsp.unlink(file),
}

export function isSweepable(name: string): boolean {
	return IQ_CAPTURE_FILE_PATTERN.test(name) || IQ_CAPTURE_TMP_PATTERN.test(name)
}

/** Sweeps a directory already proven by `ensureCaptureDir`. Never throws. */
export async function sweepCaptureDir(
	dir: string,
	opts: {
		uid?: number | null
		fs?: SweepFs
		/** Re-proves the directory (chain from root, dev/ino) right before every unlink. */
		guard?: { root: string; identity: DirIdentity }
	} = {},
): Promise<SweepResult> {
	const uid = opts.uid === undefined ? processUid() : opts.uid
	const io = opts.fs ?? realFs
	const result: SweepResult = { removed: 0, left: 0, failed: 0 }
	let names: string[]
	try {
		names = await io.readdir(dir)
	} catch {
		return result
	}
	for (const name of names) {
		if (!isSweepable(name) || uid === null) {
			result.left++
			continue
		}
		const file = path.join(dir, name)
		let st: Pick<Stats, "isFile" | "isSymbolicLink" | "uid">
		try {
			st = await io.lstat(file)
		} catch {
			result.left++
			continue
		}
		if (st.isSymbolicLink() || !st.isFile() || st.uid !== uid) {
			result.left++
			continue
		}
		const g = opts.guard
		if (g) {
			// Proof and unlink in one synchronous step: nothing interleaves.
			const r = unlinkProvenSync(g.root, dir, g.identity, name, uid)
			if (r === "removed") result.removed++
			else if (r === "missing") result.left++
			else {
				result.refused = true
				result.left++
				return result
			}
			continue
		}
		try {
			await io.unlink(file)
			result.removed++
		} catch {
			result.failed++
		}
	}
	return result
}
