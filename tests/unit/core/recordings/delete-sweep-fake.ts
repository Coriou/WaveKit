import type {
	SweepFs,
	SweepStat,
} from "../../../../src/core/recordings/delete-sweep.js"

export interface FakeNode {
	type: "dir" | "file" | "symlink"
	uid?: number
	mode?: number
}

export const ME = 501
export const P = ".wavekit-delete-abc123"

/** An in-memory SweepFs; `ops` records every mutation as `kind path`. */
export class FakeFs implements SweepFs {
	readonly nodes = new Map<string, FakeNode>()
	readonly ops: string[] = []
	throwOn: string | null = null
	private inoOf = new Map<string, number>()

	constructor() {
		this.nodes.set("/r", { type: "dir", uid: ME, mode: 0o755 })
	}

	dir(path: string, uid = ME, mode = 0o755): this {
		this.nodes.set(path, { type: "dir", uid, mode })
		return this
	}
	file(path: string): this {
		this.nodes.set(path, { type: "file", uid: ME, mode: 0o644 })
		return this
	}
	symlink(path: string): this {
		this.nodes.set(path, { type: "symlink", uid: ME, mode: 0o777 })
		return this
	}
	/** A private directory holding `entries` (file names). */
	priv(
		parent: string,
		name: string,
		entries: string[],
		mode = 0o700,
		uid = ME,
	): string {
		const d = `${parent}/${name}`
		this.dir(d, uid, mode)
		for (const e of entries) this.file(`${d}/${e}`)
		return d
	}
	has(path: string): boolean {
		return this.nodes.has(path)
	}
	children(path: string): string[] {
		const out: string[] = []
		for (const k of this.nodes.keys())
			if (k.startsWith(`${path}/`) && !k.slice(path.length + 1).includes("/"))
				out.push(k.slice(path.length + 1))
		return out
	}
	private check(op: string, path: string): void {
		if (this.throwOn === op)
			throw Object.assign(new Error("fs"), { code: "EIO" })
		void path
	}
	async lstat(path: string): Promise<SweepStat> {
		this.check("lstat", path)
		const n = this.nodes.get(path)
		if (!n) throw Object.assign(new Error("nf"), { code: "ENOENT" })
		let ino = this.inoOf.get(path)
		if (ino === undefined) {
			ino = this.inoOf.size + 1
			this.inoOf.set(path, ino)
		}
		return {
			isDirectory: () => n.type === "dir",
			isFile: () => n.type === "file",
			isSymbolicLink: () => n.type === "symlink",
			uid: n.uid ?? ME,
			mode: (n.type === "dir" ? 0o040000 : 0o100000) | (n.mode ?? 0o644),
			dev: 1,
			ino,
		}
	}
	async readdir(path: string, limit: number): Promise<string[]> {
		this.check("readdir", path)
		if (this.nodes.get(path)?.type !== "dir")
			throw Object.assign(new Error("nd"), { code: "ENOTDIR" })
		return this.children(path).slice(0, limit)
	}
	async link(a: string, b: string): Promise<void> {
		this.check("link", a)
		if (this.nodes.has(b))
			throw Object.assign(new Error("ex"), { code: "EEXIST" })
		const n = this.nodes.get(a)
		if (!n) throw Object.assign(new Error("nf"), { code: "ENOENT" })
		this.nodes.set(b, { ...n })
		this.ops.push(`link ${b}`)
	}
	async unlink(p: string): Promise<void> {
		this.check("unlink", p)
		if (!this.nodes.has(p))
			throw Object.assign(new Error("nf"), { code: "ENOENT" })
		this.nodes.delete(p)
		this.ops.push(`unlink ${p}`)
	}
	async rmdir(p: string): Promise<void> {
		this.check("rmdir", p)
		if (this.children(p).length > 0)
			throw Object.assign(new Error("ne"), { code: "ENOTEMPTY" })
		this.nodes.delete(p)
		this.ops.push(`rmdir ${p}`)
	}
}
