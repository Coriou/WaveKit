import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

export interface FastTemp {
	mkdtemp(prefix: string): Promise<string>
	destroy(): void
}

// Plain OS temp dirs. Real fsync restarts are slow on the system disk, so the
// restart-heavy suites raise their test timeout instead (as operator-data does).
export function mountFastTemp(): FastTemp {
	const base = tmpdir()
	return {
		mkdtemp: prefix => mkdtemp(join(base, prefix)),
		destroy: () => undefined,
	}
}
