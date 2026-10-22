# 0P.35 — Read-only production OCI overlay preview (release still NO-GO)

## Defect and objective

The existing `docker-compose.yml` is authoritative for SedeAgro
production topology, but its backend and frontend service definitions
still contain `build:`. Even after CI validates and signs the Docker
archive, replaying this Compose as-is would rebuild image bytes locally.
0P.34 verified only a separate isolated diagnostic Compose consumer,
not the real production topology.

This block adds a **read-only proof of a candidate image-only overlay**
while leaving the actual deployment script, existing Compose file,
staging/prod services, secrets and data untouched.

## Proposed image-only merge, never operationally activated here

`docker-compose.oci-production-override.yml` declares exactly:

- backend: `build: !reset null`,
  `image: ${SEDEAGRO_OCI_BACKEND_IMAGE:?…}`,
  `pull_policy: never`.
- frontend: same for its SHA-pinned OCI tag.

`!reset null` is from the Compose specification; it **removes**
the original `build` configuration instead of silently merging it
or copying a second production topology. The overlay has no other
service, network, volume or environment changes. `pull_policy: never`
is necessary but not sufficient: the image tags **must be checked
against config IDs and RootFS layers** in the signed OCI receipt.

This is deliberately **NOT** called by `deploy-prod.sh`, which
still invokes `production-preflight.sh` and fails closed, because
the signed security report still says `release_go=false`.

## CI-only exact SHA acceptance and adversarial checks

The new `scripts/ci-oci-production-overlay.mjs` runs ONLY on push/main
inside GitHub's disposable signed OCI-receiver runner, after:

1. complete OCI TAR receipt, digest/config/layers verification,
2. GitHub Sigstore/SLSA attestation verification of TAR+receipt,
3. all five signed Syft/Trivy security files checked against images,
4. fresh `docker image load` with imported IDs and layers confirmed,
5. isolated OCI Compose consumer parity (0P.34).

It reuses the 0P.34 verification result, then renders **both** actual
Compose models with Docker Compose v2:

- base production `docker-compose.yml`;
- base plus new OCI-only override.

Both are rendered by `docker compose ... config --no-env-resolution
--format json` with synthetic placeholders and
`COMPOSE_DISABLE_ENV_FILE=1`. **Docker Compose still requires that a
service `env_file` physically exist even with `--no-env-resolution`.**
The verifier therefore copies only the two **committed YAML files**
into a private 0700 temporary directory, writes an ephemeral 0600
`backend/.env` containing ONLY `NODE_ENV=ci-oci-review-only`, and
deletes everything in a `finally` block. Its Docker subprocess gets
a tightly controlled environment with synthetic DB passwords and
no inherited application secrets. Production `.env` and real service
env files are **never read, loaded, or copied**; no credentials logged
or exported and no service started. The parser compares the complete normalized trees. Only two
differences are allowed: backend/frontend lose `build` and gain their
exact SHA40 OCI image tags and `pull_policy: never`. It rejects changes
to DB/Redis pinned images, dependency ordering, fedes-net, internal
network, roles, volumes, environment, healthchecks, restart, ports,
extra services, extra keys or any surprise normalization.

Positive result:
`CI_OCI_PRODUCTION_TOPOLOGY_OVERLAY_VALIDATED_NOT_DEPLOYED`.
This means the *config-rendered candidate topology* selects two
exact pre-imported image IDs. It does **not** mean containers were
created; the receipt explicitly states
`production_deploy_certified:false`,
`time_of_use_certified:false`,
`security_owner_approved:false`.

Adversarial tests check wrong SHA, missing/duplicate services, extra
ports/volumes, loosened pull rules, mutated DB/Redis digests, altered
security metadata and missing/changed OCI IDs. A real Docker Compose
v2 render must pass in hosted CI; no fake-GO by skipping real output.

## Still required before first pilot

- Independent signed Security Owner signoff for MEDIUM/UNKNOWN, bound
  to **specific SHA + TAR checksum + images + risk receipt** with expiry.
  Current `release_go=false` is authoritative and must not be edited.
- Real production consumption path with identity revalidation **at
  container-creation time** (avoid substitution/TOCTOU), approval lease
  and exclusive deployment lock. The new overlay is NEVER used to
  start services in this block.
- First authorized, isolated staging HTTPS, RLS/CSRF/proxy acceptance,
  external encrypted backup + real restore/rollback drill and
  mobile Android/iPhone offline acceptance, plus performance #143.
- Owner signoff Security, Operations, Data and Product. **NO-GO** until
  all real-world gates are met.

No VPS, staging/prod, private DB, DNS, proxy, secrets or credentials
were accessed or mutated.
