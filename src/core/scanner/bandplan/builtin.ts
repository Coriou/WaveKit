import type { ScannerProtocol, ScanRange } from "../types.js"
import type { Bandplan } from "./index.js"

/** Built-in bandplans: exactly the spec § 5.1 table. Data only; served by GET /api/scanner/bandplans. */

const MHz = (x: number): number => Math.round(x * 1e6)
const LAND_MOBILE_OBW = [9000, 11_000, 4500]
const LAND_MOBILE: ScannerProtocol[] = [
	"dmr",
	"analog-fm",
	"p25p1",
	"nxdn48",
	"nxdn96",
] // tetra: energy only

function range(
	id: string,
	startMhz: number,
	endMhz: number,
	r: Omit<ScanRange, "startHz" | "endHz" | "bandplanId">,
): ScanRange {
	return { startHz: MHz(startMhz), endHz: MHz(endMhz), ...r, bandplanId: id }
}
function raster(
	spacingHz: number,
	firstMhz: number,
): { spacingHz: number; firstChannelHz: number } {
	return { spacingHz, firstChannelHz: MHz(firstMhz) }
}
function aprsChannel(id: string, mhz: number): ScanRange {
	return {
		startHz: MHz(mhz) - 8000,
		endHz: MHz(mhz) + 8000,
		rasters: [raster(25_000, mhz)],
		obwHz: [16_000],
		protocols: ["aprs"],
		bandplanId: id,
	}
}

export const BUILTIN_BANDPLANS: readonly Bandplan[] = [
	{
		id: "pmr446",
		region: "EU",
		name: "PMR446",
		ranges: [
			range("pmr446", 446.0, 446.2, {
				rasters: [raster(12_500, 446.00625)],
				obwHz: [9000, 11_000],
				protocols: ["analog-fm", "dmr", "dpmr"],
			}),
		],
	},
	{
		id: "dpmr446",
		region: "EU",
		name: "dPMR446 / NXDN 6.25 kHz",
		ranges: [
			range("dpmr446", 446.1, 446.2, {
				rasters: [raster(6250, 446.103125)],
				obwHz: [4500],
				protocols: ["dpmr", "nxdn48"],
			}),
		],
	},
	{
		id: "uhf-land-mobile",
		region: "all",
		name: "UHF land mobile",
		ranges: [
			range("uhf-land-mobile", 400, 470, {
				rasters: [raster(12_500, 400.00625), raster(6250, 400.003125)],
				obwHz: LAND_MOBILE_OBW,
				protocols: LAND_MOBILE,
			}),
		],
	},
	{
		id: "vhf-land-mobile",
		region: "all",
		name: "VHF land mobile",
		ranges: [
			range("vhf-land-mobile", 136, 174, {
				rasters: [raster(12_500, 136.00625), raster(6250, 136.003125)],
				obwHz: LAND_MOBILE_OBW,
				protocols: [...LAND_MOBILE, "pocsag"],
			}),
		],
	},
	{
		id: "amateur-2m",
		region: "EU",
		name: "Amateur 2 m",
		ranges: [
			range("amateur-2m", 144, 146, {
				rasters: [raster(12_500, 144)],
				obwHz: [11_000, 16_000],
				protocols: ["analog-fm", "aprs", "dstar", "dmr", "ysf"],
			}),
		],
	},
	{
		id: "amateur-2m",
		region: "US",
		name: "Amateur 2 m",
		ranges: [
			range("amateur-2m", 144, 148, {
				rasters: [raster(15_000, 144), raster(20_000, 144)],
				obwHz: [11_000, 16_000],
				protocols: ["analog-fm", "aprs", "dstar", "dmr", "ysf"],
			}),
		],
	},
	{
		id: "amateur-70cm",
		region: "EU",
		name: "Amateur 70 cm",
		ranges: [
			range("amateur-70cm", 430, 440, {
				rasters: [raster(12_500, 430), raster(25_000, 430)],
				obwHz: [9000, 11_000, 16_000],
				protocols: ["analog-fm", "dstar", "dmr", "ysf", "p25p1"],
			}),
		],
	},
	{
		id: "amateur-70cm",
		region: "US",
		name: "Amateur 70 cm",
		ranges: [
			range("amateur-70cm", 420, 450, {
				rasters: [raster(12_500, 420), raster(25_000, 420)],
				obwHz: [9000, 11_000, 16_000],
				protocols: ["analog-fm", "dstar", "dmr", "ysf", "p25p1"],
			}),
		],
	},
	{
		id: "aprs",
		region: "EU",
		name: "APRS 144.800",
		ranges: [aprsChannel("aprs", 144.8)],
	},
	{
		id: "aprs",
		region: "US",
		name: "APRS 144.390",
		ranges: [aprsChannel("aprs", 144.39)],
	},
	{
		id: "ism-433",
		region: "EU",
		name: "ISM 433 MHz",
		ranges: [
			range("ism-433", 433.05, 434.79, { obwHz: [], protocols: ["ism"] }),
		],
	},
	{
		id: "ism-868",
		region: "EU",
		name: "ISM 868 MHz",
		ranges: [range("ism-868", 863, 870, { obwHz: [], protocols: ["ism"] })],
	},
	{
		id: "pager-vhf",
		region: "all",
		name: "VHF paging",
		ranges: [
			range("pager-vhf", 137, 174, {
				rasters: [raster(12_500, 137)],
				obwHz: [12_000],
				protocols: ["pocsag", "flex"],
			}),
		],
	},
	{
		id: "marine-vhf",
		region: "all",
		name: "Marine VHF (AIS excluded)",
		ranges: [
			range("marine-vhf", 156.0, 161.9625, {
				rasters: [raster(25_000, 156)],
				obwHz: [16_000],
				protocols: ["analog-fm"],
			}),
			range("marine-vhf", 161.9875, 162.0125, {
				rasters: [raster(25_000, 156)],
				obwHz: [16_000],
				protocols: ["analog-fm"],
			}),
		],
	},
]
