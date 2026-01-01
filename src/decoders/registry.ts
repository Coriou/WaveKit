/**
 * Decoder Registry - Plugin system for registering decoder factories
 *
 * Requirements:
 * - 5.1: WHEN a decoder type is registered, THE Decoder_Registry SHALL store the factory function for that type
 * - 5.2: WHEN a decoder is requested by type, THE Decoder_Registry SHALL create an instance using the registered factory
 * - 5.3: WHEN an unregistered decoder type is requested, THE Decoder_Registry SHALL return an error
 * - 5.4: THE Decoder_Registry SHALL provide a list of all registered decoder types
 * - 17.1: WHEN a decoder is registered, THE Decoder_Registry SHALL store its capabilities
 * - 17.2: WHEN a decoder is created, THE Decoder_Manager SHALL validate its capabilities against the assigned source
 */

import type {
	Decoder,
	DecoderConfig,
	DecoderCaps,
	DecoderInputType,
	DecoderOutputFormat,
} from "./types.js"
import type { SourceCaps } from "../config.js"
import type { Logger } from "../utils/logger.js"
import { RegistryError } from "../utils/errors.js"

/**
 * Factory function type for creating decoder instances.
 * Each decoder type registers a factory that creates instances with the given config and logger.
 */
export type DecoderFactory = (config: DecoderConfig, logger: Logger) => Decoder

/**
 * Metadata stored for each registered decoder factory (Requirement 17.1).
 * Includes the factory function, capabilities, and optional version constraints.
 */
export interface DecoderFactoryMeta {
	factory: DecoderFactory
	caps: DecoderCaps
	minVersion?: string | undefined
	maxVersion?: string | undefined
}

/**
 * Version constraints for decoder registration.
 */
export interface VersionConstraints {
	min?: string
	max?: string
}

/**
 * DecoderRegistry - Plugin system for registering and creating decoder instances.
 *
 * Provides a factory pattern for decoder creation, allowing new decoder types
 * to be registered at runtime without modifying core code. Also stores decoder
 * capabilities for compatibility checking (Requirement 17.1).
 */
export class DecoderRegistry {
	private factories: Map<string, DecoderFactoryMeta> = new Map()

	/**
	 * Registers a decoder factory for a given type with capabilities.
	 * Requirement 5.1: Store the factory function for the type.
	 * Requirement 17.1: Store the decoder capabilities.
	 *
	 * @param type - Unique identifier for the decoder type (e.g., 'dsd-fme', 'multimon-ng')
	 * @param factory - Factory function that creates decoder instances
	 * @param caps - Decoder capabilities declaration
	 * @param versionConstraints - Optional version constraints (min/max versions)
	 */
	register(
		type: string,
		factory: DecoderFactory,
		caps: DecoderCaps,
		versionConstraints?: VersionConstraints,
	): void {
		this.factories.set(type, {
			factory,
			caps,
			minVersion: versionConstraints?.min,
			maxVersion: versionConstraints?.max,
		})
	}

	/**
	 * Unregisters a decoder factory for a given type.
	 *
	 * @param type - The decoder type to unregister
	 * @returns true if the type was registered and removed, false if it wasn't registered
	 */
	unregister(type: string): boolean {
		return this.factories.delete(type)
	}

	/**
	 * Creates a decoder instance using the registered factory.
	 * Requirement 5.2: Create an instance using the registered factory.
	 * Requirement 5.3: Return an error for unregistered types.
	 *
	 * @param config - Configuration for the decoder instance
	 * @param logger - Logger instance for the decoder
	 * @returns A new decoder instance
	 * @throws RegistryError if the decoder type is not registered
	 */
	create(config: DecoderConfig, logger: Logger): Decoder {
		const meta = this.factories.get(config.type)
		if (!meta) {
			throw new RegistryError(config.type)
		}
		return meta.factory(config, logger)
	}

	/**
	 * Checks if a decoder type is registered.
	 *
	 * @param type - The decoder type to check
	 * @returns true if the type is registered, false otherwise
	 */
	has(type: string): boolean {
		return this.factories.has(type)
	}

	/**
	 * Gets a list of all registered decoder types.
	 * Requirement 5.4: Provide a list of all registered decoder types.
	 *
	 * @returns Array of registered decoder type names
	 */
	getRegisteredTypes(): string[] {
		return Array.from(this.factories.keys())
	}

	/**
	 * Gets the capabilities for a registered decoder type (Requirement 17.1).
	 *
	 * @param type - The decoder type to get capabilities for
	 * @returns DecoderCaps or undefined if the type is not registered
	 */
	getCaps(type: string): DecoderCaps | undefined {
		return this.factories.get(type)?.caps
	}

	/**
	 * Gets the full metadata for a registered decoder type.
	 *
	 * @param type - The decoder type to get metadata for
	 * @returns DecoderFactoryMeta or undefined if the type is not registered
	 */
	getMeta(type: string): DecoderFactoryMeta | undefined {
		return this.factories.get(type)
	}

	/**
	 * Gets all decoder types that accept a specific input type.
	 * Useful for finding decoders compatible with a source kind.
	 *
	 * @param input - The input type to filter by
	 * @returns Array of decoder type names that accept the specified input
	 */
	getDecodersByInput(input: DecoderInputType): string[] {
		const result: string[] = []
		for (const [type, meta] of this.factories) {
			if (meta.caps.input === input) {
				result.push(type)
			}
		}
		return result
	}

	/**
	 * Gets all decoder types that produce a specific output format.
	 * Useful for finding decoders that produce a desired output format.
	 *
	 * @param output - The output format to filter by
	 * @returns Array of decoder type names that produce the specified output
	 */
	getDecodersByOutput(output: DecoderOutputFormat): string[] {
		const result: string[] = []
		for (const [type, meta] of this.factories) {
			if (meta.caps.output === output) {
				result.push(type)
			}
		}
		return result
	}

	/**
	 * Gets all decoder types that are compatible with a source's capabilities.
	 * A decoder is compatible if:
	 * - Its input type matches the source kind, OR
	 * - Its input type is 'external' (manages its own source)
	 *
	 * @param sourceCaps - The source capabilities to check against
	 * @returns Array of decoder type names compatible with the source
	 */
	getCompatibleDecoders(sourceCaps: SourceCaps): string[] {
		const result: string[] = []
		for (const [type, meta] of this.factories) {
			// External decoders manage their own sources, always compatible
			if (meta.caps.input === "external") {
				result.push(type)
				continue
			}

			// Check if decoder input type matches source kind
			if (meta.caps.input === sourceCaps.kind) {
				result.push(type)
			}
		}
		return result
	}
}
