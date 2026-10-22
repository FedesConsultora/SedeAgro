# 0P.37 — Immutable image identity at stopped container creation (CI only)

## Defect and evidence boundary

Previous blocks had verified OCI TAR and GitHub OIDC/Sigstore attestations,
two imported image configs and RootFS layers, and a no-build production
Compose overlay. None tested what IMAGE ID Docker pins when a container is
actually CREATED. Checking mutable tags before a later Compose create leaves
a substitution/TOCTOU window.

This block covers that real Docker boundary in a disposable CI daemon ONLY.

## Main-only signed OCI receiver

After the two signed OCI subjects, five signed Syft/Trivy reports, full TAR
verification, independent docker load and no-build production Compose
overlay acceptance, ci-oci-container-creation.mjs:

1. Independently repeats prior TAR, imported config and overlay validation.
2. Uses docker container create by immutable sha256 image CONFIG ID from
   the signed receipt — never a mutable tag. Options: --pull=never,
   --network=none, --read-only, diagnostics-only entrypoint and command.
3. Inspects both resulting stopped containers to require the exact config
   ID, created/not running state, no network/ports/volumes/privilege,
   readonly rootfs and unique bounded disposable name.
4. Never starts either container. Removes containers and anonymous volumes
   inside finally clauses; validates no named test containers remain.
   Failure to remove or verify removal is an overall FAILURE.
5. Emits CI_OCI_STOPPED_CONTAINER_CREATION_IMAGE_IDS_VERIFIED_NOT_DEPLOYED,
   with production_deploy_certified:false,
   runtime_compose_certified:false,
   production_race_lock_certified:false and
   security_owner_approved:false.

Docker CLI documents that create does NOT start the container and that
--pull=never prevents downloading an image. This scope deliberately
excludes remote Docker contexts and any deployment infrastructure.

## Adversarial acceptance and explicit limits

Regression tests reject incorrect or changed image IDs, changed SHA/TAR,
mutable tag attempts, altered stopped/running state, host networking,
ports, mounts, privilege, entrypoints, malformed container IDs, bad names,
cleanup failure and incomplete receipt. Only signed-main CI runs the real
create/inspect/delete workflow, after the OCI and security signature gates.

The proof does NOT start services or check the production Compose host,
production runtime identity locks, concurrent deploy protection, real
secrets, backup/restore or rollout health. The actual deploy-prod.sh
remains blocked at production-preflight and still rebuilds locally. The
security owner trust registry remains EMPTY and cannot issue a real
human release authorization.

Pending P0-S05b2b: independently approved Security Owner enrollment and
risk signoff, exclusive deployment lock, immutable IDs at actual
production Compose container create, external backups and restore/rollback,
authorized private HTTPS staging, Android/iOS physical rural offline QA,
performance #143 and Security, Operations, Data, Product signoffs.

This block accessed NO VPS, private DB, DNS, TLS, staging, production
or credentials and never started a Docker application container.
