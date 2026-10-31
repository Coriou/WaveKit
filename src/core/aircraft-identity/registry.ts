/**
 * Aircraft identity registry: links between identifiers seen together on the air, each with its
 * evidence, source and lifetime.
 *
 * Rules:
 * - Only an ICAO address or a registration resolves to an aircraft. Callsigns and flight
 *   numbers name a flight; they are linked for display, never used to resolve.
 * - A registration resolves through an observed link first, a database link second. Two live
 *   links to different ICAO addresses at the same level are a conflict and resolve to nothing.
 * - Every link expires unless seen again. Lifetimes follow how long the pairing stays true:
 *   an ICAO address and its registration for weeks, a callsign or flight number for one flight.
 *
 * In memory only: links are learnt again after a restart.
 */
import type {
	AircraftIdentifier,
	AircraftIdentifierKind,
	AircraftIdentityEvidence,
	AircraftIdentityLink,
	AircraftIdentityResponse,
	AircraftIdentitySource,
} from "@wavekit/api-types"

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

/**
 * How long a link holds after it was last seen, by the pair of kinds it joins. An ICAO address
 * belongs to an airframe and follows its registration until it is re-registered; a callsign or
 * flight number changes with each flight.
 */
export const LINK_LIFETIME_MS: Readonly<Record<string, number>> = {
	"icao|reg": 30 * DAY_MS,
	"callsign|icao": 2 * HOUR_MS,
	"flight|icao": 6 * HOUR_MS,
	"flight|reg": 6 * HOUR_MS,
}
/** Fallback for any other pair (none is produced today). */
const DEFAULT_LIFETIME_MS = 2 * HOUR_MS

/** Most links kept; the least recently seen go first. Each link is a few hundred bytes. */
export const MAX_LINKS = 50_000

export interface IdentityObservation {
	a: AircraftIdentifier
	b: AircraftIdentifier
	evidence: AircraftIdentityEvidence
	source: AircraftIdentitySource
	at: Date
}

interface StoredLink {
	a: AircraftIdentifier
	b: AircraftIdentifier
	evidence: AircraftIdentityEvidence
	source: AircraftIdentitySource
	firstSeen: number
	lastSeen: number
	expiresAt: number
	count: number
}

function idKey(id: AircraftIdentifier): string {
	return `${id.kind}:${id.value}`
}

/** Kinds in a fixed order, so a link has one key whichever side it was observed from. */
function ordered(
	a: AircraftIdentifier,
	b: AircraftIdentifier,
): [AircraftIdentifier, AircraftIdentifier] {
	return idKey(a) <= idKey(b) ? [a, b] : [b, a]
}

function pairKey(a: AircraftIdentifierKind, b: AircraftIdentifierKind): string {
	return a <= b ? `${a}|${b}` : `${b}|${a}`
}

export function linkLifetimeMs(
	a: AircraftIdentifierKind,
	b: AircraftIdentifierKind,
): number {
	return LINK_LIFETIME_MS[pairKey(a, b)] ?? DEFAULT_LIFETIME_MS
}

function other(link: StoredLink, id: string): AircraftIdentifier {
	return idKey(link.a) === id ? link.b : link.a
}

export class AircraftIdentityRegistry {
	/** Link key to link, in least-recently-seen order (re-inserted on every sighting). */
	private readonly links = new Map<string, StoredLink>()
	/** Identifier key to the link keys that touch it. */
	private readonly byId = new Map<string, Set<string>>()

	constructor(
		private readonly now: () => number = Date.now,
		private readonly maxLinks: number = MAX_LINKS,
	) {}

	get size(): number {
		return this.links.size
	}

	/** Records that two identifiers were seen together. Same identifiers: ignored. */
	observe(observation: IdentityObservation): void {
		const [a, b] = ordered(observation.a, observation.b)
		if (idKey(a) === idKey(b) || a.kind === b.kind) return
		const at = observation.at.getTime()
		if (!Number.isFinite(at)) return
		const key = `${idKey(a)}~${idKey(b)}~${observation.evidence}`
		const lifetime = linkLifetimeMs(a.kind, b.kind)
		const existing = this.links.get(key)
		if (existing !== undefined) {
			this.links.delete(key)
			existing.lastSeen = Math.max(existing.lastSeen, at)
			existing.firstSeen = Math.min(existing.firstSeen, at)
			existing.expiresAt = existing.lastSeen + lifetime
			existing.count += 1
			existing.source = observation.source
			this.links.set(key, existing)
			return
		}
		this.links.set(key, {
			a,
			b,
			evidence: observation.evidence,
			source: observation.source,
			firstSeen: at,
			lastSeen: at,
			expiresAt: at + lifetime,
			count: 1,
		})
		for (const id of [a, b]) {
			const k = idKey(id)
			let set = this.byId.get(k)
			if (set === undefined) {
				set = new Set()
				this.byId.set(k, set)
			}
			set.add(key)
		}
		while (this.links.size > this.maxLinks) {
			const oldest = this.links.keys().next().value
			if (oldest === undefined) break
			this.remove(oldest)
		}
	}

	/** Forgets expired links. Returns how many went. */
	prune(): number {
		const now = this.now()
		let removed = 0
		for (const [key, link] of this.links) {
			if (link.expiresAt > now) continue
			this.remove(key)
			removed++
		}
		return removed
	}

	/** What WaveKit knows about one identifier. */
	resolve(
		query: AircraftIdentifier,
	): Omit<AircraftIdentityResponse, "timestamp"> {
		const now = this.now()
		let icao: string | null = null
		let resolvedBy: AircraftIdentityResponse["resolvedBy"] = null
		let conflict = false
		if (query.kind === "icao") {
			icao = query.value
			resolvedBy = "self"
		} else if (query.kind === "reg") {
			for (const level of ["observed", "database"] as const) {
				const found = new Set(
					this.live(idKey(query), now)
						.filter(l => l.evidence === level)
						.map(l => other(l, idKey(query)))
						.filter(id => id.kind === "icao")
						.map(id => id.value),
				)
				if (found.size === 0) continue
				if (found.size > 1) {
					conflict = true
					break
				}
				icao = [...found][0] ?? null
				resolvedBy = level
				break
			}
		}

		const around = new Map<string, StoredLink>()
		for (const id of [idKey(query), icao === null ? null : `icao:${icao}`]) {
			if (id === null) continue
			for (const link of this.live(id, now))
				around.set(`${idKey(link.a)}~${idKey(link.b)}~${link.evidence}`, link)
		}
		const links = [...around.values()]
			.sort((x, y) => y.lastSeen - x.lastSeen)
			.map(toLink)

		const entityKeys = new Set<string>()
		if (icao !== null) entityKeys.add(`icao:${icao}`)
		if (query.kind === "reg") entityKeys.add(`reg:${query.value}`)
		if (icao !== null)
			for (const link of this.live(`icao:${icao}`, now)) {
				if (link.evidence === "hint") continue
				const id = other(link, `icao:${icao}`)
				if (id.kind === "reg") entityKeys.add(`reg:${id.value}`)
			}
		return {
			query,
			icao,
			resolvedBy,
			conflict,
			links,
			entityKeys: [...entityKeys],
		}
	}

	private live(id: string, now: number): StoredLink[] {
		const keys = this.byId.get(id)
		if (keys === undefined) return []
		const out: StoredLink[] = []
		for (const key of keys) {
			const link = this.links.get(key)
			if (link !== undefined && link.expiresAt > now) out.push(link)
		}
		return out
	}

	private remove(key: string): void {
		const link = this.links.get(key)
		if (link === undefined) return
		this.links.delete(key)
		for (const id of [link.a, link.b]) {
			const k = idKey(id)
			const set = this.byId.get(k)
			if (set === undefined) continue
			set.delete(key)
			if (set.size === 0) this.byId.delete(k)
		}
	}
}

function toLink(link: StoredLink): AircraftIdentityLink {
	return {
		a: link.a,
		b: link.b,
		evidence: link.evidence,
		source: link.source,
		firstSeen: new Date(link.firstSeen).toISOString(),
		lastSeen: new Date(link.lastSeen).toISOString(),
		expiresAt: new Date(link.expiresAt).toISOString(),
		count: link.count,
	}
}
