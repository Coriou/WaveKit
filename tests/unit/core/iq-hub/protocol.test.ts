import * as os from "node:os"
import { describe, expect, it } from "vitest"
import { LineSplitter } from "../../../../src/core/iq-hub/hub-process.js"
import {
	encodeHubRequest,
	hubCloseCode,
	hubHello,
	hubRcvBufBytes,
	isHubHello,
	parseHubEvent,
} from "../../../../src/core/iq-hub/protocol.js"
import { isIntakeFault } from "../../../../src/core/source-manager-connect-failure.js"

describe("hub protocol", () => {
	it("parses the events the crate emits and refuses malformed ones", () => {
		expect(
			parseHubEvent(
				'{"v":1,"type":"front-placed","mono":12.5,"sink":"front-1","frontBytes":5,"atSourcePos":100,"sinkByte":40,"queuedBytes":0,"sourcePos":120}',
			),
		).toMatchObject({ type: "front-placed", atSourcePos: 100, sinkByte: 40 })
		expect(
			parseHubEvent(
				'{"v":1,"type":"closed","mono":1,"attempt":3,"phase":"connect","reason":"refused","errno":61,"connectSeq":4}',
			),
		).toMatchObject({ type: "closed", reason: "refused", errno: 61 })
		expect(parseHubEvent("{")).toBeNull()
		expect(
			parseHubEvent('{"v":1,"type":"closed","mono":1,"attempt":3}'),
		).toBeNull()
		expect(
			parseHubEvent(
				'{"v":1,"type":"sink-gap","mono":1,"sink":"bad id!","atSinkByte":0,"atSourcePos":0,"droppedBytes":2,"cause":"lag"}',
			),
		).toBeNull()
		expect(parseHubEvent('{"v":1,"type":"unknown-event","mono":1}')).toBeNull()
	})

	it("encodes requests as one line with seq", () => {
		expect(
			encodeHubRequest({ type: "abort", attempt: 2, mode: "now" }, 7),
		).toBe('{"v":1,"type":"abort","attempt":2,"mode":"now","seq":7}\n')
	})

	it("the hello is recognised exactly", () => {
		expect(isHubHello(hubHello("front-12"))).toBe(true)
		expect(isHubHello(Buffer.from(hubHello("front-12")))).toBe(true)
		expect(isHubHello(Buffer.from([1, 0, 0, 0, 1]))).toBe(false)
		expect(isHubHello('{"v":1,"sink":"x"}')).toBe(false)
	})

	it("maps a closed attempt to a net-like code, errno first", () => {
		expect(hubCloseCode("refused")).toBe("ECONNREFUSED")
		expect(hubCloseCode("refused", os.constants.errno.ECONNREFUSED)).toBe(
			"ECONNREFUSED",
		)
		expect(hubCloseCode("error", os.constants.errno.ENETUNREACH)).toBe(
			"ENETUNREACH",
		)
		expect(hubCloseCode("timeout")).toBe("ETIMEDOUT")
		expect(hubCloseCode("unreachable")).toBe("EHOSTUNREACH")
		expect(hubCloseCode("reset", 999_999)).toBe("ECONNRESET")
		expect(hubCloseCode("error")).toBe("EIO")
	})

	it("sizes the upstream receive buffer per the crate table", () => {
		expect(hubRcvBufBytes(2_048_000)).toBe(5_242_880)
		expect(hubRcvBufBytes(4_800_000)).toBe(11_534_336)
		expect(hubRcvBufBytes(6_400_000)).toBe(15_728_640)
		expect(hubRcvBufBytes(64_000_000)).toBe(32 * 1024 * 1024)
		expect(hubRcvBufBytes(8000)).toBe(1024 * 1024)
	})

	it("IQHUB_* codes are intake faults; receiver codes are not (M2)", () => {
		expect(isIntakeFault({ code: "IQHUB_EXITED" })).toBe(true)
		expect(isIntakeFault({ code: "IQHUB_HUNG" })).toBe(true)
		expect(isIntakeFault({ code: "ECONNRESET" })).toBe(false)
		expect(isIntakeFault(null)).toBe(false)
	})

	it("splits lines across chunks and skips an oversized line", () => {
		const lines: string[] = []
		const splitter = new LineSplitter(8, line => lines.push(line))
		splitter.push(Buffer.from("ab"))
		splitter.push(Buffer.from("c\nlong-line-over\nok\n\n"))
		splitter.push(Buffer.from("x"))
		splitter.push(Buffer.from("y\n"))
		expect(lines).toEqual(["abc", "ok", "xy"])
		expect(splitter.oversized).toBe(1)
	})
})
