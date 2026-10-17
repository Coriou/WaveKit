import { describe, expect, it, vi } from "vitest"
// @ts-expect-error plain ESM script without types
import { chooseEndpoint } from "../../../scripts/pi-lan-bridge-select.mjs"

const ID = "0123456789abcdef0123456789abcdef"
const status = (receiverId: string, addresses: string[]) =>
	Response.json({
		receiverId,
		endpoints: {
			iqPort: 5555,
			apiPort: 8080,
			addresses: addresses.map((address, i) => ({
				address,
				kind: i === 0 ? "ethernet" : "wireless",
			})),
		},
	})

type Choose = (
	host: string,
	options: {
		fetchFn: typeof fetch
		header: (host: string) => Promise<boolean>
	},
) => Promise<{ host: string; reason: string }>
const choose = chooseEndpoint as Choose

describe("pi-lan-bridge --auto endpoint choice (receiver-endpoints 4.1)", () => {
	it("bridges to the best address that is the same receiver and serves RTL0", async () => {
		const fetchFn = vi.fn<typeof fetch>(async url =>
			String(url).includes("198.51.100.23")
				? status(ID, ["192.0.2.69", "198.51.100.23"])
				: Response.json({ receiverId: ID }),
		)
		const header = vi.fn(async () => true)
		expect(await choose("198.51.100.23", { fetchFn, header })).toEqual({
			host: "192.0.2.69",
			reason: "verified ethernet endpoint",
		})
		expect(header).toHaveBeenCalledWith("192.0.2.69", 5555)
	})

	it("keeps the given host when a check fails, the list is missing or names hostnames", async () => {
		const header = vi.fn(async () => true)
		const other = vi.fn<typeof fetch>(async url =>
			String(url).includes("198.51.100.23")
				? status(ID, ["192.0.2.69", "198.51.100.23"])
				: Response.json({ receiverId: "fedcba9876543210fedcba9876543210" }),
		)
		expect(
			(await choose("198.51.100.23", { fetchFn: other, header })).host,
		).toBe("198.51.100.23")
		const old = vi.fn<typeof fetch>(async () => Response.json({ uptime: 1 }))
		expect((await choose("198.51.100.23", { fetchFn: old, header })).host).toBe(
			"198.51.100.23",
		)
		const named = vi.fn<typeof fetch>(async () =>
			status(ID, ["wavekit-pi.local", "198.51.100.23"]),
		)
		expect(await choose("198.51.100.23", { fetchFn: named, header })).toEqual({
			host: "198.51.100.23",
			reason: "given host is the best endpoint",
		})
		expect(named).toHaveBeenCalledTimes(1)
	})

	it("probes only the given API port and ignores a list that names another", async () => {
		const header = vi.fn(async () => true)
		const fetchFn = vi.fn<typeof fetch>(async () =>
			Response.json({
				receiverId: ID,
				endpoints: {
					iqPort: 5555,
					apiPort: 22,
					addresses: [{ address: "192.0.2.69", kind: "ethernet" }],
				},
			}),
		)
		expect((await choose("198.51.100.23", { fetchFn, header })).host).toBe(
			"198.51.100.23",
		)
		expect(fetchFn).toHaveBeenCalledTimes(1)
		expect(header).not.toHaveBeenCalled()
	})
})
