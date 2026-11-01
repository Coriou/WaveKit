#!/usr/bin/env node
// Top self-time functions of a V8 .cpuprofile (node --cpu-prof output).
//   node scripts/profile-cpuprof-top.mjs <file.cpuprofile> [--top 15] [--exclude fnA,fnB]
//     [--from-s 20 --to-s 65]
// Self time is sampled time with the function at the top of the stack. "(idle)",
// "(program)" and "(garbage collector)" are kept so the shares add up to 100 %.
// --exclude drops every sample with a listed function on its stack (harness setup);
// --from-s / --to-s keep only samples in that window from the profile start.
import { readFileSync } from "node:fs"
import { basename } from "node:path"

const file = process.argv[2]
if (!file) {
	process.stderr.write(
		"usage: profile-cpuprof-top.mjs <file.cpuprofile> [--top 15]\n",
	)
	process.exit(2)
}
const topIdx = process.argv.indexOf("--top")
const top = topIdx > 0 ? Number(process.argv[topIdx + 1]) || 15 : 15

const exIdx = process.argv.indexOf("--exclude")
const exclude = new Set(
	exIdx > 0 ? (process.argv[exIdx + 1] ?? "").split(",") : [],
)

const prof = JSON.parse(readFileSync(file, "utf8"))
const byId = new Map(prof.nodes.map(n => [n.id, n]))
const parent = new Map()
for (const n of prof.nodes)
	for (const c of n.children ?? []) parent.set(c, n.id)
const excluded = id => {
	for (let cur = id; cur !== undefined; cur = parent.get(cur))
		if (exclude.has(byId.get(cur)?.callFrame.functionName)) return true
	return false
}
const counts = new Map()
const deltas = prof.timeDeltas ?? []
let totalUs = 0
let samples = 0
const secArg = name => {
	const i = process.argv.indexOf(name)
	const v = i > 0 ? Number(process.argv[i + 1]) : Number.NaN
	return Number.isFinite(v) ? v * 1e6 : null
}
const fromUs = secArg("--from-s")
const toUs = secArg("--to-s")
let atUs = 0
prof.samples.forEach((id, i) => {
	atUs += deltas[i] ?? 0
	if (fromUs !== null && atUs < fromUs) return
	if (toUs !== null && atUs > toUs) return
	if (exclude.size > 0 && excluded(id)) return
	counts.set(id, (counts.get(id) ?? 0) + 1)
	totalUs += deltas[i] ?? 0
	samples++
})

const self = new Map()
for (const [id, c] of counts) {
	const n = byId.get(id)
	if (!n) continue
	const cf = n.callFrame
	const where = cf.url ? `${basename(cf.url)}:${cf.lineNumber + 1}` : ""
	const key = `${cf.functionName || "(anonymous)"} ${where}`.trim()
	self.set(key, (self.get(key) ?? 0) + c)
}
let idle = 0
for (const [k, c] of self) if (k.startsWith("(idle)")) idle += c
const rows = [...self.entries()].sort((a, b) => b[1] - a[1])
process.stdout.write(
	`${basename(file)}: ${samples} samples over ${(totalUs / 1e6).toFixed(1)} s, idle ${((100 * idle) / samples).toFixed(1)} %\n`,
)
process.stdout.write(
	`${"function".padEnd(64)} ${"self %".padStart(7)} ${"of busy %".padStart(10)}\n`,
)
for (const [k, c] of rows.slice(0, top)) {
	const busy = k.startsWith("(idle)")
		? ""
		: ((100 * c) / Math.max(1, samples - idle)).toFixed(1)
	process.stdout.write(
		`${k.slice(0, 64).padEnd(64)} ${((100 * c) / samples).toFixed(1).padStart(7)} ${busy.padStart(10)}\n`,
	)
}
