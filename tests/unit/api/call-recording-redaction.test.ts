/**
 * Rule six on both read routes of a stored digital call row: GET /api/activity/:eventId and the
 * raw block of GET /api/transmissions/:ref answer the same fixture the same way. A call proven
 * clear names its file; an unproven or an encrypted call names no file on either route. The
 * fixture rows are synthetic (modelled on a dsd-fme call_end row an older core stored with its
 * `wavFile`, before the ingress dropped the name of a call not proven clear).
 */
import Fastify from "fastify"
import type { FastifyInstance } from "fastify"
import { afterEach, describe, expect, it } from "vitest"
import type {
	ActivityRecord,
	ActivitySearchPage,
	ActivitySummary,
	TransmissionDto,
} from "@wavekit/api-types"
import { activityRoutes } from "../../../src/api/routes/activity.js"
import { transmissionRoutes } from "../../../src/api/routes/transmissions.js"
import type { ActivityQueryService } from "../../../src/core/activity/storage/contract.js"
import { TransmissionRegistry } from "../../../src/core/transmissions/index.js"
import { redactActivityDetail } from "../../../src/core/transmissions/redact.js"

const AT = "2026-10-16T12:00:05.000Z"
const nameOf = (n: number) =>
	`20261016_12000${n}_0123${n}_YSF_1_GROUP_TGT_100_SRC_200${n}.wav`

type Trust = "clear" | "unproven" | "encrypted"

interface CallRow {
	trust: Trust
	txId: string
	eventId: string
	name: string
	record: ActivityRecord
	summary: ActivitySummary
}

function callRow(trust: Trust, n: number): CallRow {
	const txId = `tx_01JTESTREDACT${String(n).repeat(13)}`
	const eventId = `00000000-0000-4000-8000-00000000000${n}`
	const name = nameOf(n)
	const encrypted = trust === "encrypted"
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
			title: null,
			fields: [
				{ key: "talkgroup", label: "Talkgroup", value: 100 },
				{ key: "encrypted", label: "Encrypted", value: encrypted },
				{ key: "wavFile", label: "Recording", value: name },
			],
			provenance: { sourceId: null, frequency: null },
			refs: { callId: `call-${n}`, txId },
			decodedData: {
				callId: `call-${n}`,
				protocol: "ysf",
				talkgroup: 100,
				source: 2000 + n,
				duration: 4200,
				encryptionKnown: trust !== "unproven",
				encrypted,
				flags: { encrypted },
				wavFile: name,
				recordingKey: `dsd~${name}`,
			},
		},
	}
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
		title: null,
		fields: [],
		// Only a clear call's row carries its decoder link.
		...(trust === "clear"
			? { recording: { id: `dsd~${name}`, durationMs: 4200 } }
			: {}),
	}
	return { trust, txId, eventId, name, record, summary }
}

const ROWS = [
	callRow("clear", 1),
	callRow("unproven", 2),
	callRow("encrypted", 3),
]

/** A read double answering the fixture rows by event id and txId ref. */
const service = {
	detail: (eventId: string) =>
		Promise.resolve(ROWS.find(r => r.eventId === eventId)?.record ?? null),
	search: (input: {
		query: { refs?: readonly { type: string; value: string }[] }
	}): Promise<ActivitySearchPage> => {
		const ref = input.query.refs?.[0]
		const items = ROWS.filter(
			r => ref?.type === "txId" && r.txId === ref.value,
		).map(r => r.summary)
		return Promise.resolve({
			items,
			nextPageToken: null,
			replayCursor: "c",
			snapshot: { lowBarrier: "0", highWater: "3", expiresAt: AT },
			searchCoverage: "bounded-projection",
		})
	},
} as unknown as ActivityQueryService

let app: FastifyInstance | null = null
afterEach(async () => {
	await app?.close()
	app = null
})

async function server(): Promise<FastifyInstance> {
	const a = Fastify()
	await a.register(activityRoutes, { service, enabled: true })
	await a.register(transmissionRoutes, {
		transmissions: new TransmissionRegistry({ now: () => Date.parse(AT) }),
		activity: service,
	})
	await a.ready()
	app = a
	return a
}

describe("a stored call row's recording on the Activity detail and Transmission routes", () => {
	it.each(ROWS)(
		"$trust call: both routes agree on its file name",
		async row => {
			const a = await server()
			const detail = await a.inject({
				method: "GET",
				url: `/api/activity/${row.eventId}`,
			})
			expect(detail.statusCode).toBe(200)
			const tx = await a.inject({
				method: "GET",
				url: `/api/transmissions/${row.txId}`,
			})
			expect(tx.statusCode).toBe(200)
			const dto = tx.json<TransmissionDto>()
			const raw = dto.raw.activity as ActivityRecord | null
			expect(raw?.eventId).toBe(row.eventId)
			const detailData = (
				detail.json<ActivityRecord>().payload as { decodedData: object }
			).decodedData
			const rawData = (raw?.payload as { decodedData: object }).decodedData
			if (row.trust === "clear") {
				expect(dto.privacy).toBe("clear")
				expect(detailData).toMatchObject({ wavFile: row.name })
				expect(rawData).toMatchObject({ wavFile: row.name })
			} else {
				expect(dto.privacy).toBe(row.trust)
				for (const body of [detail.body, tx.body])
					expect(body).not.toContain(row.name)
				expect(detailData).not.toHaveProperty("wavFile")
				expect(detailData).not.toHaveProperty("recordingKey")
				expect(rawData).not.toHaveProperty("wavFile")
			}
			// The same fixture, the same answer: the detail is the raw block.
			expect(detailData).toEqual(rawData)
		},
	)

	it("other record kinds and non-call rows pass the detail unchanged", () => {
		const base = ROWS[1]!.record
		if (base.kind !== "decoder-reception") throw new TypeError("fixture")
		const aprs: ActivityRecord = {
			...base,
			payload: {
				...base.payload,
				outputType: "packet",
				protocol: "aprs",
				fields: [{ key: "path", label: "Path", value: "WIDE1-1" }],
			},
		}
		expect(redactActivityDetail(aprs)).toBe(aprs)
	})

	it("a call row with malformed trust fields names no file", () => {
		const base = ROWS[0]!.record
		if (base.kind !== "decoder-reception") throw new TypeError("fixture")
		const record: ActivityRecord = {
			...base,
			payload: {
				...base.payload,
				decodedData: {
					protocol: "ysf",
					encryptionKnown: "yes",
					flags: { encrypted: "no" },
					wavFile: ROWS[0]!.name,
				},
			},
		}
		expect(JSON.stringify(redactActivityDetail(record))).not.toContain(
			ROWS[0]!.name,
		)
	})
})
