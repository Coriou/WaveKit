/** Single-entry memo keyed on argument identity (Object.is). */
export function memoOne<A extends readonly unknown[], R>(
	fn: (...args: A) => R,
): (...args: A) => R {
	let last: { args: A; result: R } | null = null
	return (...args: A): R => {
		if (
			last !== null &&
			last.args.length === args.length &&
			last.args.every((a, i) => Object.is(a, args[i]))
		) {
			return last.result
		}
		const result = fn(...args)
		last = { args, result }
		return result
	}
}
