// Joins class names, skipping empty values. Recipe components add the caller's className after the recipe class.
export function cx(
	...parts: ReadonlyArray<string | false | null | undefined>
): string {
	return parts.filter(Boolean).join(" ")
}

// A boolean data attribute in React: present (empty string) when on, absent when off.
export function flag(on: boolean | undefined): "" | undefined {
	return on ? "" : undefined
}
