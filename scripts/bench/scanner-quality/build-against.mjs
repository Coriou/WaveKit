/**
 * Bundles the scanner quality bench (this checkout's harness and truth scorecard) against the
 * scanner of another tree: every import of `src/`, `tests/mocks/` and the workspace packages
 * (`@wavekit/api-types`, `@wavekit/shared`, from their sources) resolves in `--tree` instead
 * of here, so the same scorecard scores two revisions. The tree is any checkout of this
 * repository (a `git worktree add` of the revision); it is only read.
 *
 *   node scripts/bench/scanner-quality/build-against.mjs --tree <checkout> --out <file.mjs>
 *     [--entry <script.ts>]   (another entry than scripts/bench/scanner-quality.ts)
 *   node <file.mjs> --truth <dir> [...]
 *
 * Third-party packages stay external and load from this checkout's node_modules, so write the
 * output under this checkout (output/bench/ is ignored by git).
 */
import { existsSync } from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

const here = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")

const arg = name => {
	const i = process.argv.indexOf(`--${name}`)
	return i >= 0 ? process.argv[i + 1] : undefined
}
const treeArg = arg("tree")
const out = arg("out")
/** Another entry (a diagnostic script), default the bench itself. */
const entry = arg("entry")
if (treeArg === undefined || out === undefined) {
	process.stderr.write(
		"usage: build-against.mjs --tree <checkout> --out <file.mjs>\n",
	)
	process.exit(2)
}
const tree = resolve(treeArg)
if (!existsSync(join(tree, "src", "core", "scanner", "scanner-service.ts"))) {
	process.stderr.write("--tree is not a checkout of this repository\n")
	process.exit(2)
}

/** Paths below these resolve in the tree under test. */
const MAPPED = ["src", join("tests", "mocks"), "packages"]

/** `x.js` written for a TypeScript source resolves to `x.ts` (or `x/index.ts`) when present. */
function tsPath(p) {
	if (existsSync(p) && !p.endsWith(".js")) return p
	const base = p.endsWith(".js") ? p.slice(0, -3) : p
	for (const c of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts"), p])
		if (existsSync(c)) return c
	return null
}

const againstTree = {
	name: "against-tree",
	setup(b) {
		b.onResolve({ filter: /^@wavekit\/(api-types|shared)$/ }, args => {
			const pkg = args.path.slice("@wavekit/".length)
			return { path: join(tree, "packages", pkg, "src", "index.ts") }
		})
		b.onResolve({ filter: /^\.\.?\// }, args => {
			const abs = resolve(args.resolveDir, args.path)
			const rel = relative(here, abs)
			if (rel.startsWith("..")) return undefined
			if (!MAPPED.some(m => rel === m || rel.startsWith(m + sep)))
				return undefined
			const mapped = tsPath(join(tree, rel))
			if (mapped === null)
				return { errors: [{ text: `${rel} is not in the tree under test` }] }
			return { path: mapped }
		})
	},
}

await build({
	entryPoints: [
		entry === undefined
			? join(here, "scripts", "bench", "scanner-quality.ts")
			: resolve(entry),
	],
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
	outfile: resolve(out),
	logLevel: "warning",
	// This checkout's compiler settings for every file (the tree's own base config may need
	// packages this checkout does not have installed).
	tsconfig: join(here, "tsconfig.json"),
	plugins: [againstTree],
})
process.stdout.write(`built against ${tree}\n`)
