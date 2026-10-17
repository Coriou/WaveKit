import { describe, it, expect } from "vitest"
import type { SdrHostNetworkInterface } from "@wavekit/api-types"
import {
	createReceiverId,
	endpointsFromTelemetry,
	rankEndpoints,
} from "../../src/telemetry/endpoints.js"

const iface = (
	name: string,
	fields: Partial<SdrHostNetworkInterface>,
): SdrHostNetworkInterface => ({
	name,
	kind: "ethernet",
	operstate: "up",
	addresses: [],
	rxBytesPerSec: 0,
	txBytesPerSec: 0,
	wireless: null,
	speedMbps: null,
	defaultRouteMetric: null,
	...fields,
})

describe("rankEndpoints", () => {
	it("puts a wired link with carrier ahead of Wi-Fi, IPv4 first, and drops undialable addresses", () => {
		expect(
			rankEndpoints([
				iface("wlan0", {
					kind: "wireless",
					addresses: ["192.168.86.23", "fe80::1", "2001:db8::23"],
					wireless: { linkQuality: 40, signalDbm: -70 },
					defaultRouteMetric: 600,
				}),
				iface("eth0", {
					addresses: ["2001:db8::69", "192.168.1.69", "169.254.3.4"],
					speedMbps: 100,
					defaultRouteMetric: 100,
				}),
				iface("usb0", { operstate: "down", addresses: ["10.0.0.2"] }),
			]),
		).toEqual([
			{
				address: "192.168.1.69",
				family: "IPv4",
				interface: "eth0",
				kind: "ethernet",
				speedMbps: 100,
				signalDbm: null,
			},
			{
				address: "2001:db8::69",
				family: "IPv6",
				interface: "eth0",
				kind: "ethernet",
				speedMbps: 100,
				signalDbm: null,
			},
			{
				address: "192.168.86.23",
				family: "IPv4",
				interface: "wlan0",
				kind: "wireless",
				speedMbps: null,
				signalDbm: -70,
			},
			{
				address: "2001:db8::23",
				family: "IPv6",
				interface: "wlan0",
				kind: "wireless",
				speedMbps: null,
				signalDbm: -70,
			},
		])
	})

	it("orders the same kind by default-route metric, unrouted last", () => {
		const order = rankEndpoints([
			iface("eth1", { addresses: ["10.0.1.2"], speedMbps: 1000 }),
			iface("eth0", {
				addresses: ["10.0.0.2"],
				speedMbps: 100,
				defaultRouteMetric: 100,
			}),
			iface("eth2", {
				addresses: ["10.0.2.2"],
				speedMbps: 100,
				defaultRouteMetric: 50,
			}),
		]).map(e => e.interface)
		expect(order).toEqual(["eth2", "eth0", "eth1"])
	})

	it("reports no endpoints while the host network is not visible", () => {
		expect(
			endpointsFromTelemetry(
				{
					state: "unavailable",
					scope: "host",
					observedAt: null,
					ageMs: null,
					value: null,
					reason: "host network namespace not visible",
				},
				{ iqPort: 5555, apiPort: 8080 },
			),
		).toBeNull()
	})

	it("creates distinct 128-bit receiver IDs", () => {
		const a = createReceiverId()
		expect(a).toMatch(/^[0-9a-f]{32}$/)
		expect(createReceiverId()).not.toBe(a)
	})
})
