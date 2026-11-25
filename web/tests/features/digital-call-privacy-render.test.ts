// An encrypted digital call and an unproven one, opened from Activity, render in the Transmission view and in the
// Activity detail with no player, no file name, no recording key and no download, even while the catalogue lists
// a file named after each call. The core answers as rule six says (no `recording` link on either row, no
// `wavFile` in either record); the rows and file names are synthetic.
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import type { Root } from "react-dom/client"
import { afterEach, describe, expect, it } from "vitest"
import type {
	ActivityRecord,
	ActivitySummary,
	RecordingInventoryItem,
} from "@wavekit/api-types"

import { ServicesContext } from "../../src/app/context.ts"
import { createServices, type AppServices } from "../../src/app/services.ts"
import { ActivityDetail } from "../../src/features/activity/ActivityDetail.tsx"
import { clearTransmissionCache } from "../../src/features/transmission/load.ts"
import { TransmissionView } from "../../src/features/transmission/TransmissionView.tsx"
import { FakeElement, FakeNode, installFakeDom } from "../shell/fake-dom.ts"

const AT = "2026-10-16T12:00:05.000Z"

type Trust = "encrypted" | "unproven"

interface Call {
	trust: Trust
	eventId: string
	name: string
	summary: ActivitySummary
	record: ActivityRecord
	file: RecordingInventoryItem
}

function call(trust: Trust, n: number): Call {
	const eventId = `00000000-0000-4000-8000-00000000010${n}`
	const name = `20261016_12000${n}_0456${n}_YSF_1_GROUP_TGT_100_SRC_300${n}.wav`
	const encrypted = trust === "encrypted"
	const fields = [
		{ key: "talkgroup", label: "Talkgroup", value: "100" },
		{ key: "source", label: "Radio", value: `300${n}` },
		{ key: "encrypted", label: "Encrypted", value: encrypted },
	]
	// No `recording`: the core links a call's file only when the call is proven clear.
	const summary: ActivitySummary = {
		eventId,
		commitSeq: String(n),
		kind: "decoder-reception",
		producedAt: AT,
		receivedAt: AT,
		decoderId: "dsd-a",
		sourceId: null,
		protocol: "ysf",
		category: "voice",
		frequencyHz: null,
		entityKey: null,
		title: `TG 100 · radio 300${n}`,
		fields,
	}
	const record: ActivityRecord = {
		version: 1,
		eventId,
		commitSeq: String(n),
		producedAt: AT,
		receivedAt: AT,
		kind: "decoder-reception",
		payload: {
			version: 1,
			eventId,
			producedAt: AT,
			receivedAt: AT,
			decoderId: "dsd-a",
			decoderType: "dsd-fme",
			outputType: "call_end",
			protocol: "ysf",
			category: "voice",
			entityKey: null,
			title: summary.title,
			fields,
			provenance: { sourceId: null, frequency: null },
			refs: { callId: `call-${n}` },
			// As GET /api/activity/:eventId answers it: the file name stripped (rule six).
			decodedData: {
				callId: `call-${n}`,
				protocol: "ysf",
				talkgroup: 100,
				source: 3000 + n,
				duration: 4200,
				encryptionKnown: trust !== "unproven",
				encrypted,
				flags: { encrypted },
			},
		},
	}
	// A file the catalogue lists under the call's name (the bait).
	const file = {
		id: `dsd:0~${name}`,
		key: `dsd~${name}`,
		kind: "dsd-fme-call",
		decoderId: "dsd-a",
		discoveryId: null,
		ownerDiscoveryId: null,
		observationId: null,
		activityEventId: eventId,
		fileName: name,
		bytes: 67_244,
		durationMs: 4200,
		startedAt: AT,
		modifiedAt: AT,
		frequencyHz: null,
		talkgroup: "100",
		source: `300${n}`,
		facts: null,
	} as unknown as RecordingInventoryItem
	return { trust, eventId, name, summary, record, file }
}

const CALLS = [call("encrypted", 1), call("unproven", 2)]

const answer = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	})

/** The core as these calls leave it: their records, no link, the catalogue still naming their files. */
function services(): AppServices {
	return createServices({
		fetch: (input: string) => {
			const url = new URL(input, "http://core.test")
			const detail = /^\/api\/activity\/([^/]+)$/.exec(url.pathname)
			if (detail) {
				const c = CALLS.find(x => x.eventId === detail[1])
				return Promise.resolve(
					c ? answer(200, c.record) : answer(404, { code: "NOT_FOUND" }),
				)
			}
			if (url.pathname === "/api/recordings")
				return Promise.resolve(
					answer(200, {
						items: CALLS.map(c => c.file),
						nextPageToken: null,
					}),
				)
			if (
				url.pathname === "/api/activity" ||
				url.pathname === "/api/scanner/discoveries"
			)
				return Promise.resolve(answer(200, { items: [], nextPageToken: null }))
			return Promise.resolve(answer(404, { code: "NOT_FOUND" }))
		},
		createSocket: () => ({
			readyState: 0,
			onopen: null,
			onclose: null,
			onerror: null,
			onmessage: null,
			send: () => undefined,
			close: () => undefined,
		}),
	})
}

/** Every tag, attribute and text of a mounted tree, as one string to search. */
function dump(node: FakeNode): string {
	if (!(node instanceof FakeElement)) return node.nodeValue ?? ""
	const attrs = [...node.attributes].map(([k, v]) => ` ${k}="${v}"`).join("")
	return `<${node.tagName}${attrs}>${node.childNodes.map(dump).join("")}</${node.tagName}>`
}

/** The tags of the elements in the tree that carry attribute `name` with a value matching `test`. */
function withAttr(node: FakeNode, name: string, test: RegExp): string[] {
	if (!(node instanceof FakeElement)) return []
	const value = node.getAttribute(name)
	const own = value !== null && test.test(value) ? [node.tagName] : []
	return [...own, ...node.childNodes.flatMap(c => withAttr(c, name, test))]
}

function expectNoAudio(tree: FakeNode, c: Call): void {
	const html = dump(tree)
	expect(html).not.toContain(c.name)
	expect(html).not.toContain(c.file.key ?? "")
	expect(html).not.toMatch(/\.wav|dsd~|dsd:0/)
	expect(html).not.toContain("Download")
	expect(html).not.toMatch(/<AUDIO|<VIDEO/)
	expect(withAttr(tree, "aria-label", /^(Play|Pause) /)).toEqual([])
	expect(withAttr(tree, "aria-label", /^Recording$/)).toEqual([])
	expect(withAttr(tree, "href", /./)).toEqual([])
	expect(withAttr(tree, "download", /.*/)).toEqual([])
}

describe("an encrypted or unproven digital call shows no audio", () => {
	let dom: ReturnType<typeof installFakeDom> | null = null
	let root: Root | null = null
	let open: AppServices | null = null
	const g = globalThis as Record<string, unknown>
	const oldNode = g["Node"]
	afterEach(() => {
		if (root) act(() => root?.unmount())
		root = null
		open?.dispose()
		open = null
		dom?.restore()
		dom = null
		if (oldNode === undefined) delete g["Node"]
		else g["Node"] = oldNode
		clearTransmissionCache()
	})

	async function mount(node: ReturnType<typeof createElement>) {
		const s = services()
		open = s
		dom = installFakeDom()
		g["Node"] = FakeNode
		const container = dom.doc.createElement("div")
		dom.doc.body.appendChild(container)
		const mounted = createRoot(container as unknown as HTMLElement)
		root = mounted
		act(() =>
			mounted.render(
				createElement(ServicesContext.Provider, { value: s }, node),
			),
		)
		// the reads answer from the script: let them settle and the view render
		for (let i = 0; i < 20; i++)
			await act(async () => {
				await new Promise(resolve => setTimeout(resolve, 0))
			})
		return container
	}

	it.each(CALLS)(
		"the Transmission view of the $trust call: no player, file name or download",
		async c => {
			const tree = await mount(
				createElement(TransmissionView, {
					open: {
						ref: { event: c.eventId },
						origin: { host: "activity", label: "Activity" },
						summary: c.summary,
					},
					onBack: () => undefined,
				}),
			)
			const html = dump(tree)
			// it rendered the call, not a loading or error note
			expect(html).toContain('aria-label="Listen"')
			expect(html).not.toContain("Loading this transmission")
			expectNoAudio(tree, c)
		},
	)

	it.each(CALLS)(
		"the Activity detail of the $trust call: no player, file name or download",
		async c => {
			const tree = await mount(
				createElement(ActivityDetail, {
					item: c.summary,
					eventId: c.eventId,
					onBack: () => undefined,
				}),
			)
			const html = dump(tree)
			expect(html).toContain("TG 100")
			expectNoAudio(tree, c)
		},
	)
})
