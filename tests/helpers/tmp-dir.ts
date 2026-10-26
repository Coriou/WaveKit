import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll } from "vitest"

const directories = new Set<string>()

// Suite-scoped fixtures can be created during collection and shared by several tests.
afterAll(() => {
	for (const directory of directories) {
		rmSync(directory, { recursive: true, force: true })
		directories.delete(directory)
	}
})

/** Allocate a private directory that is reclaimed even when an assertion fails. */
export function makeTmpDir(prefix: string): string {
	const directory = mkdtempSync(join(tmpdir(), prefix))
	directories.add(directory)
	return directory
}
