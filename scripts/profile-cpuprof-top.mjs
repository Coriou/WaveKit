#!/usr/bin/env node
// Top functions of a V8 .cpuprofile (node --cpu-prof output).
//   node scripts/profile-cpuprof-top.mjs <file.cpuprofile> [--top 15] [--exclude fnA,fnB]
//     [--from-s 20 --to-s 65] [--inclusive] [--callers fnA,fnB [--depth 6]] [--focus fn]
// Self time is sampled time with the function at the top of the stack, weighted by
// each sample's interval (the gap to the next sample, as DevTools does). "(idle)",
// "(program)" and "(garbage collector)" are kept so the shares add up to 100 %.
// --exclude drops every sample with a listed function on its stack (harness setup);
// --from-s / --to-s keep only samples in that window from the profile start.
// --inclusive adds a table of inclusive time (each function counted once per sample).
// --callers adds, per listed function name, its inclusive time grouped by the caller
// chain above its outermost frame on the stack (--depth frames, nearest first).
// --focus keeps only samples with that function on the stack (shares stay of all busy
// time), so --inclusive then breaks down what runs under it.
// Frames in an unminified esbuild bundle (dist/*.js) are labelled with the source
// module from the bundle's `// src/...` boundary comments when the file is readable.
import { existsSync, readFileSync } from "node:fs"
import { basename } from "node:path"
import { fileURLToPath } from "node:url"

const file = process.argv[2]
if (!file) {
	process.stderr.write(
		"usage: profile-cpuprof-top.mjs <file.cpuprofile> [--top 15] [--inclusive] [--callers fn,fn] [--depth 6]\n",
	)
	process.exit(2)
}
const argOf = name => {
	const i = process.argv.indexOf(name)
	return i > 0 ? process.argv[i + 1] : undefined
}
const top = Number(argOf("--top")) || 15
const depth = Number(argOf("--depth")) || 6
const exclude = new Set((argOf("--exclude") ?? "").split(",").filter(Boolean))
const callers = (argOf("--callers") ?? "").split(",").filter(Boolean)
const wantInclusive = process.argv.includes("--inclusive")
const focus = argOf("--focus")

const prof = JSON.parse(readFileSync(file, "utf8"))
const byId = new Map(prof.nodes.map(n => [n.id, n]))
const parent = new Map()
for (const n of prof.nodes)
	for (const c of n.children ?? []) parent.set(c, n.id)

/** Bundle line -> source module, from esbuild's `// src/x.ts` boundary comments. */
const bundles = new Map()
function moduleAt(url, line) {
	if (!url.startsWith("file://") || !url.endsWith(".js")) return ""
	let index = bundles.get(url)
	if (index === undefined) {
		index = []
		const path = fileURLToPath(url)
		if (existsSync(path)) {
			const lines = readFileSync(path, "utf8").split("\n")
			for (let i = 0; i < lines.length; i++) {
				const m = /^\/\/ ((?:src|packages|node_modules)\/\S+)$/.exec(lines[i])
				if (m) index.push([i, m[1]])
			}
		}
		bundles.set(url, index)
	}
	let lo = 0
	let hi = index.length - 1
	let found = ""
	while (lo <= hi) {
		const mid = (lo + hi) >> 1
		if (index[mid][0] <= line) {
			found = index[mid][1]
			lo = mid + 1
		} else hi = mid - 1
	}
	return found.replace(/^node_modules\/\.pnpm\/[^/]+\/node_modules\//, "")
}

const keyCache = new Map()
function keyOf(id) {
	let k = keyCache.get(id)
	if (k !== undefined) return k
	const cf = byId.get(id)?.callFrame
	if (!cf) return "?"
	const name = cf.functionName || "(anonymous)"
	const mod = cf.url ? moduleAt(cf.url, cf.lineNumber) : ""
	const where = cf.url ? `${basename(cf.url)}:${cf.lineNumber + 1}` : ""
	k = [name, mod ? `[${mod}]` : "", where].filter(Boolean).join(" ")
	keyCache.set(id, k)
	return k
}
const nameOf = id => byId.get(id)?.callFrame.functionName ?? ""
const stackOf = id => {
	const out = []
	for (let cur = id; cur !== undefined; cur = parent.get(cur)) out.push(cur)
	return out // leaf first
}

const deltas = prof.timeDeltas ?? []
const secArg = name => {
	const v = Number(argOf(name))
	return argOf(name) !== undefined && Number.isFinite(v) ? v * 1e6 : null
}
const fromUs = secArg("--from-s")
const toUs = secArg("--to-s")
const weights = new Map()
let totalUs = 0
let samples = 0
let keptUs = 0
let atUs = 0
/** Busy time --focus dropped, so shares stay relative to all busy time. */
let otherBusyUs = 0
prof.samples.forEach((id, i) => {
	atUs += deltas[i] ?? 0
	// The interval a sample covers runs to the next one; the last sample reuses its own.
	// Clip it to the requested window so a sparse sample cannot borrow time outside it.
	const span = Math.max(0, deltas[i + 1] ?? deltas[i] ?? 0)
	const start = Math.max(atUs, fromUs ?? atUs)
	const end = Math.min(atUs + span, toUs ?? atUs + span)
	const us = Math.max(0, end - start)
	if (us === 0 && (fromUs !== null || toUs !== null)) return
	totalUs += us
	if (exclude.size > 0 && stackOf(id).some(s => exclude.has(nameOf(s)))) return
	if (
		focus !== undefined &&
		!nameOf(id).startsWith("(idle)") &&
		!stackOf(id).some(s => nameOf(s) === focus)
	) {
		otherBusyUs += us
		return
	}
	weights.set(id, (weights.get(id) ?? 0) + us)
	keptUs += us
	samples++
})

const self = new Map()
for (const [id, us] of weights) {
	const k = keyOf(id)
	self.set(k, (self.get(k) ?? 0) + us)
}
let idle = 0
for (const [k, us] of self) if (k.startsWith("(idle)")) idle += us
const busyUs = Math.max(1, keptUs - idle + otherBusyUs)
const W = 96
const pct = (us, of) => ((100 * us) / Math.max(1, of)).toFixed(1)
const out = s => process.stdout.write(`${s}\n`)

out(
	`${basename(file)}: ${samples} samples over ${(totalUs / 1e6).toFixed(1)} s, idle ${pct(idle, keptUs)} % of sampled time`,
)
out(
	`${"self: function".padEnd(W)} ${"self %".padStart(7)} ${"of busy %".padStart(10)} ${"self ms".padStart(10)}`,
)
for (const [k, us] of [...self.entries()]
	.sort((a, b) => b[1] - a[1])
	.slice(0, top)) {
	const busy = k.startsWith("(idle)") ? "" : pct(us, busyUs)
	out(
		`${k.slice(0, W).padEnd(W)} ${pct(us, keptUs).padStart(7)} ${busy.padStart(10)} ${(us / 1000).toFixed(1).padStart(10)}`,
	)
}

if (wantInclusive) {
	const incl = new Map()
	for (const [id, us] of weights) {
		const seen = new Set()
		for (const s of stackOf(id)) {
			const k = keyOf(s)
			if (seen.has(k) || k.startsWith("(root)")) continue
			seen.add(k)
			incl.set(k, (incl.get(k) ?? 0) + us)
		}
	}
	// All frames, then only frames from bundled app modules (node internals hide them).
	for (const [title, keep] of [
		["inclusive: function", k => !k.startsWith("(idle)")],
		["inclusive, app modules only", k => / \[(src|packages)\//.test(k)],
	]) {
		out("")
		out(
			`${title.padEnd(W)} ${"of busy %".padStart(10)} ${"incl ms".padStart(10)}`,
		)
		for (const [k, us] of [...incl.entries()]
			.filter(([k]) => keep(k))
			.sort((a, b) => b[1] - a[1])
			.slice(0, top))
			out(
				`${k.slice(0, W).padEnd(W)} ${pct(us, busyUs).padStart(10)} ${(us / 1000).toFixed(1).padStart(10)}`,
			)
	}
}

for (const target of callers) {
	const chains = new Map()
	let inclUs = 0
	for (const [id, us] of weights) {
		const stack = stackOf(id)
		let outer = -1
		for (let i = 0; i < stack.length; i++)
			if (nameOf(stack[i]) === target) outer = i
		if (outer < 0) continue
		inclUs += us
		const chain = stack
			.slice(outer + 1, outer + 1 + depth)
			.filter(s => !keyOf(s).startsWith("(root)"))
			.map(keyOf)
			.join("\n      < ")
		chains.set(chain, (chains.get(chain) ?? 0) + us)
	}
	out("")
	out(
		`callers of ${target}: ${(inclUs / 1000).toFixed(1)} ms inclusive, ${pct(inclUs, busyUs)} % of busy, ${chains.size} chains (depth ${depth}, nearest caller first)`,
	)
	for (const [chain, us] of [...chains.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, top))
		out(
			`  ${pct(us, busyUs).padStart(5)} % busy ${(us / 1000).toFixed(1).padStart(8)} ms  ${chain || "(no caller)"}`,
		)
}
