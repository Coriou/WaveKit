/** Least recently attempted candidates precede retries; priors break ties only. */
export class TrialRotation {
	private readonly history = new Map<string, Map<string, number>>()
	private sequence = 0

	order<T>(
		key: string,
		candidates: readonly T[],
		id: (value: T) => string,
	): T[] {
		const seen = this.history.get(key)
		return [...candidates].sort(
			(a, b) => (seen?.get(id(a)) ?? 0) - (seen?.get(id(b)) ?? 0),
		)
	}

	attempt(key: string, candidate: string): void {
		const seen = this.history.get(key) ?? new Map<string, number>()
		seen.set(candidate, ++this.sequence)
		this.history.delete(key)
		this.history.set(key, seen)
		// Bounded by 4 096 active/recent discovery channels, not observation count.
		if (this.history.size > 4096) {
			const oldest = this.history.keys().next().value
			if (oldest !== undefined) this.history.delete(oldest)
		}
	}
}
