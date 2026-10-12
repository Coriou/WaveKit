import type { ScannerProtocol, ScanRange } from "../types.js"
import type { Bandplan } from "./index.js"

/** Built-in bandplans based on spec § 5.1, with cited regulatory corrections. Data only. */

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

// Ofcom IR 2027.2, Table 2.2: the 40 EU/CEPT CB carrier frequencies.
// https://www.ofcom.org.uk/__data/assets/pdf_file/0030/84765/ir_2027.2.pdf
// Six contiguous 10 kHz runs preserve the five omitted channels; not a uniform whole-band grid.
const CB_CHANNEL_RUNS: readonly (readonly [number, number])[] = [
	[26.965, 26.985],
	[27.005, 27.035],
	[27.055, 27.085],
	[27.105, 27.135],
	[27.155, 27.185],
	[27.205, 27.405],
]

export const BUILTIN_BANDPLANS: readonly Bandplan[] = [
	{
		id: "airband",
		region: "EU",
		name: "Airband (8.33 / 25 kHz)",
		ranges: [
			// Ofcom Spectrum Pricing §7.2.3/4: 118–137 MHz, 25/8.33 kHz.
			// https://www.ofcom.org.uk/siteassets/resources/documents/consultations/uncategorised/8801-spec_pricing/summary/spec_pricing.pdf
			range("airband", 118, 137, {
				// Ofcom carrier-frequency explanation: exact thirds, not 8,330 Hz or channel designators.
				// https://www.ofcom.org.uk/__data/assets/pdf_file/0023/144590/Understanding-8.33kHz-frequencies-and-their-specific-channel-number.pdf
				rasters: [raster(25_000, 118), raster(25_000 / 3, 118)],
				obwHz: [],
				protocols: ["analog-am"],
			}),
		],
	},
	{
		id: "cb",
		region: "EU",
		name: "CB (40 CEPT channels)",
		// Ofcom IR 2027.2, Table 2.2: 10 kHz carrier steps within each run.
		// https://www.ofcom.org.uk/__data/assets/pdf_file/0030/84765/ir_2027.2.pdf
		ranges: CB_CHANNEL_RUNS.map(([start, end]) =>
			range("cb", start, end, {
				rasters: [raster(10_000, start)],
				obwHz: [],
				protocols: ["analog-am", "analog-fm"],
			}),
		),
	},
	{
		id: "ism-169",
		region: "EU",
		name: "169 MHz metering (Wize / wireless M-Bus)",
		ranges: [
			// ERC Report 25 (October 2017), p78: meter reading within 169.400–169.475 MHz.
			// https://docdb.cept.org/download/2830
			range("ism-169", 169.4, 169.475, { obwHz: [], protocols: ["ism"] }),
		],
	},
	{
		id: "pager-vhf",
		region: "EU",
		name: "VHF paging (169 MHz SRD band excluded)",
		// ERC Report 25 (October 2017), p78: 169.4–169.8125 MHz is metering/ALD/SRD.
		// https://docdb.cept.org/download/2830
		// Range endpoints are inclusive integer Hz: ±1 Hz below/above these documented edges
		// excludes both boundary frequencies; those offsets are representation, not channel assignments.
		ranges: [
			{
				...range("pager-vhf", 137, 169.4, {
					rasters: [raster(12_500, 137)],
					obwHz: [12_000],
					protocols: ["pocsag", "flex"],
				}),
				endHz: MHz(169.4) - 1,
			},
			{
				...range("pager-vhf", 169.8125, 174, {
					rasters: [raster(12_500, 137)],
					obwHz: [12_000],
					protocols: ["pocsag", "flex"],
				}),
				startHz: MHz(169.8125) + 1,
			},
		],
	},
	{
		id: "pmr446",
		region: "EU",
		name: "PMR446",
		ranges: [
			range("pmr446", 446.0, 446.2, {
				// ECC/DEC/(15)05, decides 2 and 4: analogue 12.5 kHz; digital 6.25/12.5 kHz.
				// https://docdb.cept.org/download/1491
				rasters: [raster(12_500, 446.00625), raster(6250, 446.003125)],
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
			// ECC/DEC/(15)05, decides 4: full digital band and lowest 6.25 kHz carrier since 2018.
			// https://docdb.cept.org/download/1491
			range("dpmr446", 446.0, 446.2, {
				rasters: [raster(6250, 446.003125)],
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
