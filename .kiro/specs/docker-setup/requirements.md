# Requirements Document

## Introduction

This specification defines the requirements for a production-ready Docker setup for WaveKit, an SDR (Software Defined Radio) stream processing framework. The goal is to create a Docker deployment that "just works" with minimal configuration, supports multiple deployment scenarios, and provides robust process management, health monitoring, and graceful error handling.

## Glossary

- **WaveKit_Container**: The Docker container running the WaveKit application and its dependencies
- **s6_overlay**: The init system and process supervisor used for managing multiple services within a single container
- **SDR_Source**: An external source of IQ or audio data (rtl_tcp on Raspberry Pi, SDR++ server, etc.)
- **Decoder**: A signal processing application (dsd-fme, multimon-ng, rtl_433) that converts audio streams into decoded data
- **Health_Check**: A mechanism to verify that services are running correctly and responding to requests
- **Build_System**: The Docker build infrastructure including Dockerfile, build scripts, and BuildKit configuration
- **Service_Definition**: An s6-overlay configuration that defines how a service starts, stops, and restarts

## Requirements

### Requirement 1: Multi-Mode Container Builds

**User Story:** As a developer, I want to build different container variants (full, core, sdrpp-only), so that I can deploy the appropriate configuration for my hardware setup.

#### Acceptance Criteria

1. WHEN a user runs the build script with mode "full", THE Build_System SHALL produce a container with SDR++ server, WaveKit API, and all decoders
2. WHEN a user runs the build script with mode "core", THE Build_System SHALL produce a container with WaveKit API and decoders but without SDR++ server
3. WHEN a user runs the build script with mode "sdrpp", THE Build_System SHALL produce a container with only SDR++ server
4. THE Build_System SHALL support multi-platform builds for linux/amd64, linux/arm64, and linux/arm/v7
5. THE Build_System SHALL use multi-stage builds to minimize final image size
6. WHEN building images, THE Build_System SHALL cache intermediate layers to speed up subsequent builds

### Requirement 2: Automatic Source Detection and Connection

**User Story:** As a user, I want the container to automatically detect and connect to available SDR sources, so that I don't have to manually configure connection parameters.

#### Acceptance Criteria

1. WHEN the WaveKit_Container starts with RTL_TCP_HOST environment variable set, THE WaveKit_Container SHALL attempt to connect to that host
2. WHEN the WaveKit_Container starts without RTL_TCP_HOST but with SDR_SOURCE environment variable, THE WaveKit_Container SHALL parse and connect to the specified source
3. WHEN connection to an SDR_Source fails, THE WaveKit_Container SHALL retry with exponential backoff (starting at 1 second, max 30 seconds)
4. WHEN an SDR_Source connection is lost during operation, THE WaveKit_Container SHALL automatically attempt reconnection
5. THE WaveKit_Container SHALL log connection status changes with appropriate severity levels

### Requirement 3: Robust Process Management with s6-overlay

**User Story:** As an operator, I want all services to be properly supervised and automatically restarted on failure, so that the system remains operational without manual intervention.

#### Acceptance Criteria

1. THE s6_overlay SHALL start services in the correct dependency order (base → sdrpp-server → wavekit-api)
2. WHEN a supervised service crashes, THE s6_overlay SHALL automatically restart it within 5 seconds
3. WHEN the container receives SIGTERM, THE s6_overlay SHALL gracefully stop all services in reverse dependency order
4. THE s6_overlay SHALL propagate environment variables to all child services
5. WHEN a service fails to start after 3 consecutive attempts, THE s6_overlay SHALL mark the service as failed and log the error
6. THE Service_Definition for each service SHALL include proper finish scripts for cleanup

### Requirement 4: Comprehensive Health Checking

**User Story:** As an operator, I want accurate health status reporting, so that I can integrate with orchestration systems and monitoring tools.

#### Acceptance Criteria

1. THE Health_Check SHALL verify that the WaveKit API is responding on port 9000
2. THE Health_Check SHALL verify that all configured decoders are running
3. WHEN in full mode, THE Health_Check SHALL verify that SDR++ server is running
4. THE Health_Check SHALL return exit code 0 when all checks pass and exit code 1 when any check fails
5. THE WaveKit_Container SHALL expose a /health endpoint that returns JSON status of all components
6. THE Health_Check SHALL complete within 10 seconds to avoid timeout issues

### Requirement 5: Configuration Management

**User Story:** As a user, I want to configure the system through environment variables and config files, so that I can customize behavior without rebuilding the container.

#### Acceptance Criteria

1. THE WaveKit*Container SHALL support configuration via environment variables with WAVEKIT* prefix
2. THE WaveKit_Container SHALL support configuration via mounted YAML files at /app/config
3. WHEN both environment variables and config files specify the same setting, THE WaveKit_Container SHALL prioritize environment variables
4. THE WaveKit_Container SHALL validate configuration on startup and fail fast with clear error messages for invalid config
5. THE WaveKit_Container SHALL provide sensible defaults for all optional configuration values
6. WHEN configuration changes are detected in mounted files, THE WaveKit_Container SHALL log the change but require restart to apply

### Requirement 6: Logging and Observability

**User Story:** As an operator, I want structured logging and metrics, so that I can monitor system health and debug issues.

#### Acceptance Criteria

1. THE WaveKit_Container SHALL output structured JSON logs to stdout
2. THE WaveKit_Container SHALL support configurable log levels (debug, info, warn, error)
3. THE WaveKit_Container SHALL include correlation IDs in logs for request tracing
4. THE WaveKit_Container SHALL expose Prometheus-compatible metrics on /metrics endpoint
5. WHEN a decoder produces output, THE WaveKit_Container SHALL log the event with decoder name and message type
6. THE WaveKit_Container SHALL rotate log files in /var/log/wavekit to prevent disk exhaustion

### Requirement 7: Audio Output Streaming

**User Story:** As a user, I want to stream decoded audio to my host machine, so that I can listen to decoded transmissions.

#### Acceptance Criteria

1. THE WaveKit_Container SHALL expose decoded audio on TCP port 8080 in S16LE format at 48kHz mono
2. WHEN a client connects to the audio port, THE WaveKit_Container SHALL begin streaming immediately
3. WHEN multiple clients connect to the audio port, THE WaveKit_Container SHALL stream to all clients simultaneously
4. WHEN a client disconnects, THE WaveKit_Container SHALL continue streaming to remaining clients without interruption
5. IF no clients are connected, THE WaveKit_Container SHALL buffer the last 5 seconds of audio for immediate playback on connect

### Requirement 8: Development Environment Support

**User Story:** As a developer, I want a development environment with hot reload and debugging support, so that I can iterate quickly during development.

#### Acceptance Criteria

1. WHEN running docker-compose.dev.yml, THE Build_System SHALL mount source directories for live code updates
2. THE Build_System SHALL provide a mock RTL-TCP service for testing without hardware
3. THE Build_System SHALL expose debugging ports for Node.js inspector
4. WHEN source files change, THE WaveKit_Container in dev mode SHALL automatically restart the affected service
5. THE Build_System SHALL provide shell access to running containers via make docker-shell

### Requirement 9: Security Hardening

**User Story:** As a security-conscious operator, I want the container to follow security best practices, so that I can deploy it in production environments.

#### Acceptance Criteria

1. THE WaveKit_Container SHALL run with no-new-privileges security option
2. THE WaveKit_Container SHALL drop all capabilities except those explicitly required (SYS_NICE, NET_RAW)
3. THE WaveKit_Container SHALL not run services as root where possible
4. THE Build_System SHALL not include build tools or source code in the final image
5. THE WaveKit_Container SHALL not expose unnecessary ports
6. WHEN secrets are provided via environment variables, THE WaveKit_Container SHALL mask them in logs

### Requirement 10: Graceful Degradation

**User Story:** As an operator, I want the system to continue operating in degraded mode when non-critical components fail, so that I maintain partial functionality.

#### Acceptance Criteria

1. WHEN a single decoder fails, THE WaveKit_Container SHALL continue operating other decoders
2. WHEN SDR++ server fails in full mode, THE WaveKit_Container SHALL attempt to reconnect while keeping the API available
3. WHEN the SDR_Source is unavailable, THE WaveKit_Container SHALL report degraded status but keep the API responsive
4. THE Health_Check SHALL distinguish between healthy, degraded, and unhealthy states
5. WHEN operating in degraded mode, THE WaveKit_Container SHALL log warnings every 60 seconds until the issue is resolved
