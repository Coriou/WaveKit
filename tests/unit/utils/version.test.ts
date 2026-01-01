/**
 * Version Detection and Validation Tests
 *
 * Tests for decoder version detection and validation utilities.
 * Requirements: 27.1, 27.2, 27.3
 */

import { describe, it, expect } from "vitest"
import {
	parseVersion,
	compareVersions,
	satisfiesVersionConstraints,
	getUpgradeInstructions,
} from "../../../src/utils/version.js"

describe("Version Utilities", () => {
	describe("parseVersion", () => {
		it("should parse simple version strings", () => {
			expect(parseVersion("1.0.0")).toEqual([1, 0, 0])
			expect(parseVersion("2.3.4")).toEqual([2, 3, 4])
			expect(parseVersion("10.20.30")).toEqual([10, 20, 30])
		})

		it("should parse two-part versions", () => {
			expect(parseVersion("1.0")).toEqual([1, 0])
			expect(parseVersion("2.3")).toEqual([2, 3])
		})

		it("should parse single-part versions", () => {
			expect(parseVersion("1")).toEqual([1])
			expect(parseVersion("42")).toEqual([42])
		})

		it("should handle leading 'v' prefix", () => {
			expect(parseVersion("v1.0.0")).toEqual([1, 0, 0])
			expect(parseVersion("V2.3.4")).toEqual([2, 3, 4])
		})

		it("should handle versions with pre-release suffixes", () => {
			expect(parseVersion("1.0.0-beta")).toEqual([1, 0, 0])
			expect(parseVersion("2.3.4-alpha.1")).toEqual([2, 3, 4])
			expect(parseVersion("1.0.0-rc1")).toEqual([1, 0, 0])
		})

		it("should handle whitespace", () => {
			expect(parseVersion("  1.0.0  ")).toEqual([1, 0, 0])
			expect(parseVersion(" v2.3.4 ")).toEqual([2, 3, 4])
		})

		it("should return null for invalid versions", () => {
			expect(parseVersion("")).toBeNull()
			expect(parseVersion("abc")).toBeNull()
			expect(parseVersion("v")).toBeNull()
		})
	})

	describe("compareVersions", () => {
		it("should return 0 for equal versions", () => {
			expect(compareVersions("1.0.0", "1.0.0")).toBe(0)
			expect(compareVersions("2.3.4", "2.3.4")).toBe(0)
			expect(compareVersions("1.0", "1.0.0")).toBe(0)
		})

		it("should return -1 when first version is less", () => {
			expect(compareVersions("1.0.0", "2.0.0")).toBe(-1)
			expect(compareVersions("1.0.0", "1.1.0")).toBe(-1)
			expect(compareVersions("1.0.0", "1.0.1")).toBe(-1)
			expect(compareVersions("1.9.9", "2.0.0")).toBe(-1)
		})

		it("should return 1 when first version is greater", () => {
			expect(compareVersions("2.0.0", "1.0.0")).toBe(1)
			expect(compareVersions("1.1.0", "1.0.0")).toBe(1)
			expect(compareVersions("1.0.1", "1.0.0")).toBe(1)
			expect(compareVersions("2.0.0", "1.9.9")).toBe(1)
		})

		it("should handle different version lengths", () => {
			expect(compareVersions("1.0", "1.0.0")).toBe(0)
			expect(compareVersions("1.0.0", "1.0")).toBe(0)
			expect(compareVersions("1.0.1", "1.0")).toBe(1)
			expect(compareVersions("1.0", "1.0.1")).toBe(-1)
		})

		it("should handle versions with 'v' prefix", () => {
			expect(compareVersions("v1.0.0", "1.0.0")).toBe(0)
			expect(compareVersions("v1.0.0", "v2.0.0")).toBe(-1)
		})
	})

	describe("satisfiesVersionConstraints", () => {
		it("should return true when no constraints specified", () => {
			expect(satisfiesVersionConstraints("1.0.0")).toBe(true)
			expect(satisfiesVersionConstraints("1.0.0", undefined, undefined)).toBe(
				true,
			)
		})

		it("should check minimum version constraint", () => {
			expect(satisfiesVersionConstraints("2.0.0", "1.0.0")).toBe(true)
			expect(satisfiesVersionConstraints("1.0.0", "1.0.0")).toBe(true)
			expect(satisfiesVersionConstraints("0.9.0", "1.0.0")).toBe(false)
		})

		it("should check maximum version constraint", () => {
			expect(satisfiesVersionConstraints("1.0.0", undefined, "2.0.0")).toBe(
				true,
			)
			expect(satisfiesVersionConstraints("2.0.0", undefined, "2.0.0")).toBe(
				true,
			)
			expect(satisfiesVersionConstraints("2.1.0", undefined, "2.0.0")).toBe(
				false,
			)
		})

		it("should check both constraints", () => {
			expect(satisfiesVersionConstraints("1.5.0", "1.0.0", "2.0.0")).toBe(true)
			expect(satisfiesVersionConstraints("1.0.0", "1.0.0", "2.0.0")).toBe(true)
			expect(satisfiesVersionConstraints("2.0.0", "1.0.0", "2.0.0")).toBe(true)
			expect(satisfiesVersionConstraints("0.9.0", "1.0.0", "2.0.0")).toBe(false)
			expect(satisfiesVersionConstraints("2.1.0", "1.0.0", "2.0.0")).toBe(false)
		})
	})

	describe("getUpgradeInstructions", () => {
		it("should generate upgrade instructions for minimum version", () => {
			const instructions = getUpgradeInstructions(
				"dsd-fme",
				"1.0.0",
				"2.0.0",
				true,
			)
			expect(instructions).toContain("dsd-fme")
			expect(instructions).toContain("1.0.0")
			expect(instructions).toContain("2.0.0")
			expect(instructions).toContain("upgrade")
		})

		it("should generate downgrade instructions for maximum version", () => {
			const instructions = getUpgradeInstructions(
				"multimon-ng",
				"3.0.0",
				"2.0.0",
				false,
			)
			expect(instructions).toContain("multimon-ng")
			expect(instructions).toContain("3.0.0")
			expect(instructions).toContain("2.0.0")
			expect(instructions).toContain("downgrade")
		})
	})
})
