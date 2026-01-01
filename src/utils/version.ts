/**
 * Version Detection and Validation Utilities
 *
 * Requirements:
 * - 27.1: WHEN a decoder is configured, THE Decoder_Manager SHALL validate the installed version against the pinned version
 * - 27.2: WHEN a version mismatch is detected, THE Decoder_Manager SHALL log a warning with upgrade instructions
 * - 27.3: THE Configuration SHALL support specifying minimum and maximum versions per decoder type
 */

import { execSync } from "node:child_process"

/**
 * Result of a version detection attempt.
 */
export interface VersionDetectionResult {
	/** Whether version detection was successful */
	success: boolean
	/** The detected version string (if successful) */
	version?: string
	/** Error message (if unsuccessful) */
	error?: string
}

/**
 * Result of a version validation check.
 */
export interface VersionValidationResult {
	/** Whether the version is valid (within constraints) */
	valid: boolean
	/** The detected version */
	detectedVersion?: string | undefined
	/** Minimum required version (if specified) */
	minVersion?: string | undefined
	/** Maximum allowed version (if specified) */
	maxVersion?: string | undefined
	/** Validation error message (if invalid) */
	error?: string | undefined
}

/**
 * Version command patterns for different decoders.
 * Maps decoder type to the command and regex pattern to extract version.
 */
export interface VersionCommandConfig {
	/** Command to run to get version (e.g., "dsd-fme --version") */
	command: string
	/** Arguments to pass to the command */
	args: string[]
	/** Regex pattern to extract version from output */
	pattern: RegExp
	/** Which capture group contains the version (default: 1) */
	captureGroup?: number
}

/**
 * Default version command configurations for built-in decoders.
 */
export const DEFAULT_VERSION_COMMANDS: Record<string, VersionCommandConfig> = {
	"dsd-fme": {
		command: "dsd-fme",
		args: ["--version"],
		pattern: /(?:dsd-fme|version)\s*[v]?(\d+\.\d+(?:\.\d+)?)/i,
		captureGroup: 1,
	},
	"multimon-ng": {
		command: "multimon-ng",
		args: ["--version"],
		pattern: /multimon-ng\s+(\d+\.\d+(?:\.\d+)?)/i,
		captureGroup: 1,
	},
	rtl433: {
		command: "rtl_433",
		args: ["-V"],
		pattern: /rtl_433\s+version\s+(\d+\.\d+(?:\.\d+)?)/i,
		captureGroup: 1,
	},
	readsb: {
		command: "readsb",
		args: ["--version"],
		pattern: /readsb\s+[v]?(\d+\.\d+(?:\.\d+)?)/i,
		captureGroup: 1,
	},
	acarsdec: {
		command: "acarsdec",
		args: ["-h"],
		pattern: /acarsdec\s+[v]?(\d+\.\d+(?:\.\d+)?)/i,
		captureGroup: 1,
	},
	dumpvdl2: {
		command: "dumpvdl2",
		args: ["--version"],
		pattern: /dumpvdl2\s+[v]?(\d+\.\d+(?:\.\d+)?)/i,
		captureGroup: 1,
	},
	"ais-catcher": {
		command: "AIS-catcher",
		args: ["-h"],
		pattern: /AIS-catcher\s+[v]?(\d+\.\d+(?:\.\d+)?)/i,
		captureGroup: 1,
	},
	direwolf: {
		command: "direwolf",
		args: ["-t", "0", "-q", "d"],
		pattern: /Dire\s*Wolf\s+version\s+(\d+\.\d+(?:\.\d+)?)/i,
		captureGroup: 1,
	},
}

/**
 * Parses a version string into comparable numeric components.
 * Supports formats like "1.2.3", "1.2", "1"
 *
 * @param version - Version string to parse
 * @returns Array of numeric version components, or null if invalid
 */
export function parseVersion(version: string): number[] | null {
	// Trim whitespace first, then remove leading 'v' if present
	const trimmed = version.trim()
	const cleaned = trimmed.replace(/^v/i, "")

	// Handle empty string
	if (!cleaned) return null

	// Split by dots and parse each component
	const parts = cleaned.split(".")
	const components: number[] = []

	for (const part of parts) {
		// Extract numeric portion (handles cases like "1.2.3-beta")
		// Stop at first non-numeric character (except for the first character)
		const match = /^(\d+)/.exec(part)
		if (!match?.[1]) {
			// If first component is invalid, return null
			if (components.length === 0) return null
			// Otherwise, stop parsing (we've hit a pre-release suffix like "-beta")
			break
		}

		// Check if this part contains a pre-release suffix (e.g., "4-alpha")
		// If so, only take the numeric part and stop
		const numericPart = parseInt(match[1], 10)
		components.push(numericPart)

		// If the part has more than just the number (e.g., "4-alpha"), stop parsing
		if (part.length > match[1].length && part[match[1].length] === "-") {
			break
		}
	}

	return components.length > 0 ? components : null
}

/**
 * Compares two version strings.
 *
 * @param a - First version string
 * @param b - Second version string
 * @returns -1 if a < b, 0 if a == b, 1 if a > b
 */
export function compareVersions(a: string, b: string): number {
	const partsA = parseVersion(a)
	const partsB = parseVersion(b)

	// Handle invalid versions
	if (!partsA && !partsB) return 0
	if (!partsA) return -1
	if (!partsB) return 1

	// Compare each component
	const maxLength = Math.max(partsA.length, partsB.length)
	for (let i = 0; i < maxLength; i++) {
		const componentA = partsA[i] ?? 0
		const componentB = partsB[i] ?? 0

		if (componentA < componentB) return -1
		if (componentA > componentB) return 1
	}

	return 0
}

/**
 * Checks if a version satisfies the given constraints.
 *
 * @param version - Version to check
 * @param minVersion - Minimum required version (inclusive)
 * @param maxVersion - Maximum allowed version (inclusive)
 * @returns true if version satisfies constraints
 */
export function satisfiesVersionConstraints(
	version: string,
	minVersion?: string,
	maxVersion?: string,
): boolean {
	if (minVersion && compareVersions(version, minVersion) < 0) {
		return false
	}
	if (maxVersion && compareVersions(version, maxVersion) > 0) {
		return false
	}
	return true
}

/**
 * Detects the installed version of a decoder.
 *
 * @param decoderType - Type of decoder to detect version for
 * @param customConfig - Optional custom version command configuration
 * @returns Version detection result
 */
export function detectDecoderVersion(
	decoderType: string,
	customConfig?: VersionCommandConfig,
): VersionDetectionResult {
	const config = customConfig ?? DEFAULT_VERSION_COMMANDS[decoderType]

	if (!config) {
		return {
			success: false,
			error: `No version detection configuration for decoder type: ${decoderType}`,
		}
	}

	try {
		// Execute the version command
		const output = execSync(`${config.command} ${config.args.join(" ")}`, {
			encoding: "utf-8",
			timeout: 5000,
			stdio: ["pipe", "pipe", "pipe"],
		})

		// Try to match the version pattern
		const match = config.pattern.exec(output)
		if (match) {
			const captureGroup = config.captureGroup ?? 1
			const version = match[captureGroup]
			if (version) {
				return {
					success: true,
					version,
				}
			}
		}

		return {
			success: false,
			error: `Could not parse version from output: ${output.substring(0, 100)}`,
		}
	} catch (err) {
		// Try stderr as some programs output version to stderr
		if (err && typeof err === "object" && "stderr" in err) {
			const stderr = (err as { stderr: Buffer | string }).stderr
			const stderrStr =
				typeof stderr === "string" ? stderr : (stderr?.toString() ?? "")

			const match = config.pattern.exec(stderrStr)
			if (match) {
				const captureGroup = config.captureGroup ?? 1
				const version = match[captureGroup]
				if (version) {
					return {
						success: true,
						version,
					}
				}
			}
		}

		const errorMessage =
			err instanceof Error
				? err.message
				: "Unknown error during version detection"
		return {
			success: false,
			error: errorMessage,
		}
	}
}

/**
 * Validates a decoder's installed version against configured constraints.
 * Requirements: 27.1, 27.2, 27.3
 *
 * @param decoderType - Type of decoder to validate
 * @param minVersion - Minimum required version
 * @param maxVersion - Maximum allowed version
 * @param customConfig - Optional custom version command configuration
 * @returns Validation result with details
 */
export function validateDecoderVersion(
	decoderType: string,
	minVersion?: string,
	maxVersion?: string,
	customConfig?: VersionCommandConfig,
): VersionValidationResult {
	// If no constraints specified, validation passes
	if (!minVersion && !maxVersion) {
		return { valid: true }
	}

	// Detect the installed version
	const detection = detectDecoderVersion(decoderType, customConfig)

	if (!detection.success || !detection.version) {
		return {
			valid: false,
			minVersion,
			maxVersion,
			error: detection.error ?? "Failed to detect decoder version",
		}
	}

	const detectedVersion = detection.version

	// Check version constraints
	if (!satisfiesVersionConstraints(detectedVersion, minVersion, maxVersion)) {
		let error = `Decoder ${decoderType} version ${detectedVersion} does not satisfy constraints`
		if (minVersion && maxVersion) {
			error += ` (required: ${minVersion} - ${maxVersion})`
		} else if (minVersion) {
			error += ` (minimum required: ${minVersion})`
		} else if (maxVersion) {
			error += ` (maximum allowed: ${maxVersion})`
		}

		return {
			valid: false,
			detectedVersion,
			minVersion,
			maxVersion,
			error,
		}
	}

	return {
		valid: true,
		detectedVersion,
		minVersion,
		maxVersion,
	}
}

/**
 * Generates upgrade instructions for a decoder version mismatch.
 * Requirement: 27.2
 *
 * @param decoderType - Type of decoder
 * @param currentVersion - Currently installed version
 * @param requiredVersion - Required version (min or max)
 * @param isMinimum - Whether this is a minimum version requirement
 * @returns Upgrade instruction message
 */
export function getUpgradeInstructions(
	decoderType: string,
	currentVersion: string,
	requiredVersion: string,
	isMinimum: boolean,
): string {
	if (isMinimum) {
		return (
			`Decoder ${decoderType} version ${currentVersion} is below minimum required version ${requiredVersion}. ` +
			`Please upgrade ${decoderType} to version ${requiredVersion} or higher.`
		)
	} else {
		return (
			`Decoder ${decoderType} version ${currentVersion} exceeds maximum allowed version ${requiredVersion}. ` +
			`Please downgrade ${decoderType} to version ${requiredVersion} or lower, or update the maxVersion configuration.`
		)
	}
}
