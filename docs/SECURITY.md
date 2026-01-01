# WaveKit Security Guide

> **Document Type**: Security Best Practices & Advisory Tracking
> **Audience**: System Operators, Developers, Security Teams
> **Status**: Active
> **Last Updated**: 2026-01-01

## Overview

WaveKit integrates multiple third-party decoder binaries (dsd-fme, multimon-ng, rtl_433, readsb, acarsdec, dumpvdl2, AIS-catcher, direwolf). These external dependencies require careful version management and security monitoring to maintain a secure deployment.

This document covers:

1. [Version Pinning Best Practices](#version-pinning-best-practices)
2. [Security Advisory Tracking Process](#security-advisory-tracking-process)
3. [Known Security Advisories](#known-security-advisories)
4. [Incident Response](#incident-response)

---

## Version Pinning Best Practices

### Why Version Pinning Matters

Decoder binaries process untrusted radio signals and can be vulnerable to:

- Buffer overflows from malformed packets
- Denial of service from crafted signals
- Remote code execution in parsing logic
- Memory corruption from unexpected input

Version pinning ensures:

- **Reproducibility**: Deployments behave consistently across environments
- **Security**: Known-vulnerable versions can be blocked
- **Stability**: Unexpected behavior from untested versions is prevented

### Configuration

WaveKit supports version constraints via the `minVersion` and `maxVersion` fields in decoder configuration:

```yaml
# config/default.yaml
decoders:
  - id: direwolf
    type: direwolf
    enabled: true
    # Version pinning - REQUIRED for security
    minVersion: "1.7.1" # Minimum safe version (post-CVE fix)
    maxVersion: "1.8.0" # Maximum tested version
    options:
      kissPort: 8001

  - id: dsd
    type: dsd-fme
    enabled: true
    minVersion: "2.0.0"
    options:
      mode: auto
```

### Version Constraint Guidelines

| Constraint        | When to Use                     | Example                                    |
| ----------------- | ------------------------------- | ------------------------------------------ |
| `minVersion` only | Block known-vulnerable versions | `minVersion: "1.7.1"`                      |
| `maxVersion` only | Limit to tested versions        | `maxVersion: "2.0.0"`                      |
| Both              | Production deployments          | `minVersion: "1.7.1", maxVersion: "1.8.0"` |
| Neither           | Development/testing only        | Not recommended for production             |

### Validation Behavior

When WaveKit starts, it validates decoder versions:

1. **Version Detection**: Runs decoder with `--version` flag
2. **Constraint Check**: Compares against configured min/max
3. **Warning/Error**: Logs appropriate message with upgrade instructions

```
# Example log output for version mismatch
WARN [DecoderManager] Decoder direwolf version 1.6.0 is below minimum required version 1.7.1. Please upgrade direwolf to version 1.7.1 or higher.
```

### Recommended Version Constraints

| Decoder     | Min Version | Max Version | Notes                         |
| ----------- | ----------- | ----------- | ----------------------------- |
| direwolf    | 1.7.1       | -           | CVE-2025-34458 fixed in 1.7.1 |
| dsd-fme     | 2.0.0       | -           | Stable release                |
| multimon-ng | 1.2.0       | -           | Stable release                |
| rtl_433     | 23.11       | -           | Active development            |
| readsb      | 3.14.0      | -           | Modern ADS-B stack            |
| acarsdec    | 3.7.0       | -           | Maintained fork               |
| dumpvdl2    | 2.5.0       | -           | Stable release                |
| AIS-catcher | 0.50        | -           | Active development            |

---

## Security Advisory Tracking Process

### Monitoring Sources

WaveKit operators should monitor these sources for security advisories:

1. **National Vulnerability Database (NVD)**
   - URL: https://nvd.nist.gov/
   - Search for decoder names (e.g., "direwolf", "rtl_433")

2. **GitHub Security Advisories**
   - Check each decoder's GitHub repository
   - Enable "Watch" → "Security alerts" for repositories

3. **Decoder Mailing Lists / Forums**
   - Many decoders have dedicated mailing lists
   - SDR-focused forums often discuss vulnerabilities

4. **WaveKit Security Announcements**
   - Check WaveKit repository releases for security notes
   - Subscribe to WaveKit security mailing list (if available)

### Monthly Security Review Process

Perform this review monthly (or more frequently for critical systems):

#### Step 1: Check for New Advisories

```bash
# Search NVD for decoder-related CVEs
# Visit: https://nvd.nist.gov/vuln/search
# Search terms: direwolf, rtl_433, multimon-ng, dsd-fme, readsb, acarsdec, dumpvdl2, AIS-catcher
```

#### Step 2: Review Decoder Releases

Check each decoder's release page for security-related updates:

| Decoder     | Release Page                                         |
| ----------- | ---------------------------------------------------- |
| direwolf    | https://github.com/wb2osz/direwolf/releases          |
| dsd-fme     | https://github.com/lwvmobile/dsd-fme/releases        |
| multimon-ng | https://github.com/EliasOeworsl/multimon-ng/releases |
| rtl_433     | https://github.com/merbanan/rtl_433/releases         |
| readsb      | https://github.com/wiedehopf/readsb/releases         |
| acarsdec    | https://github.com/TLeconte/acarsdec/releases        |
| dumpvdl2    | https://github.com/szpajder/dumpvdl2/releases        |
| AIS-catcher | https://github.com/jvde-github/AIS-catcher/releases  |

#### Step 3: Update Version Constraints

If a security issue is found:

1. Identify the fixed version
2. Update `minVersion` in configuration
3. Test the new version in a staging environment
4. Deploy to production
5. Document the change in your change log

#### Step 4: Document Findings

Maintain a security log with:

- Date of review
- Advisories found (if any)
- Actions taken
- Next review date

### Automated Monitoring (Recommended)

For production deployments, consider:

1. **Dependabot/Renovate**: Configure for Docker base images
2. **CVE Monitoring Services**: Snyk, Trivy, or similar
3. **Custom Scripts**: Periodic version checks against known-good lists

Example monitoring script:

```bash
#!/bin/bash
# check-decoder-versions.sh
# Run periodically via cron

DECODERS=("direwolf" "dsd-fme" "multimon-ng" "rtl_433")
MIN_VERSIONS=("1.7.1" "2.0.0" "1.2.0" "23.11")

for i in "${!DECODERS[@]}"; do
    decoder="${DECODERS[$i]}"
    min_version="${MIN_VERSIONS[$i]}"

    # Check if decoder is installed and get version
    # (Implementation depends on decoder)
    echo "Checking $decoder >= $min_version"
done
```

---

## Known Security Advisories

### Active Advisories

| CVE            | Decoder  | Severity | Fixed Version | Description                            |
| -------------- | -------- | -------- | ------------- | -------------------------------------- |
| CVE-2025-34458 | direwolf | HIGH     | 1.7.1         | Buffer overflow in APRS packet parsing |

### Mitigations

#### CVE-2025-34458 (Direwolf)

**Affected Versions**: < 1.7.1

**Description**: A buffer overflow vulnerability in Direwolf's APRS packet parsing could allow remote code execution via crafted APRS packets.

**Mitigation**:

1. **Upgrade** to direwolf 1.7.1 or later (recommended)
2. **Configure version constraint**:
   ```yaml
   decoders:
     - id: direwolf
       type: direwolf
       minVersion: "1.7.1"
   ```
3. **Network isolation**: If upgrade is not immediately possible, isolate the decoder from untrusted networks

**References**:

- NVD: https://nvd.nist.gov/vuln/detail/CVE-2025-34458
- GitHub Advisory: Check direwolf repository

---

## Incident Response

### If a Vulnerability is Discovered

1. **Assess Impact**
   - Is the vulnerable decoder enabled in your deployment?
   - Is the vulnerability exploitable in your environment?
   - What data/systems could be affected?

2. **Immediate Mitigation**
   - Disable the affected decoder if not critical
   - Apply network-level controls (firewall rules)
   - Update version constraints to block vulnerable versions

3. **Remediation**
   - Update to patched version
   - Test in staging environment
   - Deploy to production
   - Verify fix is applied

4. **Post-Incident**
   - Document the incident
   - Update monitoring to catch similar issues
   - Review other decoders for similar vulnerabilities

### Emergency Contacts

Maintain a list of contacts for security incidents:

- WaveKit maintainers: [GitHub Issues](https://github.com/your-org/wavekit/issues)
- Decoder maintainers: See GitHub repositories above
- Your organization's security team

---

## Security Checklist

Use this checklist for new deployments:

- [ ] All decoders have `minVersion` configured
- [ ] Version constraints block known-vulnerable versions
- [ ] Security advisory monitoring is set up
- [ ] Monthly security review is scheduled
- [ ] Incident response contacts are documented
- [ ] Docker images use pinned base image versions
- [ ] Network isolation is configured appropriately
- [ ] Logging captures version validation warnings

---

## References

- [NIST National Vulnerability Database](https://nvd.nist.gov/)
- [GitHub Security Advisories](https://github.com/advisories)
- [WaveKit Decoder Expansion Roadmap](./DECODER-EXPANSION.md)
- [CVE-2025-34458 (Direwolf)](https://nvd.nist.gov/vuln/detail/CVE-2025-34458)
