/**
 * ICAO 24-bit Address Country Allocation
 *
 * Maps ICAO hex address ranges to countries of registration.
 * Based on ICAO Annex 10, Volume III, Chapter 9, Table 9-1.
 *
 * Each entry defines a hex range [start, end] and the country it belongs to.
 * The lookup function finds which range contains a given ICAO address.
 *
 * @module src/data/icao-country-prefixes
 */

export interface CountryInfo {
	/** Country name */
	country: string
	/** ISO 3166-1 alpha-2 country code (for future flag emoji support) */
	iso?: string
}

/**
 * ICAO address range allocation entry.
 * Ranges are inclusive: [start, end]
 */
interface IcaoRange {
	start: number
	end: number
	info: CountryInfo
}

/**
 * Complete ICAO 24-bit address allocations by country.
 * Sorted by start address for binary search efficiency.
 *
 * Source: ICAO Annex 10, Volume III, Table 9-1
 * Reference: https://www.icao.int/
 */
const ICAO_ALLOCATIONS: IcaoRange[] = [
	// Africa
	{ start: 0x004000, end: 0x0043ff, info: { country: "Zimbabwe", iso: "ZW" } },
	{ start: 0x006000, end: 0x006fff, info: { country: "Mozambique", iso: "MZ" } },
	{
		start: 0x008000,
		end: 0x00ffff,
		info: { country: "South Africa", iso: "ZA" },
	},
	{ start: 0x010000, end: 0x017fff, info: { country: "Egypt", iso: "EG" } },
	{ start: 0x018000, end: 0x01ffff, info: { country: "Libya", iso: "LY" } },
	{ start: 0x020000, end: 0x027fff, info: { country: "Morocco", iso: "MA" } },
	{ start: 0x028000, end: 0x02ffff, info: { country: "Tunisia", iso: "TN" } },
	{ start: 0x030000, end: 0x0303ff, info: { country: "Botswana", iso: "BW" } },
	{ start: 0x032000, end: 0x032fff, info: { country: "Burundi", iso: "BI" } },
	{ start: 0x034000, end: 0x034fff, info: { country: "Cameroon", iso: "CM" } },
	{ start: 0x035000, end: 0x0353ff, info: { country: "Comoros", iso: "KM" } },
	{ start: 0x036000, end: 0x036fff, info: { country: "Congo", iso: "CG" } },
	{
		start: 0x038000,
		end: 0x038fff,
		info: { country: "Côte d'Ivoire", iso: "CI" },
	},
	{
		start: 0x03e000,
		end: 0x03efff,
		info: { country: "Gabon", iso: "GA" },
	},
	{ start: 0x040000, end: 0x040fff, info: { country: "Ethiopia", iso: "ET" } },
	{
		start: 0x042000,
		end: 0x042fff,
		info: { country: "Equatorial Guinea", iso: "GQ" },
	},
	{ start: 0x044000, end: 0x044fff, info: { country: "Ghana", iso: "GH" } },
	{ start: 0x046000, end: 0x046fff, info: { country: "Guinea", iso: "GN" } },
	{
		start: 0x048000,
		end: 0x0483ff,
		info: { country: "Guinea-Bissau", iso: "GW" },
	},
	{
		start: 0x04a000,
		end: 0x04a3ff,
		info: { country: "Lesotho", iso: "LS" },
	},
	{ start: 0x04c000, end: 0x04cfff, info: { country: "Kenya", iso: "KE" } },
	{ start: 0x050000, end: 0x050fff, info: { country: "Liberia", iso: "LR" } },
	{
		start: 0x054000,
		end: 0x054fff,
		info: { country: "Madagascar", iso: "MG" },
	},
	{ start: 0x058000, end: 0x058fff, info: { country: "Malawi", iso: "MW" } },
	{
		start: 0x05a000,
		end: 0x05a3ff,
		info: { country: "Maldives", iso: "MV" },
	},
	{ start: 0x05c000, end: 0x05cfff, info: { country: "Mali", iso: "ML" } },
	{
		start: 0x05e000,
		end: 0x05e3ff,
		info: { country: "Mauritania", iso: "MR" },
	},
	{
		start: 0x060000,
		end: 0x0603ff,
		info: { country: "Mauritius", iso: "MU" },
	},
	{ start: 0x062000, end: 0x062fff, info: { country: "Niger", iso: "NE" } },
	{ start: 0x064000, end: 0x064fff, info: { country: "Nigeria", iso: "NG" } },
	{ start: 0x068000, end: 0x068fff, info: { country: "Uganda", iso: "UG" } },
	{
		start: 0x06a000,
		end: 0x06a3ff,
		info: { country: "Qatar", iso: "QA" },
	},
	{
		start: 0x06c000,
		end: 0x06cfff,
		info: { country: "Central African Republic", iso: "CF" },
	},
	{ start: 0x06e000, end: 0x06efff, info: { country: "Rwanda", iso: "RW" } },
	{ start: 0x070000, end: 0x070fff, info: { country: "Senegal", iso: "SN" } },
	{
		start: 0x074000,
		end: 0x0743ff,
		info: { country: "Seychelles", iso: "SC" },
	},
	{
		start: 0x076000,
		end: 0x0763ff,
		info: { country: "Sierra Leone", iso: "SL" },
	},
	{ start: 0x078000, end: 0x078fff, info: { country: "Somalia", iso: "SO" } },
	{
		start: 0x07a000,
		end: 0x07a3ff,
		info: { country: "Eswatini", iso: "SZ" },
	},
	{ start: 0x07c000, end: 0x07cfff, info: { country: "Sudan", iso: "SD" } },
	{ start: 0x080000, end: 0x080fff, info: { country: "Tanzania", iso: "TZ" } },
	{ start: 0x084000, end: 0x084fff, info: { country: "Chad", iso: "TD" } },
	{ start: 0x088000, end: 0x088fff, info: { country: "Togo", iso: "TG" } },
	{ start: 0x08a000, end: 0x08afff, info: { country: "Zambia", iso: "ZM" } },
	{
		start: 0x08c000,
		end: 0x08cfff,
		info: { country: "DR Congo", iso: "CD" },
	},
	{ start: 0x090000, end: 0x090fff, info: { country: "Angola", iso: "AO" } },
	{
		start: 0x094000,
		end: 0x0943ff,
		info: { country: "Benin", iso: "BJ" },
	},
	{
		start: 0x096000,
		end: 0x0963ff,
		info: { country: "Cape Verde", iso: "CV" },
	},
	{ start: 0x098000, end: 0x0983ff, info: { country: "Djibouti", iso: "DJ" } },
	{ start: 0x09a000, end: 0x09afff, info: { country: "Gambia", iso: "GM" } },
	{
		start: 0x09c000,
		end: 0x09cfff,
		info: { country: "Burkina Faso", iso: "BF" },
	},
	{
		start: 0x09e000,
		end: 0x09e3ff,
		info: { country: "São Tomé and Príncipe", iso: "ST" },
	},

	// Americas
	{ start: 0x0a0000, end: 0x0a7fff, info: { country: "Algeria", iso: "DZ" } },
	{ start: 0x0a8000, end: 0x0a8fff, info: { country: "Bahamas", iso: "BS" } },
	{ start: 0x0aa000, end: 0x0aa3ff, info: { country: "Barbados", iso: "BB" } },
	{ start: 0x0ab000, end: 0x0ab3ff, info: { country: "Belize", iso: "BZ" } },
	{ start: 0x0ac000, end: 0x0acfff, info: { country: "Colombia", iso: "CO" } },
	{
		start: 0x0ae000,
		end: 0x0aefff,
		info: { country: "Costa Rica", iso: "CR" },
	},
	{ start: 0x0b0000, end: 0x0b0fff, info: { country: "Cuba", iso: "CU" } },
	{
		start: 0x0b2000,
		end: 0x0b2fff,
		info: { country: "El Salvador", iso: "SV" },
	},
	{ start: 0x0b4000, end: 0x0b4fff, info: { country: "Guatemala", iso: "GT" } },
	{ start: 0x0b6000, end: 0x0b6fff, info: { country: "Guyana", iso: "GY" } },
	{ start: 0x0b8000, end: 0x0b8fff, info: { country: "Haiti", iso: "HT" } },
	{ start: 0x0ba000, end: 0x0bafff, info: { country: "Honduras", iso: "HN" } },
	{
		start: 0x0bc000,
		end: 0x0bc3ff,
		info: { country: "Saint Vincent and the Grenadines", iso: "VC" },
	},
	{ start: 0x0be000, end: 0x0befff, info: { country: "Jamaica", iso: "JM" } },
	{ start: 0x0c0000, end: 0x0c0fff, info: { country: "Mexico", iso: "MX" } },
	{ start: 0x0c2000, end: 0x0c2fff, info: { country: "Nicaragua", iso: "NI" } },
	{ start: 0x0c4000, end: 0x0c4fff, info: { country: "Panama", iso: "PA" } },
	{
		start: 0x0c6000,
		end: 0x0c6fff,
		info: { country: "Dominican Republic", iso: "DO" },
	},
	{
		start: 0x0c8000,
		end: 0x0c8fff,
		info: { country: "Trinidad and Tobago", iso: "TT" },
	},
	{ start: 0x0ca000, end: 0x0cafff, info: { country: "Suriname", iso: "SR" } },
	{
		start: 0x0cc000,
		end: 0x0cc3ff,
		info: { country: "Antigua and Barbuda", iso: "AG" },
	},
	{ start: 0x0d0000, end: 0x0d7fff, info: { country: "Venezuela", iso: "VE" } },
	{ start: 0x0d8000, end: 0x0dffff, info: { country: "Peru", iso: "PE" } },

	// South America (continued)
	{ start: 0x0e0000, end: 0x0e3fff, info: { country: "Argentina", iso: "AR" } },
	{ start: 0x0e4000, end: 0x0e7fff, info: { country: "Brazil", iso: "BR" } },
	{ start: 0x0e8000, end: 0x0e8fff, info: { country: "Chile", iso: "CL" } },
	{ start: 0x0ea000, end: 0x0eafff, info: { country: "Ecuador", iso: "EC" } },
	{ start: 0x0ec000, end: 0x0ecfff, info: { country: "Paraguay", iso: "PY" } },
	{ start: 0x0ee000, end: 0x0eefff, info: { country: "Uruguay", iso: "UY" } },
	{ start: 0x0f0000, end: 0x0f07ff, info: { country: "Bolivia", iso: "BO" } },

	// Asia-Pacific (smaller allocations)
	{
		start: 0x100000,
		end: 0x1fffff,
		info: { country: "Russian Federation", iso: "RU" },
	},

	// Europe - ICAO EUR/NAT Block
	{ start: 0x200000, end: 0x27ffff, info: { country: "Italy", iso: "IT" } },
	{ start: 0x280000, end: 0x28ffff, info: { country: "Spain", iso: "ES" } },
	{ start: 0x380000, end: 0x3bffff, info: { country: "France", iso: "FR" } },
	{ start: 0x3c0000, end: 0x3fffff, info: { country: "Germany", iso: "DE" } },
	{
		start: 0x400000,
		end: 0x43ffff,
		info: { country: "United Kingdom", iso: "GB" },
	},
	{ start: 0x440000, end: 0x447fff, info: { country: "Austria", iso: "AT" } },
	{ start: 0x448000, end: 0x44ffff, info: { country: "Belgium", iso: "BE" } },
	{ start: 0x450000, end: 0x457fff, info: { country: "Bulgaria", iso: "BG" } },
	{ start: 0x458000, end: 0x45ffff, info: { country: "Denmark", iso: "DK" } },
	{ start: 0x460000, end: 0x467fff, info: { country: "Finland", iso: "FI" } },
	{ start: 0x468000, end: 0x46ffff, info: { country: "Greece", iso: "GR" } },
	{ start: 0x470000, end: 0x477fff, info: { country: "Hungary", iso: "HU" } },
	{ start: 0x478000, end: 0x47ffff, info: { country: "Norway", iso: "NO" } },
	{
		start: 0x480000,
		end: 0x487fff,
		info: { country: "Netherlands", iso: "NL" },
	},
	{ start: 0x488000, end: 0x48ffff, info: { country: "Poland", iso: "PL" } },
	{ start: 0x490000, end: 0x497fff, info: { country: "Portugal", iso: "PT" } },
	{
		start: 0x498000,
		end: 0x49ffff,
		info: { country: "Czechia", iso: "CZ" },
	},
	{ start: 0x4a0000, end: 0x4a7fff, info: { country: "Romania", iso: "RO" } },
	{ start: 0x4a8000, end: 0x4affff, info: { country: "Sweden", iso: "SE" } },
	{
		start: 0x4b0000,
		end: 0x4b7fff,
		info: { country: "Switzerland", iso: "CH" },
	},
	{ start: 0x4b8000, end: 0x4bffff, info: { country: "Turkey", iso: "TR" } },
	{ start: 0x4c0000, end: 0x4c7fff, info: { country: "Serbia", iso: "RS" } },
	{ start: 0x4c8000, end: 0x4c83ff, info: { country: "Cyprus", iso: "CY" } },
	{ start: 0x4ca000, end: 0x4cafff, info: { country: "Ireland", iso: "IE" } },
	{ start: 0x4cc000, end: 0x4ccfff, info: { country: "Iceland", iso: "IS" } },
	{
		start: 0x4d0000,
		end: 0x4d03ff,
		info: { country: "Luxembourg", iso: "LU" },
	},
	{ start: 0x4d2000, end: 0x4d23ff, info: { country: "Malta", iso: "MT" } },
	{ start: 0x4d4000, end: 0x4d43ff, info: { country: "Monaco", iso: "MC" } },
	{ start: 0x500000, end: 0x5003ff, info: { country: "San Marino", iso: "SM" } },
	{ start: 0x501000, end: 0x5013ff, info: { country: "Albania", iso: "AL" } },
	{ start: 0x501c00, end: 0x501fff, info: { country: "Croatia", iso: "HR" } },
	{ start: 0x502c00, end: 0x502fff, info: { country: "Latvia", iso: "LV" } },
	{
		start: 0x503c00,
		end: 0x503fff,
		info: { country: "Lithuania", iso: "LT" },
	},
	{ start: 0x504c00, end: 0x504fff, info: { country: "Moldova", iso: "MD" } },
	{ start: 0x505c00, end: 0x505fff, info: { country: "Slovakia", iso: "SK" } },
	{ start: 0x506c00, end: 0x506fff, info: { country: "Slovenia", iso: "SI" } },
	{
		start: 0x507c00,
		end: 0x507fff,
		info: { country: "Uzbekistan", iso: "UZ" },
	},
	{ start: 0x508000, end: 0x50ffff, info: { country: "Ukraine", iso: "UA" } },
	{
		start: 0x510000,
		end: 0x5103ff,
		info: { country: "Belarus", iso: "BY" },
	},
	{ start: 0x511000, end: 0x5113ff, info: { country: "Estonia", iso: "EE" } },
	{
		start: 0x512000,
		end: 0x5123ff,
		info: { country: "North Macedonia", iso: "MK" },
	},
	{
		start: 0x513000,
		end: 0x5133ff,
		info: { country: "Bosnia and Herzegovina", iso: "BA" },
	},
	{ start: 0x514000, end: 0x5143ff, info: { country: "Georgia", iso: "GE" } },
	{
		start: 0x515000,
		end: 0x5153ff,
		info: { country: "Tajikistan", iso: "TJ" },
	},
	{
		start: 0x516000,
		end: 0x5163ff,
		info: { country: "Montenegro", iso: "ME" },
	},
	{
		start: 0x600000,
		end: 0x6003ff,
		info: { country: "Armenia", iso: "AM" },
	},
	{
		start: 0x601000,
		end: 0x6013ff,
		info: { country: "Azerbaijan", iso: "AZ" },
	},
	{
		start: 0x602000,
		end: 0x6023ff,
		info: { country: "Kyrgyzstan", iso: "KG" },
	},
	{
		start: 0x603000,
		end: 0x6033ff,
		info: { country: "Turkmenistan", iso: "TM" },
	},

	// Middle East
	{ start: 0x680000, end: 0x6803ff, info: { country: "Bhutan", iso: "BT" } },
	{ start: 0x681000, end: 0x6813ff, info: { country: "Micronesia", iso: "FM" } },
	{ start: 0x682000, end: 0x6823ff, info: { country: "Mongolia", iso: "MN" } },
	{
		start: 0x683000,
		end: 0x6833ff,
		info: { country: "Kazakhstan", iso: "KZ" },
	},
	{ start: 0x684000, end: 0x6843ff, info: { country: "Palau", iso: "PW" } },
	{ start: 0x700000, end: 0x700fff, info: { country: "Afghanistan", iso: "AF" } },
	{
		start: 0x702000,
		end: 0x702fff,
		info: { country: "Bangladesh", iso: "BD" },
	},
	{ start: 0x704000, end: 0x704fff, info: { country: "Myanmar", iso: "MM" } },
	{ start: 0x706000, end: 0x706fff, info: { country: "Kuwait", iso: "KW" } },
	{
		start: 0x708000,
		end: 0x708fff,
		info: { country: "Laos", iso: "LA" },
	},
	{ start: 0x70a000, end: 0x70afff, info: { country: "Nepal", iso: "NP" } },
	{ start: 0x70c000, end: 0x70c3ff, info: { country: "Oman", iso: "OM" } },
	{ start: 0x70e000, end: 0x70efff, info: { country: "Cambodia", iso: "KH" } },
	{
		start: 0x710000,
		end: 0x717fff,
		info: { country: "Saudi Arabia", iso: "SA" },
	},
	{
		start: 0x718000,
		end: 0x71ffff,
		info: { country: "South Korea", iso: "KR" },
	},
	{
		start: 0x720000,
		end: 0x727fff,
		info: { country: "North Korea", iso: "KP" },
	},
	{ start: 0x728000, end: 0x72ffff, info: { country: "Iraq", iso: "IQ" } },
	{ start: 0x730000, end: 0x737fff, info: { country: "Iran", iso: "IR" } },
	{ start: 0x738000, end: 0x73ffff, info: { country: "Israel", iso: "IL" } },
	{ start: 0x740000, end: 0x747fff, info: { country: "Jordan", iso: "JO" } },
	{ start: 0x748000, end: 0x74ffff, info: { country: "Lebanon", iso: "LB" } },
	{ start: 0x750000, end: 0x757fff, info: { country: "Malaysia", iso: "MY" } },
	{
		start: 0x758000,
		end: 0x75ffff,
		info: { country: "Philippines", iso: "PH" },
	},
	{ start: 0x760000, end: 0x767fff, info: { country: "Pakistan", iso: "PK" } },
	{ start: 0x768000, end: 0x76ffff, info: { country: "Singapore", iso: "SG" } },
	{ start: 0x770000, end: 0x777fff, info: { country: "Sri Lanka", iso: "LK" } },
	{ start: 0x778000, end: 0x77ffff, info: { country: "Syria", iso: "SY" } },

	// Asia-Pacific (large allocations)
	{ start: 0x780000, end: 0x7bffff, info: { country: "China", iso: "CN" } },
	{ start: 0x7c0000, end: 0x7fffff, info: { country: "Australia", iso: "AU" } },
	{ start: 0x800000, end: 0x83ffff, info: { country: "India", iso: "IN" } },
	{ start: 0x840000, end: 0x87ffff, info: { country: "Japan", iso: "JP" } },
	{ start: 0x880000, end: 0x887fff, info: { country: "Thailand", iso: "TH" } },
	{ start: 0x888000, end: 0x88ffff, info: { country: "Vietnam", iso: "VN" } },
	{ start: 0x890000, end: 0x890fff, info: { country: "Yemen", iso: "YE" } },
	{ start: 0x894000, end: 0x894fff, info: { country: "Bahrain", iso: "BH" } },
	{
		start: 0x895000,
		end: 0x8953ff,
		info: { country: "Brunei", iso: "BN" },
	},
	{
		start: 0x896000,
		end: 0x896fff,
		info: { country: "United Arab Emirates", iso: "AE" },
	},
	{
		start: 0x897000,
		end: 0x8973ff,
		info: { country: "Solomon Islands", iso: "SB" },
	},
	{
		start: 0x898000,
		end: 0x898fff,
		info: { country: "Papua New Guinea", iso: "PG" },
	},
	{ start: 0x899000, end: 0x8993ff, info: { country: "Taiwan", iso: "TW" } },
	{ start: 0x8a0000, end: 0x8a7fff, info: { country: "Indonesia", iso: "ID" } },

	// North America (large allocations)
	{ start: 0xa00000, end: 0xafffff, info: { country: "United States", iso: "US" } },
	{ start: 0xc00000, end: 0xc3ffff, info: { country: "Canada", iso: "CA" } },
	{ start: 0xc80000, end: 0xc87fff, info: { country: "New Zealand", iso: "NZ" } },
	{ start: 0xc88000, end: 0xc88fff, info: { country: "Fiji", iso: "FJ" } },
	{ start: 0xc8a000, end: 0xc8a3ff, info: { country: "Nauru", iso: "NR" } },
	{
		start: 0xc8c000,
		end: 0xc8c3ff,
		info: { country: "Saint Lucia", iso: "LC" },
	},
	{ start: 0xc8d000, end: 0xc8d3ff, info: { country: "Tonga", iso: "TO" } },
	{ start: 0xc8e000, end: 0xc8e3ff, info: { country: "Kiribati", iso: "KI" } },
	{ start: 0xc90000, end: 0xc903ff, info: { country: "Vanuatu", iso: "VU" } },

	// ICAO special allocations
	{
		start: 0xe00000,
		end: 0xe3ffff,
		info: { country: "Argentina", iso: "AR" },
	}, // Additional Argentina range
	{ start: 0xe40000, end: 0xe7ffff, info: { country: "Brazil", iso: "BR" } }, // Additional Brazil range

	// Military / Special
	{
		start: 0xf00000,
		end: 0xf07fff,
		info: { country: "ICAO (Special)" },
	},
] satisfies IcaoRange[]

/**
 * Binary search to find the country for a given ICAO hex address.
 *
 * @param icao - 6-character hex ICAO address (e.g., "3C675A")
 * @returns Country info if found, undefined if not in any allocated range
 */
export function getCountryFromIcao(icao: string): CountryInfo | undefined {
	const hex = parseInt(icao, 16)
	if (isNaN(hex) || hex < 0 || hex > 0xffffff) {
		return undefined
	}

	// Binary search through sorted ranges
	let low = 0
	let high = ICAO_ALLOCATIONS.length - 1

	while (low <= high) {
		const mid = Math.floor((low + high) / 2)
		const range = ICAO_ALLOCATIONS[mid]

		if (!range) {
			break
		}

		if (hex < range.start) {
			high = mid - 1
		} else if (hex > range.end) {
			low = mid + 1
		} else {
			// hex is within [range.start, range.end]
			return range.info
		}
	}

	return undefined
}

/**
 * Get all country allocations (useful for debugging/documentation).
 */
export function getAllCountryAllocations(): ReadonlyArray<{
	startHex: string
	endHex: string
	country: string
	iso?: string
}> {
	return ICAO_ALLOCATIONS.map(range => ({
		startHex: range.start.toString(16).toUpperCase().padStart(6, "0"),
		endHex: range.end.toString(16).toUpperCase().padStart(6, "0"),
		country: range.info.country,
		...(range.info.iso ? { iso: range.info.iso } : {}),
	}))
}
