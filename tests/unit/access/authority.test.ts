import {
	normalizeAuthority,
	normalizeOrigin,
} from "../../../src/access/authority.js"

describe("listener authorities and browser origins", () => {
	it.each([
		["LOCALHOST", "http", "localhost:80"],
		["receiver.lan:9000", "http", "receiver.lan:9000"],
		["receiver.lan", "https", "receiver.lan:443"],
		["127.0.0.1:080", "http", "127.0.0.1:80"],
		["[0:0:0:0:0:0:0:1]:9000", "http", "[::1]:9000"],
		["[2001:DB8::1]", "https", "[2001:db8::1]:443"],
	] as const)(
		"normalizes %s in explicit %s listener context",
		(raw, scheme, expected) => {
			expect(normalizeAuthority(raw, scheme)).toBe(expected)
		},
	)

	it.each([
		"",
		"*.lan",
		"localhost.",
		"localhost:0",
		"localhost:65536",
		"localhost:80evil",
		"localhost:80:90",
		"user@localhost",
		"localhost/path",
		"localhost?x=1",
		"localhost#x",
		"localhost\\evil",
		"localhost,evil",
		" localhost",
		"localhost\t",
		"localhost\r\nX: evil",
		"local_host",
		"-localhost",
		"localhost-",
		"localhost..lan",
		"éxample.com",
		"127.1",
		"127.000.0.1",
		"2130706433",
		"[::1]garbage",
		"::1",
		"[::1%lo0]",
		"[not-ip]",
		"[::1]:",
		"[::1]:65536",
	])("rejects ambiguous or malformed authority %j", raw => {
		expect(normalizeAuthority(raw, "http")).toBeNull()
	})

	it.each([
		["http://LOCALHOST:80", "http://localhost"],
		["https://receiver.lan:443", "https://receiver.lan"],
		["http://receiver.lan:9000", "http://receiver.lan:9000"],
		["https://[0:0:0:0:0:0:0:1]:9000", "https://[::1]:9000"],
	])("normalizes serialized origin %s", (raw, expected) => {
		expect(normalizeOrigin(raw)).toBe(expected)
	})

	it.each([
		"null",
		"file://localhost",
		"ws://localhost",
		"http://localhost/",
		"http://localhost/path",
		"http://localhost?x=1",
		"http://localhost#x",
		"http://user@localhost",
		"http://localhost http://evil",
		"http://localhost,http://evil",
		"http://*.localhost",
		"http://127.1",
		"http://localhost\\evil",
	])("rejects non-origin or ambiguous origin %j", raw => {
		expect(normalizeOrigin(raw)).toBeNull()
	})
})
import { describe, expect, it } from "vitest"
