/**
 * Hand-assembled wasm modules for the loader tests: functions of i32 params returning an i32
 * constant, optional function imports from `env`, and an optional source-digest custom section
 * appended as the kernels' build.sh appends it.
 */

function uleb(n: number): number[] {
	const out: number[] = []
	do {
		let b = n & 0x7f
		n >>>= 7
		if (n !== 0) b |= 0x80
		out.push(b)
	} while (n !== 0)
	return out
}

function str(s: string): number[] {
	const bytes = [...new TextEncoder().encode(s)]
	return [...uleb(bytes.length), ...bytes]
}

function section(id: number, body: number[]): number[] {
	return [id, ...uleb(body.length), ...body]
}

function vec(items: number[][]): number[] {
	return [...uleb(items.length), ...items.flat()]
}

export interface ModuleSpec {
	/** Function imports `env.<name>`, each () -> i32. */
	imports?: string[]
	/** Exported functions: `params` i32 parameters, returning `value` (0 ≤ value < 64). */
	exports: { name: string; params: number; value: number }[]
	/** Appends the "wavekit.source-digest" custom section with this payload. */
	digest?: string
}

export function wasmModule(spec: ModuleSpec): Uint8Array {
	const imports = spec.imports ?? []
	const fnType = (params: number): number[] => [
		0x60,
		...uleb(params),
		...Array.from({ length: params }, () => 0x7f),
		0x01,
		0x7f,
	]
	// type 0: () -> i32 for the imports; then one type per export
	const types = [fnType(0), ...spec.exports.map(e => fnType(e.params))]
	const bytes = [
		0x00,
		0x61,
		0x73,
		0x6d,
		0x01,
		0x00,
		0x00,
		0x00,
		...section(1, vec(types)),
	]
	if (imports.length > 0)
		bytes.push(
			...section(
				2,
				vec(imports.map(name => [...str("env"), ...str(name), 0x00, 0x00])),
			),
		)
	bytes.push(...section(3, vec(spec.exports.map((_, i) => uleb(i + 1)))))
	bytes.push(
		...section(
			7,
			vec(
				spec.exports.map((e, i) => [
					...str(e.name),
					0x00,
					...uleb(imports.length + i),
				]),
			),
		),
	)
	bytes.push(
		...section(
			10,
			vec(
				spec.exports.map(e => {
					if (e.value < 0 || e.value >= 64) throw new RangeError("value")
					// no locals, i32.const value, end
					return [...uleb(4), 0x00, 0x41, e.value, 0x0b]
				}),
			),
		),
	)
	if (spec.digest !== undefined) bytes.push(...digestSection(spec.digest))
	return Uint8Array.from(bytes)
}

/** The custom section build.sh appends. */
export function digestSection(payload: string): number[] {
	return section(0, [
		...str("wavekit.source-digest"),
		...new TextEncoder().encode(payload),
	])
}
