import { describe, expect, it } from "vitest"
import type { AccessStoreState } from "../../src/data/index.ts"
import {
	connectionNotice,
	otherLoopbackUrl,
} from "../../src/features/connection/notice.ts"

const refused = (code: string): AccessStoreState => ({
	access: null,
	error: "GET /api/access/bootstrap failed with 403",
	code,
	session: null,
})

describe("the chip when the core does not accept the page's address", () => {
	it("names the other loopback address and links to it, keeping the path and the hash", () => {
		expect(
			connectionNotice(
				"closed",
				refused("HOST_FORBIDDEN"),
				false,
				"http://localhost:5199/?x=1#/map",
			),
		).toEqual({
			title: "This address is not accepted",
			detail: "Open 127.0.0.1:5199 instead",
			busy: false,
			tone: "amber",
			pair: false,
			href: "http://127.0.0.1:5199/?x=1#/map",
		})
		expect(
			connectionNotice(
				"connecting",
				refused("ORIGIN_FORBIDDEN"),
				false,
				"http://127.0.0.1:5199/",
			),
		).toMatchObject({
			detail: "Open localhost:5199 instead",
			href: "http://localhost:5199/",
		})
	})

	it("offers no link off a loopback address: the core's access settings decide", () => {
		const notice = connectionNotice(
			"closed",
			refused("HOST_FORBIDDEN"),
			false,
			"https://radio.example/",
		)
		expect(notice).toMatchObject({
			title: "This address is not accepted",
			detail: "Allow it in the core’s access settings",
			busy: false,
		})
		expect(notice?.href).toBeUndefined()
	})

	it("still says it retries when the core cannot be reached at all", () => {
		expect(
			connectionNotice(
				"closed",
				{ access: null, error: "Network error", code: null, session: null },
				false,
				"http://localhost:5199/",
			),
		).toMatchObject({
			title: "Can’t reach the receiver",
			detail: "Retrying…",
			busy: true,
		})
	})
})

describe("otherLoopbackUrl", () => {
	it.each([
		["http://localhost:5199/a?b#c", "http://127.0.0.1:5199/a?b#c"],
		["http://127.0.0.1:5199/", "http://localhost:5199/"],
		["http://[::1]:5199/", "http://127.0.0.1:5199/"],
		["http://localhost/", "http://127.0.0.1/"],
	])("%s -> %s", (from, to) => {
		expect(otherLoopbackUrl(from)).toBe(to)
	})

	it.each([
		"https://radio.example/",
		"http://192.0.2.7:5199/",
		"http://localhost.example:5199/",
		"not a url",
	])("has none for %s", href => {
		expect(otherLoopbackUrl(href)).toBeNull()
	})
})
