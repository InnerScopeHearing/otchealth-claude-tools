# Data Protection and Incident Response Policy

**Organization:** OTCHealth Inc. (Nevada C-Corp)
**Scope:** Amazon Selling Partner API (SP-API) integration for the OTCHealth Inc.
Amazon Seller Central account, and all systems, code, and personnel that store,
process, or transmit Amazon Information.
**Owner:** Chief Technology Officer (CTO)
**Effective:** 2026-06-15
**Review cadence:** Reviewed and updated at least every 6 months, and after any
material change to the integration or any security incident.

This document backs the Security Controls attestations made during Amazon
Developer Central registration. "Amazon Information" means any data obtained
through the SP-API (orders, listings, inventory, pricing, reports, settlement,
and any Personally Identifiable Information that a Restricted role would expose).

---

## 1. Roles and responsibilities

| Role | Holder | Responsibility |
| --- | --- | --- |
| Policy Owner / Incident Commander | CTO | Owns this policy, declares incidents, coordinates response, approves access. |
| Deputy / Engineering | App / Commerce engineering lead | Executes containment and remediation, rotates credentials. |
| Compliance / Legal | Compliance Officer + outside counsel | Regulatory and contractual notification decisions. |
| Executive sponsor | President (Matt Moore) | Final authority on disclosure, spend, and external communication. |

A single named person (the CTO) is the standing Incident Commander. If that
person is unavailable, the Deputy assumes the role until relieved.

## 2. Data minimization and use limitation

- **Least data.** We request only the SP-API roles the business actually uses
  (selling operations: listings, inventory, orders, pricing, reports). We do
  **not** request Restricted (PII) roles unless a fulfillment need requires them,
  and adding any such role triggers a fresh review under this policy first.
- **Use limitation.** Amazon Information is used solely to operate the OTCHealth
  Inc. seller account. It is never used to build profiles, train external models,
  or for any purpose outside direct seller operations.
- **No third-party sharing.** Amazon Information is **never** sold, shared, or
  disclosed to any third party. It stays within OTCHealth Inc. systems.
- **Sourced only from SP-API.** Amazon Information is retrieved only through the
  official SP-API. We do not scrape, buy, or otherwise acquire Amazon data.
- **Retention.** Amazon Information is retained only as long as needed for the
  operation or to meet a legal/tax obligation, then deleted. PII (if ever
  ingested) is retained no longer than 30 days unless law requires otherwise.

## 3. Encryption

- **In transit.** All Amazon Information is transmitted over TLS 1.2 or higher.
  The SP-API and the LWA token endpoint are HTTPS-only; the integration makes no
  plaintext calls.
- **At rest.** Any Amazon Information persisted is stored on encrypted media
  (provider-managed AES-256 at rest). Credentials are stored only in a managed
  secret store (see Section 4), never in plaintext on disk.

## 4. Credential management

- **Secret storage.** All SP-API credentials (LWA client id, client secret,
  refresh token, seller/merchant token) live in a managed secret manager
  (Google Cloud Secret Manager, `otchealth-shared-prod`). They are injected as
  environment variables at runtime and never written to source.
- **No hardcoded credentials.** Credentials never appear in source code, commit
  history, build logs, container images, or any public repository. Pre-commit
  and CI secret scanning enforce this.
- **Least privilege.** Access to the secret store and to the seller account is
  role-based and granted on a need-to-use basis. Service accounts hold the
  minimum scopes required.
- **Account credential standard.** Human accounts that can reach Amazon
  Information or its credentials meet:
  - minimum 12-character passwords including special characters,
  - multi-factor authentication (MFA) enabled,
  - rotation at least every 365 days (and immediately on suspected compromise),
  - no shared accounts; one identity per person.
- **API credential rotation.** The LWA client secret and refresh token are
  rotated at least annually and immediately upon any suspected exposure.

## 5. Access control and monitoring

- Access to production systems handling Amazon Information requires
  authentication and is logged.
- The integration logs API call status and rate-limit headers but never logs
  secret values or full PII payloads.
- Access grants are reviewed at each 6-month policy review and revoked promptly
  on role change or departure.

## 6. Incident response procedure

An "incident" is any actual or suspected unauthorized access, disclosure, loss,
or misuse of Amazon Information, or compromise of any credential that can reach
it.

1. **Detect and report.** Anyone who suspects an incident notifies the Incident
   Commander (CTO) immediately through the internal escalation channel.
2. **Triage and declare.** The Incident Commander confirms scope and severity
   and declares an incident, opening a timestamped incident record.
3. **Contain.** Revoke or rotate affected credentials, disable the affected app
   client or access path, and isolate impacted systems.
4. **Notify Amazon.** For any confirmed Security Incident involving Amazon
   Information, notify Amazon within **24 hours** of detection by emailing
   **security@amazon.com**, with follow-up as the investigation develops.
5. **Notify others.** Compliance and counsel determine any additional regulatory
   or contractual notifications and timelines.
6. **Eradicate and recover.** Remove the root cause, restore clean service, and
   confirm the threat is cleared before reopening normal access.
7. **Post-incident review.** Within 14 days, complete a written root-cause
   analysis and corrective-action plan, and fold the lessons into this policy.

## 7. Secure development and supply chain

- Code is reviewed before merge; changes touching Amazon Information or its
  credentials get a security review.
- Dependencies are pinned, scanned, and held to a cooldown before adoption.
- GitHub Actions are SHA-pinned. Secrets reach CI only through the platform
  secret store (sealed), never committed.

## 8. Review and attestation

This policy is reviewed at least every 6 months by the CTO, and on any material
change or incident. The reviewer records the date and any changes below.

| Review date | Reviewer | Changes |
| --- | --- | --- |
| 2026-06-15 | CTO | Initial version for SP-API onboarding. |
