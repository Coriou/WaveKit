/**
 * GET /api/identify?frequencyHz=F: what the core already knows is at F, with a proof level, in one
 * read. Composition only: the discoveries the scanner holds within the tolerance (the discovery
 * list's own `nearHz` window, nearest first), each graded from its published label and proof. It
 * never retunes, starts no probe and listens to nothing: for a live test, POST
 * /api/scanner/identify (named in `confirm`).
 */
import { z } from "zod"
import {
	DISCOVERY_NEAR_DEFAULT_TOLERANCE_HZ,
	DISCOVERY_NEAR_MAX_TOLERANCE_HZ,
	FREQUENCY_IDENTIFY_LIMITS,
	type Discovery,
	type FrequencyIdentifyResponse,
	type FrequencyIdentifyRow,
	type FrequencyProofLevel,
} from "@wavekit/api-types"
import type { FastifyPluginAsync } from "fastify"
import type { DiscoveryFilter } from "../../core/scanner/store/discovery-store.js"
import { zodValidationBody } from "../validation-errors.js"

export interface IdentifyAtSource {
	/** A page of discoveries for the filter (the scanner's discovery list). */
	listDiscoveries: (
		filter: DiscoveryFilter,
	) =>
		| { items: Discovery[]; nextCursor: string | null }
		| Promise<{ items: Discovery[]; nextCursor: string | null }>
}

/** 100 GHz is above any receiver, as on the discovery list's `nearHz`. */
const MAX_FREQUENCY_HZ = 100_000_000_000

export const IdentifyAtQuerySchema = z
	.object({
		frequencyHz: z.coerce.number().finite().positive().max(MAX_FREQUENCY_HZ),
		toleranceHz: z.coerce
			.number()
			.finite()
			.min(0)
			.max(DISCOVERY_NEAR_MAX_TOLERANCE_HZ)
			.optional(),
	})
	.strict()

const RANK: Record<Exclude<FrequencyProofLevel, "nothing">, number> = {
	decoded: 3,
	classified: 2,
	"energy-only": 1,
}

/** Proof kinds that classify without a decode; any other kind (`carrier-only`, newer) proves energy only. */
const CLASSIFIED_PROOF_KINDS: ReadonlySet<string> = new Set([
	"analog-tone",
	"analog-voice",
	"digital-undecoded",
])

/**
 * The level one discovery proves. A possible spur never reads above `energy-only` (clients say
 * "possible spur", never a clean signal); a confidence or proof kind not listed here (a newer
 * label) reads `energy-only`, the safe answer.
 */
export function levelOf(d: Discovery): Exclude<FrequencyProofLevel, "nothing"> {
	if (d.possibleSpur !== undefined) return "energy-only"
	if (d.confidence === "decoded" || d.proof?.kind === "decoded")
		return "decoded"
	if (
		d.confidence === "classified" ||
		(d.proof !== undefined && CLASSIFIED_PROOF_KINDS.has(d.proof.kind))
	)
		return "classified"
	return "energy-only"
}

function rowOf(d: Discovery, frequencyHz: number): FrequencyIdentifyRow {
	return {
		discoveryId: d.id,
		frequencyHz: d.frequencyHz,
		offsetHz: d.frequencyHz - frequencyHz,
		level: levelOf(d),
		protocol: d.protocol,
		class: d.class,
		confidence: d.confidence,
		evidenceLevel: d.evidenceLevel ?? null,
		proofKind: d.proof?.kind ?? null,
		...(d.identity !== undefined ? { identity: d.identity } : {}),
		lastSeenAt: d.lastSeenAt,
		possibleSpur: d.possibleSpur !== undefined,
	}
}

/** Best level first, then nearest, then most recently heard. */
function compareRows(a: FrequencyIdentifyRow, b: FrequencyIdentifyRow): number {
	return (
		RANK[b.level] - RANK[a.level] ||
		Math.abs(a.offsetHz) - Math.abs(b.offsetHz) ||
		(a.lastSeenAt < b.lastSeenAt ? 1 : a.lastSeenAt > b.lastSeenAt ? -1 : 0)
	)
}

/** Pure composition of one answer; exported for the tests. */
export async function buildIdentifyAt(
	source: IdentifyAtSource,
	frequencyHz: number,
	toleranceHz: number,
	nowMs: number,
): Promise<FrequencyIdentifyResponse> {
	const { scanMax, othersMax } = FREQUENCY_IDENTIFY_LIMITS
	const near = { nearHz: frequencyHz, toleranceHz }
	const first = await source.listDiscoveries({ ...near, limit: scanMax })
	const byId = new Map(first.items.map(d => [d.id, d]))
	const truncated = first.nextCursor !== null
	// A window with more than scanMax rows: read the ones whose published confidence is decoded
	// too, so none of those is cut. A row decoded only by its proof kind under a lower published
	// confidence can still fall outside both reads; `truncated` stays true then.
	if (truncated) {
		const decoded = await source.listDiscoveries({
			...near,
			minConfidence: "decoded",
			limit: scanMax,
		})
		for (const d of decoded.items) byId.set(d.id, d)
	}
	const rows = [...byId.values()]
		.filter(d => Math.abs(d.frequencyHz - frequencyHz) <= toleranceHz)
		.map(d => rowOf(d, frequencyHz))
		.sort(compareRows)
	const best = rows[0] ?? null
	return {
		at: new Date(nowMs).toISOString(),
		frequencyHz,
		toleranceHz,
		level: best?.level ?? "nothing",
		best,
		others: rows.slice(1, 1 + othersMax),
		truncated: truncated || rows.length > 1 + othersMax,
		confirm: { method: "POST", path: "/api/scanner/identify" },
	}
}

export interface IdentifyAtRoutesOptions {
	source: IdentifyAtSource
	/** Test seam. */
	now?: (() => number) | undefined
}

export const identifyAtRoutes: FastifyPluginAsync<
	IdentifyAtRoutesOptions
> = async (app, options) => {
	const now = options.now ?? Date.now
	app.get(
		"/api/identify",
		{
			schema: {
				summary:
					"What the core already knows is at a frequency, with a proof level (no retune, no probe)",
				tags: ["scanner"],
			},
		},
		async (request, reply) => {
			const parsed = IdentifyAtQuerySchema.safeParse(request.query ?? {})
			if (!parsed.success)
				return reply.code(400).send(
					zodValidationBody(parsed.error, IdentifyAtQuerySchema, {
						part: "query",
					}),
				)
			return buildIdentifyAt(
				options.source,
				parsed.data.frequencyHz,
				parsed.data.toleranceHz ?? DISCOVERY_NEAR_DEFAULT_TOLERANCE_HZ,
				now(),
			)
		},
	)
}
