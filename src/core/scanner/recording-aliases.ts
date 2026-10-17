/**
 * WG10 req 1.5: merge aliases. A merge never moves or rekeys a recording folder: the survivor
 * adopts the dropped discovery's folder (and the dropped discovery's own aliases) as aliases.
 * Pure bookkeeping, owned by the DiscoveryStore; at most `DISCOVERY_RECORDING_ALIASES_MAX` per
 * owner (the oldest is released and its folder becomes an orphan, req 1.7). O(1) owner lookup.
 */
import { DISCOVERY_RECORDING_ALIASES_MAX } from "../recordings/contract.js"
import type { RecordingProtection } from "../recordings/contract.js"

export interface DiscoveryAliasEntry {
	id: string
	aliases: string[]
}

/** The alias lookups the evidence store reads (wired from the DiscoveryStore). */
export interface DiscoveryAliasLookup {
	/** The live owner of an alias id; undefined for an id that is no alias of a live discovery. */
	aliasOwner(discoveryId: string): string | undefined
	/** The alias ids of an owner, oldest first (also of an owner deleted since, until released). */
	aliasesOf(discoveryId: string): readonly string[]
	/** Forgets the aliases of a deleted owner once its removal settled (no-op otherwise). */
	releaseAliases?(discoveryId: string): void
}

const NONE: readonly string[] = Object.freeze([])

export class RecordingAliasTable {
	private readonly byOwner = new Map<string, string[]>()
	private readonly owners = new Map<string, string>()
	/** Aliases of owners deleted (not merged) since; kept in memory until their removal settles. */
	private readonly detachedByOwner = new Map<string, string[]>()

	constructor(private readonly max: number = DISCOVERY_RECORDING_ALIASES_MAX) {}

	aliasOwner(id: string): string | undefined {
		return this.owners.get(id)
	}

	aliasesOf(id: string): readonly string[] {
		return this.byOwner.get(id) ?? this.detachedByOwner.get(id) ?? NONE
	}

	/**
	 * `drop` merged into `keep`: keep's list gains drop's aliases then drop itself (oldest first).
	 * Returns how many of the oldest were released past the bound.
	 */
	adopt(keep: string, drop: string): number {
		if (keep === drop) return 0
		const inherited = this.byOwner.get(drop) ?? []
		this.byOwner.delete(drop)
		const list = (this.byOwner.get(keep) ?? []).filter(
			id => id !== drop && !inherited.includes(id),
		)
		for (const id of [...inherited, drop])
			if (id !== keep && !list.includes(id)) list.push(id)
		let released = 0
		while (list.length > this.max) {
			const old = list.shift()
			if (old !== undefined) this.owners.delete(old)
			released++
		}
		for (const id of list) this.owners.set(id, keep)
		if (list.length > 0) this.byOwner.set(keep, list)
		else this.byOwner.delete(keep)
		return released
	}

	/** Owner deleted (not merged): its aliases are no longer admitted but stay listed for removal. */
	detach(owner: string): void {
		const list = this.byOwner.get(owner)
		if (list === undefined) return
		this.byOwner.delete(owner)
		for (const id of list) this.owners.delete(id)
		this.detachedByOwner.set(owner, list)
	}

	release(owner: string): void {
		this.detachedByOwner.delete(owner)
	}

	/** Journal replay: the owner's list as written (empty removes it). Invalid ids are skipped. */
	set(
		owner: string,
		aliases: readonly string[],
		live: (id: string) => boolean,
	): void {
		const previous = this.byOwner.get(owner)
		if (previous !== undefined)
			for (const id of previous)
				if (this.owners.get(id) === owner) this.owners.delete(id)
		this.byOwner.delete(owner)
		const list: string[] = []
		for (const id of aliases) {
			if (list.length >= this.max) break
			if (id === owner || live(id) || list.includes(id)) continue
			const other = this.owners.get(id)
			if (other !== undefined && other !== owner) {
				// A later entry moves the alias (a merge chain); the earlier owner forgets it.
				const was = this.byOwner.get(other)
				if (was !== undefined) {
					const next = was.filter(x => x !== id)
					if (next.length > 0) this.byOwner.set(other, next)
					else this.byOwner.delete(other)
				}
			}
			list.push(id)
			this.owners.set(id, owner)
		}
		if (list.length > 0) this.byOwner.set(owner, list)
	}

	/** Persisted state; owners sorted, only non-empty lists of live owners. */
	entries(): DiscoveryAliasEntry[] {
		return [...this.byOwner]
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([id, aliases]) => ({ id, aliases: [...aliases] }))
	}

	entryOf(owner: string): DiscoveryAliasEntry {
		return { id: owner, aliases: [...(this.byOwner.get(owner) ?? [])] }
	}

	/** Restore: only live owners; an alias that is itself live, repeated or owned twice is skipped. */
	restore(
		entries: readonly DiscoveryAliasEntry[],
		live: (id: string) => boolean,
	): void {
		this.clear()
		for (const e of entries) {
			if (!live(e.id)) continue
			const list: string[] = []
			for (const id of e.aliases) {
				if (list.length >= this.max) break
				if (id === e.id || live(id) || this.owners.has(id) || list.includes(id))
					continue
				list.push(id)
				this.owners.set(id, e.id)
			}
			if (list.length > 0) this.byOwner.set(e.id, list)
		}
	}

	clear(): void {
		this.byOwner.clear()
		this.owners.clear()
		this.detachedByOwner.clear()
	}
}

/**
 * Fail closed: true when the discovery or any of its aliases holds a kept key (a throwing port
 * answers held). Keys name each folder's own id, so every alias is asked by its own id.
 */
export function holdsKeptWithAliases(
	port: Pick<RecordingProtection, "discoveryHoldsKept">,
	aliasesOf: (id: string) => readonly string[],
	discoveryId: string,
): boolean {
	const ask = (id: string): boolean => {
		try {
			return port.discoveryHoldsKept(id) !== false
		} catch {
			return true
		}
	}
	if (ask(discoveryId)) return true
	let aliases: readonly string[]
	try {
		aliases = aliasesOf(discoveryId)
	} catch {
		return true
	}
	return aliases.some(ask)
}

/** The protection port, with `discoveryHoldsKept` alias-aware (the per-file answers unchanged). */
export function aliasAwareProtection(
	port: RecordingProtection,
	aliasesOf: (id: string) => readonly string[],
): RecordingProtection {
	return {
		isProtected: key => port.isProtected(key),
		isDsdFmeFileProtected: name => port.isDsdFmeFileProtected(name),
		isScannerFileProtected: (id, name) => port.isScannerFileProtected(id, name),
		discoveryHoldsKept: id => holdsKeptWithAliases(port, aliasesOf, id),
	}
}

/**
 * Retention: a file in an alias folder belongs to its owner, so an operator keep of the owner
 * protects its alias folders too. Returns `keep` itself when no kept owner has aliases.
 */
export function withAliasFolders(
	keep: ReadonlySet<string>,
	aliasesOf: (id: string) => readonly string[],
): ReadonlySet<string> {
	let out: Set<string> | null = null
	for (const owner of keep)
		for (const alias of aliasesOf(owner)) (out ??= new Set(keep)).add(alias)
	return out ?? keep
}
