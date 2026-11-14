/**
 * Contract with the real core in protected mode (harness.ts): what it answers to the wrong
 * loopback name is what the web app's notice and the web server's redirect are built on.
 * Opt-in with the other contract suite: WAVEKIT_LIVE_CORE_TESTS=1.
 */
import * as http from "node:http"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { canonicalHostRedirect, readProbe } from "../../build/canonical-host.ts"
import type { FetchLike } from "../../src/data/api-client.ts"
import { createDataLayer } from "../../src/data/index.ts"
import { connectionNotice } from "../../src/features/connection/notice.ts"
import { fakeSockets } from "../data/fake-socket.ts"
import { LOOPBACK, startRealCore, type RealCore } from "./harness.ts"

const enabled = process.env["WAVEKIT_LIVE_CORE_TESTS"] === "1"

/** GET `path` on the core with the Host header a browser at `name` sends. */
function getAs(
	core: RealCore,
	name: string,
	path: string,
): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const request = http.request(
			{
				host: LOOPBACK,
				port: core.apiPort,
				path,
				setHost: false,
				headers: { host: `${name}:${core.apiPort}` },
			},
			response => {
				let body = ""
				response.setEncoding("utf8")
				response.on("data", (chunk: string) => (body += chunk))
				response.on("end", () =>
					resolve({ status: response.statusCode ?? 0, body }),
				)
			},
		)
		request.on("error", reject)
		request.end()
	})
}

describe.skipIf(!enabled)("a protected core and the page's address", () => {
	let core: RealCore

	beforeAll(async () => {
		core = await startRealCore({ protectedOrigins: [] })
	}, 120_000)

	afterAll(async () => {
		await core?.stop()
	}, 60_000)

	it("answers 403 HOST_FORBIDDEN to localhost and the bootstrap to 127.0.0.1", async () => {
		const refused = await getAs(core, "localhost", "/api/access/bootstrap")
		expect(refused.status).toBe(403)
		expect(JSON.parse(refused.body)).toMatchObject({ code: "HOST_FORBIDDEN" })
		const accepted = await getAs(core, LOOPBACK, "/api/access/bootstrap")
		expect(accepted.status).toBe(200)
		// what the web server's probe reads (build/canonical-host.ts readProbe)
		expect(readProbe(refused.status, refused.body)).toBe("refused")
		expect(readProbe(accepted.status, accepted.body)).toBe("accepted")
	})

	it("the web server's redirect sends localhost to 127.0.0.1 and leaves 127.0.0.1 alone", async () => {
		expect(
			await canonicalHostRedirect(
				`localhost:${core.apiPort}`,
				"/#/map",
				core.apiPort,
			),
		).toBe(`http://${LOOPBACK}:${core.apiPort}/#/map`)
		expect(
			await canonicalHostRedirect(
				`${LOOPBACK}:${core.apiPort}`,
				"/",
				core.apiPort,
			),
		).toBeNull()
	})

	it("a page under localhost reads the refusal and links to 127.0.0.1", async () => {
		const fetch: FetchLike = async url => {
			const answer = await getAs(core, "localhost", url)
			return new Response(answer.body, {
				status: answer.status,
				headers: { "content-type": "application/json" },
			})
		}
		const data = createDataLayer({ fetch, createSocket: fakeSockets().factory })
		await data.start()
		const page = `http://localhost:${core.apiPort}/`
		expect(data.access.get()).toMatchObject({
			access: null,
			code: "HOST_FORBIDDEN",
		})
		expect(
			connectionNotice("closed", data.access.get(), false, page),
		).toMatchObject({
			title: "This address is not accepted",
			detail: `Open ${LOOPBACK}:${core.apiPort} instead`,
			href: `http://${LOOPBACK}:${core.apiPort}/`,
		})
		data.dispose()
	})
})
