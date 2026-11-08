/**
 * Load-time migration support: the owner each wanted folder id was last listed under in the
 * journal's alias listings (`payload.aliases`, written with every merge). Streams every day file
 * in 256 KiB chunks; only lines holding an alias listing are parsed (a byte search first), each
 * validated with Zod. Read only: nothing is written or removed.
 */
import { open } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"

const CHUNK_BYTES = 256 * 1024
/** A longer line is skipped unparsed (the journal reader's own line bound). */
const MAX_LINE_BYTES = 64 * 1024 * 1024
const MARKER = Buffer.from('"aliases":[{', "utf8")
const NEWLINE = 0x0a

const AliasLineSchema = z.object({
	seq: z.number().int().nonnegative(),
	payload: z.object({
		aliases: z
			.array(
				z.object({
					id: z.string().max(64),
					aliases: z.array(z.string().max(64)),
				}),
			)
			.optional(),
	}),
})

export interface AliasHistory {
	/** Folder id -> the owner of its last journaled alias listing. */
	owners: Map<string, string>
	/** Lines holding a listing that failed to parse (counted, skipped). */
	invalid: number
}

export async function readAliasHistory(opts: {
	dir: string
	names: readonly string[]
	wanted: ReadonlySet<string>
}): Promise<AliasHistory> {
	const best = new Map<string, { owner: string; seq: number }>()
	let invalid = 0
	const consider = (line: Buffer): void => {
		if (line.indexOf(MARKER) < 0) return
		let parsed: z.infer<typeof AliasLineSchema>
		try {
			const result = AliasLineSchema.safeParse(
				JSON.parse(line.toString("utf8")) as unknown,
			)
			if (!result.success) {
				invalid++
				return
			}
			parsed = result.data
		} catch {
			invalid++
			return
		}
		for (const entry of parsed.payload.aliases ?? [])
			for (const alias of entry.aliases) {
				if (!opts.wanted.has(alias)) continue
				const prior = best.get(alias)
				if (prior === undefined || prior.seq <= parsed.seq)
					best.set(alias, { owner: entry.id, seq: parsed.seq })
			}
	}
	for (const name of opts.names) {
		let handle
		try {
			handle = await open(join(opts.dir, name), "r")
		} catch {
			continue
		}
		try {
			let carry: Buffer[] = []
			let carryBytes = 0
			let skipping = false
			const buffer = Buffer.allocUnsafe(CHUNK_BYTES)
			for (;;) {
				const { bytesRead } = await handle.read(buffer, 0, CHUNK_BYTES, null)
				if (bytesRead === 0) break
				const chunk = buffer.subarray(0, bytesRead)
				let start = 0
				for (;;) {
					const nl = chunk.indexOf(NEWLINE, start)
					if (nl < 0) break
					if (!skipping) {
						const piece = chunk.subarray(start, nl)
						consider(
							carryBytes === 0
								? piece
								: Buffer.concat([...carry, piece], carryBytes + piece.length),
						)
					}
					carry = []
					carryBytes = 0
					skipping = false
					start = nl + 1
				}
				if (start < chunk.length && !skipping) {
					const rest = chunk.subarray(start)
					carryBytes += rest.length
					if (carryBytes > MAX_LINE_BYTES) {
						carry = []
						carryBytes = 0
						skipping = true
					} else carry.push(Buffer.from(rest))
				}
			}
			// A torn last line holds no complete listing: ignored.
		} finally {
			await handle.close().catch(() => undefined)
		}
	}
	const owners = new Map<string, string>()
	for (const [alias, b] of best) owners.set(alias, b.owner)
	return { owners, invalid }
}
