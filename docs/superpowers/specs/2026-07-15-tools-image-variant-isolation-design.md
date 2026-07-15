# Scan Tools Image Variant Isolation

## Goal

Prevent development scan-tools builds from being discovered, rebuilt, or
overwritten by a release Vulseek environment sharing the same Docker daemon.

## Design

The tools content hash remains the immutable version. A separate runtime
variant selects the Docker repository:

- `dev` -> `vulseek-scan-tools-dev:<content-hash>`
- `release` -> `vulseek-scan-tools-release:<content-hash>`

`VULSEEK_TOOLS_IMAGE_VARIANT` is the explicit process boundary. `dev.sh`
sets it to `dev`; `run.sh` sets it to `release`. When unset, production
processes resolve to `release` and all other processes resolve to `dev`.
Invalid explicit values fail fast.

The image stores a
`com.fuzzing-peach.vulseek.scan-tools.variant` label. Image inspection checks
both the content version and variant, so a manually retagged image from the
other environment cannot be reused. Existing `vulseek-scan-tools:<hash>`
images are ignored and are not deleted.

## Verification

Unit tests cover explicit variants, environment-derived defaults, invalid
values, distinct image repositories for the same hash, and variant label
validation inputs. Shell assertions verify both environment scripts inject
the explicit variant. Server and app typechecks and checkout-tools tests must
pass.
