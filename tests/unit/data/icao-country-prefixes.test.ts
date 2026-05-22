/**
 * Tests for ICAO Country Prefix Lookup
 */

import { describe, it, expect } from "vitest"
import {
	getCountryFromIcao,
	getAllCountryAllocations,
} from "../../../src/data/icao-country-prefixes.js"

describe("ICAO Country Prefix Lookup", () => {
	describe("getCountryFromIcao", () => {
		it("should return United States for US ICAO addresses", () => {
			// US range: A00000 - AFFFFF
			expect(getCountryFromIcao("A12345")).toEqual({
				country: "United States",
				iso: "US",
			})
			expect(getCountryFromIcao("A00000")).toEqual({
				country: "United States",
				iso: "US",
			})
			expect(getCountryFromIcao("AFFFFF")).toEqual({
				country: "United States",
				iso: "US",
			})
		})

		it("should return Germany for German ICAO addresses", () => {
			// Germany range: 3C0000 - 3FFFFF
			expect(getCountryFromIcao("3C675A")).toEqual({
				country: "Germany",
				iso: "DE",
			})
			expect(getCountryFromIcao("3C0000")).toEqual({
				country: "Germany",
				iso: "DE",
			})
		})

		it("should return United Kingdom for UK ICAO addresses", () => {
			// UK range: 400000 - 43FFFF
			expect(getCountryFromIcao("406D8A")).toEqual({
				country: "United Kingdom",
				iso: "GB",
			})
		})

		it("should return France for French ICAO addresses", () => {
			// France range: 380000 - 3BFFFF
			expect(getCountryFromIcao("380001")).toEqual({
				country: "France",
				iso: "FR",
			})
		})

		it("should return Australia for Australian ICAO addresses", () => {
			// Australia range: 7C0000 - 7FFFFF
			expect(getCountryFromIcao("7C1234")).toEqual({
				country: "Australia",
				iso: "AU",
			})
		})

		it("should return Japan for Japanese ICAO addresses", () => {
			// Japan range: 840000 - 87FFFF
			expect(getCountryFromIcao("862A3B")).toEqual({
				country: "Japan",
				iso: "JP",
			})
		})

		it("should return Canada for Canadian ICAO addresses", () => {
			// Canada range: C00000 - C3FFFF
			expect(getCountryFromIcao("C03456")).toEqual({
				country: "Canada",
				iso: "CA",
			})
		})

		it("should return China for Chinese ICAO addresses", () => {
			// China range: 780000 - 7BFFFF
			expect(getCountryFromIcao("780ABC")).toEqual({
				country: "China",
				iso: "CN",
			})
		})

		it("should return undefined for unallocated addresses", () => {
			// 000000-003FFF is unallocated
			expect(getCountryFromIcao("000000")).toBeUndefined()
			expect(getCountryFromIcao("001234")).toBeUndefined()
		})

		it("should return undefined for invalid ICAO hex", () => {
			expect(getCountryFromIcao("GGGGGG")).toBeUndefined()
			expect(getCountryFromIcao("")).toBeUndefined()
			expect(getCountryFromIcao("invalid")).toBeUndefined()
		})

		it("should handle lowercase ICAO addresses", () => {
			expect(getCountryFromIcao("a12345")).toEqual({
				country: "United States",
				iso: "US",
			})
			expect(getCountryFromIcao("3c675a")).toEqual({
				country: "Germany",
				iso: "DE",
			})
		})

		it("should handle boundary cases correctly", () => {
			// Just below US range
			expect(getCountryFromIcao("9FFFFF")).toBeUndefined()
			// Just above US range
			expect(getCountryFromIcao("B00000")).toBeUndefined()
		})

		it("should handle small country allocations", () => {
			// Luxembourg: 4D0000 - 4D03FF (small range)
			expect(getCountryFromIcao("4D0000")).toEqual({
				country: "Luxembourg",
				iso: "LU",
			})
			expect(getCountryFromIcao("4D03FF")).toEqual({
				country: "Luxembourg",
				iso: "LU",
			})
			// Just outside Luxembourg range
			expect(getCountryFromIcao("4D0400")).toBeUndefined()
		})
	})

	describe("getAllCountryAllocations", () => {
		it("should return an array of allocations", () => {
			const allocations = getAllCountryAllocations()
			expect(Array.isArray(allocations)).toBe(true)
			expect(allocations.length).toBeGreaterThan(100)
		})

		it("should have proper format for each allocation", () => {
			const allocations = getAllCountryAllocations()
			const usAllocation = allocations.find(a => a.country === "United States")
			expect(usAllocation).toBeDefined()
			expect(usAllocation?.startHex).toBe("A00000")
			expect(usAllocation?.endHex).toBe("AFFFFF")
			expect(usAllocation?.iso).toBe("US")
		})

		it("should be sorted by start address", () => {
			const allocations = getAllCountryAllocations()
			for (let i = 1; i < allocations.length; i++) {
				const prev = parseInt(allocations[i - 1]!.startHex, 16)
				const curr = parseInt(allocations[i]!.startHex, 16)
				expect(curr).toBeGreaterThan(prev)
			}
		})
	})
})
