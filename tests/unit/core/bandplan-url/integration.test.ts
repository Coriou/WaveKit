import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createServer, request as httpsRequest, type Server } from "node:https"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BandPlansError } from "../../../../src/core/bandplans/contract.js"
import {
	createBandPlanUrlFetcher,
	type BandPlanUrlRequest,
} from "../../../../src/core/bandplan-url/index.js"
import { HOSTS } from "./helpers.js"

const HOST = "raw.githubusercontent.com"

function makeCert(): { key: string; cert: string } | undefined {
	const dir = mkdtempSync(join(tmpdir(), "wk-bpurl-"))
	try {
		execFileSync(
			"openssl",
			[
				"req",
				"-x509",
				"-newkey",
				"ec",
				"-pkeyopt",
				"ec_paramgen_curve:prime256v1",
				"-nodes",
				"-days",
				"1",
				"-subj",
				`/CN=${HOST}`,
				"-addext",
				`subjectAltName=DNS:${HOST}`,
				"-keyout",
				join(dir, "k.pem"),
				"-out",
				join(dir, "c.pem"),
			],
			{ stdio: "ignore", timeout: 10_000 },
		)
		return {
			key: readFileSync(join(dir, "k.pem"), "utf8"),
			cert: readFileSync(join(dir, "c.pem"), "utf8"),
		}
	} catch {
		return undefined
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
}

const pair = makeCert()
const seen: {
	host: string | undefined
	encoding: string | undefined
	path: string
}[] = []
let server: Server | undefined
let port = 0

beforeAll(async () => {
	if (!pair) return
	server = createServer(pair, (req, res) => {
		seen.push({
			host: req.headers.host,
			encoding: req.headers["accept-encoding"] as string,
			path: req.url ?? "",
		})
		if (req.url === "/redirect") {
			res.writeHead(302, { location: `https://${HOST}/plan.csv` })
			res.end()
			return
		}
		res.writeHead(200, { "content-type": "text/csv; charset=utf-8" })
		res.end("Name,Frequency\nA,145500000\n")
	})
	await new Promise<void>(r => server?.listen(0, "127.0.0.1", r))
	port = (server.address() as AddressInfo).port
})
afterAll(async () => {
	await new Promise<void>(r => (server ? server.close(() => r()) : r()))
})

/** Test seam: the real https.request, redirected to the local port and trusting the test CA. */
const toLocal =
	(trust: boolean): BandPlanUrlRequest =>
	(options, onResponse) =>
		httpsRequest(
			{ ...options, port, ...(trust && pair ? { ca: pair.cert } : {}) },
			onResponse,
		)
const loopbackResolve = () =>
	Promise.resolve([{ address: "127.0.0.1", family: 4 }])

describe.skipIf(!pair)(
	"local https integration (openssl self-signed cert)",
	() => {
		it("the default policy refuses 127.0.0.1 before connecting", async () => {
			const fetcher = createBandPlanUrlFetcher({
				resolve: loopbackResolve,
				request: toLocal(true),
			})
			const before = seen.length
			await expect(
				fetcher(`https://${HOST}/plan.csv`, HOSTS),
			).rejects.toMatchObject({
				code: "BANDPLANS_URL_REFUSED",
			})
			expect(seen.length).toBe(before)
		})

		it("fetches over verified TLS with SNI and Host set to the allowlisted host", async () => {
			const fetcher = createBandPlanUrlFetcher({
				resolve: loopbackResolve,
				request: toLocal(true),
				addressPolicy: () => true, // explicit permissive test hook
			})
			const out = await fetcher(`https://${HOST}/plan.csv?x=1`, HOSTS)
			expect(Buffer.from(out.bytes).toString()).toContain("A,145500000")
			expect(out.contentType).toBe("text/csv")
			expect(seen.at(-1)).toEqual({
				host: HOST,
				encoding: "identity",
				path: "/plan.csv?x=1",
			})
		})

		it("does not follow a 302", async () => {
			const fetcher = createBandPlanUrlFetcher({
				resolve: loopbackResolve,
				request: toLocal(true),
				addressPolicy: () => true,
			})
			const before = seen.length
			await expect(
				fetcher(`https://${HOST}/redirect`, HOSTS),
			).rejects.toMatchObject({
				code: "BANDPLANS_URL_FETCH_FAILED",
			})
			expect(seen.length).toBe(before + 1)
		})

		it("TLS failure (untrusted certificate) is FETCH_FAILED", async () => {
			const fetcher = createBandPlanUrlFetcher({
				resolve: loopbackResolve,
				request: toLocal(false),
				addressPolicy: () => true,
			})
			const error: unknown = await fetcher(
				`https://${HOST}/plan.csv`,
				HOSTS,
			).catch((e: unknown) => e)
			expect(error).toBeInstanceOf(BandPlansError)
			expect((error as BandPlansError).code).toBe("BANDPLANS_URL_FETCH_FAILED")
		})
	},
)
