import path from "node:path"

import type { StorageScanFs } from "../../../../src/core/storage-report/scan.js"

export type FakeNode =
	| { kind: "file"; size: number }
	| { kind: "dir" }
	| { kind: "link"; size: number }
	| { kind: "other" }

export interface FakeFsOptions {
	/** Error codes thrown by lstat for a path. */
	lstatErrors?: Record<string, string>
	/** Error codes thrown by readdir for a path. */
	readdirErrors?: Record<string, string>
	/** Called before each fs call resolves (e.g. to advance a fake clock). */
	onCall?: () => void
	/** Yield to the event loop this many times inside each call. */
	delayTicks?: number
}

function errno(code: string, p: string): NodeJS.ErrnoException {
	const err: NodeJS.ErrnoException = new Error(`${code}: ${p}`)
	err.code = code
	return err
}

export interface InstrumentedFs extends StorageScanFs {
	maxInFlight: number
	lstatCalls: string[]
}

/** In-memory fs keyed by absolute posix paths; parents are implied by child keys. */
export function createFakeFs(
	nodes: Record<string, FakeNode>,
	options: FakeFsOptions = {},
): InstrumentedFs {
	const map = new Map(Object.entries(nodes))
	let inFlight = 0
	const tick = async (): Promise<void> => {
		for (let i = 0; i < (options.delayTicks ?? 0); i++) {
			await new Promise<void>(resolve => setImmediate(resolve))
		}
	}
	const fs: InstrumentedFs = {
		maxInFlight: 0,
		lstatCalls: [],
		async lstat(p) {
			inFlight++
			fs.maxInFlight = Math.max(fs.maxInFlight, inFlight)
			fs.lstatCalls.push(p)
			try {
				await tick()
				options.onCall?.()
				const code = options.lstatErrors?.[p]
				if (code !== undefined) throw errno(code, p)
				const node = map.get(p)
				if (node === undefined) throw errno("ENOENT", p)
				return {
					size: node.kind === "file" || node.kind === "link" ? node.size : 4096,
					isFile: () => node.kind === "file",
					isDirectory: () => node.kind === "dir",
					isSymbolicLink: () => node.kind === "link",
				}
			} finally {
				inFlight--
			}
		},
		async readdir(p) {
			inFlight++
			fs.maxInFlight = Math.max(fs.maxInFlight, inFlight)
			try {
				await tick()
				options.onCall?.()
				const code = options.readdirErrors?.[p]
				if (code !== undefined) throw errno(code, p)
				const node = map.get(p)
				if (node === undefined) throw errno("ENOENT", p)
				if (node.kind !== "dir") throw errno("ENOTDIR", p)
				const names: string[] = []
				for (const key of map.keys()) {
					if (key !== p && path.dirname(key) === p)
						names.push(path.basename(key))
				}
				return names
			} finally {
				inFlight--
			}
		},
	}
	return fs
}
