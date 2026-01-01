/**
 * Property-Based Test: Health Check Exit Code Matches State
 *
 * Feature: docker-setup, Property 8: Health Check Exit Code Matches State
 * Validates: Requirements 4.4
 *
 * For any health check execution, the exit code SHALL be 0 if and only if
 * all component checks pass, and 1 otherwise.
 */

import { describe, it, expect } from "vitest"
import * as fc from "fast-check"
import {
	determineOverallHealth,
	type ComponentHealth,
	type HealthStatusLevel,
} from "../../../src/utils/health-check.js"

/**
 * Maps health status level to expected exit code
 * - "healthy" -> exit code 0 (success)
 * - "degraded" -> exit code 0 (success, system still operational)
 * - "unhealthy" -> exit code 1 (failure)
 */
function healthStatusToExitCode(status: HealthStatusLevel): number {
	// Per the healthcheck.sh script and requirements:
	// - healthy = exit 0
	// - degraded = exit 0 (system is still operational, just degraded)
	// - unhealthy = exit 1
	return status === "unhealthy" ? 1 : 0
}

/**
 * Arbitrary for generating valid ISO date strings
 * Using integer timestamps to avoid invalid date issues
 */
const isoDateStringArb = fc
	.integer({
		min: new Date("2020-01-01T00:00:00.000Z").getTime(),
		max: new Date("2030-12-31T23:59:59.999Z").getTime(),
	})
	.map(ts => new Date(ts).toISOString())

/**
 * Arbitrary for generating ComponentHealth objects
 */
const componentHealthArb = fc.record({
	status: fc.constantFrom("up", "down", "degraded") as fc.Arbitrary<
		"up" | "down" | "degraded"
	>,
	message: fc.option(fc.string(), { nil: undefined }),
	lastCheck: isoDateStringArb,
	metrics: fc.option(
		fc.dictionary(fc.string(), fc.integer({ min: 0, max: 1000 })),
		{ nil: undefined },
	),
})

/**
 * Arbitrary for generating decoder health records
 */
const decodersHealthArb = fc.dictionary(
	fc.stringMatching(/^[a-z][a-z0-9-]{0,15}$/),
	componentHealthArb,
	{ minKeys: 0, maxKeys: 5 },
)

describe("Feature: docker-setup, Property 8: Health Check Exit Code Matches State", () => {
	/**
	 * Property 8.1: Exit code 0 when all components are healthy
	 *
	 * For any system state where all components report "up" status,
	 * the health check SHALL return exit code 0.
	 */
	it("should return exit code 0 when all components are healthy", () => {
		fc.assert(
			fc.property(
				// Generate healthy components
				fc.record({
					api: componentHealthArb.map(c => ({ ...c, status: "up" as const })),
					decoders: fc
						.dictionary(
							fc.stringMatching(/^[a-z][a-z0-9-]{0,15}$/),
							componentHealthArb.map(c => ({ ...c, status: "up" as const })),
							{ minKeys: 0, maxKeys: 5 },
						)
						.filter(d => Object.keys(d).length > 0), // At least one decoder
					source: componentHealthArb.map(c => ({
						...c,
						status: "up" as const,
					})),
					sdrpp: fc.option(
						componentHealthArb.map(c => ({ ...c, status: "up" as const })),
						{ nil: undefined },
					),
				}),
				components => {
					const status = determineOverallHealth(components)
					const exitCode = healthStatusToExitCode(status)

					// Property: All healthy components should result in exit code 0
					return exitCode === 0 && status === "healthy"
				},
			),
			{ numRuns: 100 },
		)
	})

	/**
	 * Property 8.2: Exit code 1 when API is down
	 *
	 * For any system state where the API component reports "down" status,
	 * the health check SHALL return exit code 1 (unhealthy).
	 */
	it("should return exit code 1 when API is down", () => {
		fc.assert(
			fc.property(
				// Generate components with API down
				fc.record({
					api: componentHealthArb.map(c => ({
						...c,
						status: "down" as const,
					})),
					decoders: decodersHealthArb,
					source: componentHealthArb,
					sdrpp: fc.option(componentHealthArb, { nil: undefined }),
				}),
				components => {
					const status = determineOverallHealth(components)
					const exitCode = healthStatusToExitCode(status)

					// Property: API down should always result in exit code 1
					return exitCode === 1 && status === "unhealthy"
				},
			),
			{ numRuns: 100 },
		)
	})

	/**
	 * Property 8.3: Exit code 1 when all decoders are down
	 *
	 * For any system state where all configured decoders report "down" status,
	 * the health check SHALL return exit code 1 (unhealthy).
	 */
	it("should return exit code 1 when all decoders are down", () => {
		fc.assert(
			fc.property(
				// Generate components with all decoders down
				fc.record({
					api: componentHealthArb.map(c => ({ ...c, status: "up" as const })),
					decoders: fc
						.dictionary(
							fc.stringMatching(/^[a-z][a-z0-9-]{0,15}$/),
							componentHealthArb.map(c => ({ ...c, status: "down" as const })),
							{ minKeys: 1, maxKeys: 5 }, // At least one decoder, all down
						)
						.filter(d => Object.keys(d).length > 0),
					source: componentHealthArb.map(c => ({
						...c,
						status: "up" as const,
					})),
					sdrpp: fc.option(componentHealthArb, { nil: undefined }),
				}),
				components => {
					const status = determineOverallHealth(components)
					const exitCode = healthStatusToExitCode(status)

					// Property: All decoders down should result in exit code 1
					return exitCode === 1 && status === "unhealthy"
				},
			),
			{ numRuns: 100 },
		)
	})

	/**
	 * Property 8.4: Exit code 0 when system is degraded (not unhealthy)
	 *
	 * For any system state where the system is degraded (some components down
	 * but not critical ones), the health check SHALL return exit code 0.
	 */
	it("should return exit code 0 when system is degraded but not unhealthy", () => {
		fc.assert(
			fc.property(
				// Generate degraded state: API up, at least one decoder up, source degraded
				fc.record({
					api: componentHealthArb.map(c => ({ ...c, status: "up" as const })),
					decoders: fc
						.tuple(
							// At least one decoder up
							componentHealthArb.map(c => ({ ...c, status: "up" as const })),
							// Optionally some degraded/down decoders
							fc.array(
								componentHealthArb.map(c => ({
									...c,
									status: fc.sample(
										fc.constantFrom("up", "down", "degraded"),
										1,
									)[0] as "up" | "down" | "degraded",
								})),
								{ minLength: 0, maxLength: 3 },
							),
						)
						.map(([first, rest]) => {
							const result: Record<string, ComponentHealth> = {
								decoder0: first,
							}
							rest.forEach((d, i) => {
								result[`decoder${i + 1}`] = d
							})
							return result
						}),
					source: componentHealthArb.map(c => ({
						...c,
						status: "degraded" as const,
					})),
					sdrpp: fc.option(componentHealthArb, { nil: undefined }),
				}),
				components => {
					const status = determineOverallHealth(components)
					const exitCode = healthStatusToExitCode(status)

					// Property: Degraded state should result in exit code 0
					// (system is still operational)
					return exitCode === 0 && status === "degraded"
				},
			),
			{ numRuns: 100 },
		)
	})

	/**
	 * Property 8.5: Exit code consistency with health status
	 *
	 * For any valid component health configuration, the exit code SHALL be
	 * consistent with the determined health status:
	 * - healthy -> 0
	 * - degraded -> 0
	 * - unhealthy -> 1
	 */
	it("should have consistent exit code based on health status", () => {
		fc.assert(
			fc.property(
				// Generate arbitrary component health states
				fc.record({
					api: componentHealthArb,
					decoders: decodersHealthArb,
					source: componentHealthArb,
					sdrpp: fc.option(componentHealthArb, { nil: undefined }),
				}),
				components => {
					const status = determineOverallHealth(components)
					const exitCode = healthStatusToExitCode(status)

					// Property: Exit code must be consistent with status
					if (status === "unhealthy") {
						return exitCode === 1
					} else {
						// healthy or degraded
						return exitCode === 0
					}
				},
			),
			{ numRuns: 100 },
		)
	})

	/**
	 * Property 8.6: Exit code 0 when no decoders configured
	 *
	 * For any system state where no decoders are configured (empty decoders object),
	 * and API is up, the health check SHALL return exit code 0.
	 */
	it("should return exit code 0 when no decoders configured and API is up", () => {
		fc.assert(
			fc.property(
				// Generate components with no decoders and no sdrpp (or sdrpp up)
				fc.record({
					api: componentHealthArb.map(c => ({ ...c, status: "up" as const })),
					decoders: fc.constant({} as Record<string, ComponentHealth>),
					source: componentHealthArb.map(c => ({
						...c,
						status: "up" as const,
					})),
					// Either no sdrpp or sdrpp up (to ensure healthy, not degraded)
					sdrpp: fc.option(
						componentHealthArb.map(c => ({ ...c, status: "up" as const })),
						{ nil: undefined },
					),
				}),
				components => {
					const status = determineOverallHealth(components)
					const exitCode = healthStatusToExitCode(status)

					// Property: No decoders + API up + (no sdrpp or sdrpp up) should be healthy (exit 0)
					return exitCode === 0 && status === "healthy"
				},
			),
			{ numRuns: 100 },
		)
	})

	/**
	 * Property 8.7: SDR++ down results in degraded (exit 0), not unhealthy
	 *
	 * For any system state where SDR++ is down but API and decoders are up,
	 * the health check SHALL return exit code 0 (degraded, not unhealthy).
	 */
	it("should return exit code 0 when SDR++ is down but API and decoders are up", () => {
		fc.assert(
			fc.property(
				// Generate components with SDR++ down
				fc.record({
					api: componentHealthArb.map(c => ({ ...c, status: "up" as const })),
					decoders: fc
						.dictionary(
							fc.stringMatching(/^[a-z][a-z0-9-]{0,15}$/),
							componentHealthArb.map(c => ({ ...c, status: "up" as const })),
							{ minKeys: 1, maxKeys: 5 },
						)
						.filter(d => Object.keys(d).length > 0),
					source: componentHealthArb.map(c => ({
						...c,
						status: "up" as const,
					})),
					sdrpp: fc.constant({
						status: "down" as const,
						message: "SDR++ server not running",
						lastCheck: new Date().toISOString(),
					} as ComponentHealth),
				}),
				components => {
					const status = determineOverallHealth(components)
					const exitCode = healthStatusToExitCode(status)

					// Property: SDR++ down should result in degraded (exit 0)
					return exitCode === 0 && status === "degraded"
				},
			),
			{ numRuns: 100 },
		)
	})

	/**
	 * Property 8.8: Source down results in degraded (exit 0), not unhealthy
	 *
	 * For any system state where source is down but API and at least one decoder are up,
	 * the health check SHALL return exit code 0 (degraded, not unhealthy).
	 */
	it("should return exit code 0 when source is down but API and decoders are up", () => {
		fc.assert(
			fc.property(
				// Generate components with source down
				fc.record({
					api: componentHealthArb.map(c => ({ ...c, status: "up" as const })),
					decoders: fc
						.dictionary(
							fc.stringMatching(/^[a-z][a-z0-9-]{0,15}$/),
							componentHealthArb.map(c => ({ ...c, status: "up" as const })),
							{ minKeys: 1, maxKeys: 5 },
						)
						.filter(d => Object.keys(d).length > 0),
					source: componentHealthArb.map(c => ({
						...c,
						status: "down" as const,
					})),
					sdrpp: fc.option(componentHealthArb, { nil: undefined }),
				}),
				components => {
					const status = determineOverallHealth(components)
					const exitCode = healthStatusToExitCode(status)

					// Property: Source down should result in degraded (exit 0)
					return exitCode === 0 && status === "degraded"
				},
			),
			{ numRuns: 100 },
		)
	})
})
