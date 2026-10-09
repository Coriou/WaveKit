#!/usr/bin/env node
// Read-only accessor so bash/python read the same v2 fields that
// tests/integration/fixtures/manifest.ts validates (Zod lives there).
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { parse } from "yaml"

const here = dirname(fileURLToPath(import.meta.url))
const path =
	process.env.WAVEKIT_FIXTURES_MANIFEST ?? join(here, "manifest.yaml")
const doc = parse(readFileSync(path, "utf8"))
if (!doc || doc.version !== 2 || !Array.isArray(doc.fixtures)) {
	process.stderr.write(`${path}: expected a version 2 manifest\n`)
	process.exit(2)
}
const [command, id] = process.argv.slice(2)
if (command === "list") {
	for (const f of doc.fixtures) {
		const fetch = f.fetch ?? {}
		process.stdout.write(
			[
				f.id,
				fetch.kind ?? "",
				fetch.url ?? "",
				fetch.member ?? "",
				fetch.transform ?? "none",
				f.file ?? "",
				f.sha256 ?? "",
				fetch.archive_sha256 ?? "",
				String(f.large === true),
				fetch.recipe ?? "",
			].join("|") + "\n",
		)
	}
} else if (command === "get" && id) {
	const f = doc.fixtures.find(x => x.id === id)
	if (!f) {
		process.stderr.write(`unknown fixture ${id}\n`)
		process.exit(3)
	}
	process.stdout.write(JSON.stringify(f) + "\n")
} else {
	process.stderr.write("usage: manifest-query.mjs list | get <id>\n")
	process.exit(2)
}
