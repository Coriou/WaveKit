// Feature: web-gaps-4, Property 5: Storage totals
// Validates: Requirements 3.2, 3.4, 3.5
import fc from "fast-check"
import { describe, expect, it } from "vitest"

import type { StorageAreaSource } from "../../../../src/core/storage-report/contract.js"
import { scanStorageAreas } from "../../../../src/core/storage-report/scan.js"
import { createFakeFs } from "./fake-fs.js"
import type { FakeNode } from "./fake-fs.js"

type Tree =
	| { kind: "file"; size: number }
	| { kind: "link"; size: number }
	| { kind: "dir"; children: Tree[] }

const treeArb = fc.letrec<{ tree: Tree }>(tie => ({
	tree: fc.oneof(
		{ depthSize: "small", withCrossShrink: true },
		fc.record({
			kind: fc.constant("file" as const),
			size: fc.nat({ max: 10_000 }),
		}),
		fc.record({
			kind: fc.constant("link" as const),
			size: fc.integer({ min: 1, max: 200 }),
		}),
		fc.record({
			kind: fc.constant("dir" as const),
			children: fc.array(tie("tree"), { maxLength: 4 }),
		}),
	),
}))

interface Model {
	nodes: Record<string, FakeNode>
	bytes: number
	files: number
	entries: number
	maxDepth: number
}

/** Flattens a root dir; symlinks (incl. ones pointing at ancestors) are leaf nodes. */
function build(children: Tree[]): Model {
	const m: Model = {
		nodes: { "/r": { kind: "dir" } },
		bytes: 0,
		files: 0,
		entries: 1,
		maxDepth: 0,
	}
	const stack: { p: string; depth: number; t: Tree }[] = children.map(
		(t, i) => ({ p: `/r/n${i}`, depth: 1, t }),
	)
	while (stack.length > 0) {
		const item = stack.pop()
		if (item === undefined) break
		m.entries++
		m.maxDepth = Math.max(m.maxDepth, item.depth)
		if (item.t.kind === "dir") {
			m.nodes[item.p] = { kind: "dir" }
			item.t.children.forEach((c, i) =>
				stack.push({ p: `${item.p}/n${i}`, depth: item.depth + 1, t: c }),
			)
		} else {
			m.nodes[item.p] = { kind: item.t.kind, size: item.t.size }
			m.bytes += item.t.size
			m.files++
		}
	}
	return m
}

const areas: StorageAreaSource[] = [
	{ id: "logs", paths: ["/r"], capBytes: null },
]
const rootArb = fc.array(treeArb.tree, { maxLength: 5 })

describe("Property 5: storage totals", () => {
	it("matches the model within bounds", async () => {
		await fc.assert(
			fc.asyncProperty(rootArb, async children => {
				const m = build(children)
				const [scan] = await scanStorageAreas(areas, {
					fs: createFakeFs(m.nodes),
				})
				expect(scan).toEqual({
					id: "logs",
					bytes: m.bytes,
					files: m.files,
					exists: true,
					partialReason: null,
				})
			}),
			{ numRuns: 150 },
		)
	}, 5_000)

	it("is partial iff the model exceeds a lowered bound, totals are lower bounds", async () => {
		await fc.assert(
			fc.asyncProperty(
				rootArb,
				fc.integer({ min: 1, max: 30 }),
				fc.integer({ min: 0, max: 5 }),
				fc.integer({ min: 1, max: 4 }),
				async (children, maxEntries, maxDepth, concurrency) => {
					const m = build(children)
					const [scan] = await scanStorageAreas(areas, {
						fs: createFakeFs(m.nodes),
						limits: { maxEntries, maxDepth, concurrency },
					})
					if (scan === undefined) throw new Error("no scan")
					const needsMore = m.entries > maxEntries || m.maxDepth > maxDepth
					expect(scan.partialReason !== null).toBe(needsMore)
					if (!needsMore) expect(scan.partialReason).toBeNull()
					expect(scan.bytes).toBeLessThanOrEqual(m.bytes)
					expect(scan.files).toBeLessThanOrEqual(m.files)
					if (!needsMore)
						expect([scan.bytes, scan.files]).toEqual([m.bytes, m.files])
				},
			),
			{ numRuns: 200 },
		)
	}, 5_000)
})
