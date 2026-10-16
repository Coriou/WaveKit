/**
 * Fair-share retention planner (WG3 lane F, Requirement 1). Pure and O(k log k) in the
 * number of shares: computes the water level of each active cap and splits one prune step's
 * row budget across the shares above it.
 */

/** Share key: `decoder:<id>` when the row has a decoder id, else `kind:<kind>`. */
export function retentionShareKey(
	decoderId: string | null,
	kind: string,
): string {
	return decoderId !== null ? `decoder:${decoderId}` : `kind:${kind}`
}

/** Non-negative safe integer; anything non-finite, negative or non-number becomes 0. */
function clean(value: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
		return 0
	return Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER)
}

/**
 * Water level L: the largest integer level such that sum(min(u_i, L)) <= target.
 * Returns null when the usages already fit under the target.
 */
export function waterLevel(
	usages: readonly number[],
	target: number,
): number | null {
	const u = usages.map(clean).sort((a, b) => a - b)
	const t = clean(target)
	let sum = 0
	for (const value of u) sum += value
	if (sum <= t) return null
	let remaining = t
	const n = u.length
	for (let i = 0; i < n; i++) {
		const value = u[i] ?? 0
		if (value * (n - i) <= remaining) remaining -= value
		else return Math.floor(remaining / (n - i))
	}
	// Unreachable when sum > target; kept for totality.
	return 0
}

export interface FairShareUsage {
	readonly key: string
	readonly rows: number
	readonly bytes: number
}

export interface FairStepInput {
	readonly shares: readonly FairShareUsage[]
	/** activityLowWater(maxRows) when the row cap is active, else null. */
	readonly rowTarget: number | null
	/** E = dbBytes - activityLowWater(maxDbBytes) when the byte cap is active, else null. */
	readonly byteExcess: number | null
	/** pruneBatchRows. */
	readonly budget: number
}

export interface FairShareAllocation {
	readonly key: string
	readonly rows: number
}

export interface FairStepPlan {
	/** Key ascending, rows >= 1, sum <= budget. */
	readonly allocations: readonly FairShareAllocation[]
	readonly rowLevel: number | null
	readonly byteLevel: number | null
	/** A cap is active with excess but no share is above its level (prefix fallback, 1.12). */
	readonly residual: boolean
}

function compareKey(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0
}

/** Merges duplicate keys and sanitizes counters. */
function normalizeShares(shares: readonly FairShareUsage[]): FairShareUsage[] {
	const merged = new Map<string, { rows: number; bytes: number }>()
	for (const share of shares) {
		const key = String(share.key)
		const prev = merged.get(key)
		const rows = clean(share.rows)
		const bytes = clean(share.bytes)
		if (prev) {
			prev.rows = Math.min(prev.rows + rows, Number.MAX_SAFE_INTEGER)
			prev.bytes = Math.min(prev.bytes + bytes, Number.MAX_SAFE_INTEGER)
		} else merged.set(key, { rows, bytes })
	}
	return [...merged].map(([key, v]) => ({ key, rows: v.rows, bytes: v.bytes }))
}

/** Rows needed to free `byteOver` bytes at the share's average row size, capped at its rows. */
function rowsForBytes(rows: number, bytes: number, byteOver: number): number {
	if (rows === 0 || bytes === 0 || byteOver === 0) return 0
	const needed =
		(BigInt(byteOver) * BigInt(rows) + BigInt(bytes) - 1n) / BigInt(bytes)
	return needed >= BigInt(rows) ? rows : Number(needed)
}

export function planFairStep(input: FairStepInput): FairStepPlan {
	const shares = normalizeShares(input.shares)
	const rowLevel =
		input.rowTarget === null
			? null
			: waterLevel(
					shares.map(s => s.rows),
					input.rowTarget,
				)
	let byteLevel: number | null = null
	if (input.byteExcess !== null) {
		const e = clean(input.byteExcess)
		if (e > 0) {
			let sumBytes = 0
			for (const s of shares) sumBytes += s.bytes
			const t = sumBytes - e
			byteLevel =
				t <= 0
					? 0
					: waterLevel(
							shares.map(s => s.bytes),
							t,
						)
		}
	}

	const over: { key: string; excess: number }[] = []
	for (const s of shares) {
		const rowEx = rowLevel === null ? 0 : Math.max(0, s.rows - rowLevel)
		const byteEx =
			byteLevel === null
				? 0
				: rowsForBytes(s.rows, s.bytes, Math.max(0, s.bytes - byteLevel))
		const excess = Math.min(s.rows, Math.max(rowEx, byteEx))
		if (excess > 0) over.push({ key: s.key, excess })
	}
	const residual =
		(rowLevel !== null || byteLevel !== null) && over.length === 0
	const budget = clean(input.budget)
	if (budget < 1 || over.length === 0)
		return { allocations: [], rowLevel, byteLevel, residual }

	let allocations: FairShareAllocation[]
	if (over.length >= budget) {
		// Not enough budget for one row each: the largest excesses first, ties key ascending.
		over.sort((a, b) => b.excess - a.excess || compareKey(a.key, b.key))
		allocations = over.slice(0, budget).map(o => ({ key: o.key, rows: 1 }))
	} else {
		// One row each, then the rest proportional to (excess - 1) by largest remainder.
		let sumExcess = 0
		for (const o of over) sumExcess += o.excess
		const spend = Math.min(budget, sumExcess)
		const rest = BigInt(spend - over.length)
		const weightSum = BigInt(sumExcess - over.length)
		const parts = over.map(o => {
			const w = BigInt(o.excess - 1)
			const num = weightSum === 0n ? 0n : rest * w
			const quota = weightSum === 0n ? 0n : num / weightSum
			const remainder = weightSum === 0n ? 0n : num % weightSum
			return { key: o.key, rows: 1 + Number(quota), remainder }
		})
		let leftover = Number(rest)
		for (const p of parts) leftover -= p.rows - 1
		if (leftover > 0) {
			const order = [...parts].sort((a, b) =>
				a.remainder === b.remainder
					? compareKey(a.key, b.key)
					: a.remainder > b.remainder
						? -1
						: 1,
			)
			for (let i = 0; i < leftover && i < order.length; i++) {
				const p = order[i]
				if (p) p.rows += 1
			}
		}
		allocations = parts.map(p => ({ key: p.key, rows: p.rows }))
	}
	allocations.sort((a, b) => compareKey(a.key, b.key))
	return { allocations, rowLevel, byteLevel, residual }
}
