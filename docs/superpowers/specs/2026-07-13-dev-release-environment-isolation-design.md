# Dev and Release Environment Isolation

## Goal

Run development and release Vulseek environments concurrently on one Docker
host without sharing application services, networks, databases, Redis data,
scan context, or published ports.

Both environments use the host's single Docker Swarm. Swarm membership is not
duplicated; isolation is provided by environment-specific service, network,
volume, directory, and port names.

## Deployment Entry Points

- `dev.sh` is the only supported entry point for the development environment.
- `run.sh` is the only supported entry point for the release environment.
- `docker-compose.dev.yml` and `docker-compose.release.yml` are removed to avoid
  configuration drift and accidental cross-environment dependencies.
- Both scripts initialize Swarm only when the host is not already a Swarm
  member. They reuse the same active Swarm when run on the same host.

## Resource Isolation

Development resources use the `vulseek-dev-*` namespace:

- Network: `vulseek-dev-network`
- Application: `vulseek-dev`
- PostgreSQL: `vulseek-postgres-dev`
- Redis: `vulseek-redis-dev`
- Traefik: `vulseek-traefik-dev`
- Persistent volumes use development-specific names.
- Default scan context: `<repository>/vulseek-data-dev`

Release resources use the `vulseek-release-*` namespace:

- Network: `vulseek-release-network`
- Application: `vulseek-release`
- PostgreSQL: `vulseek-postgres-release`
- Redis: `vulseek-redis-release`
- Traefik: `vulseek-traefik-release`
- Persistent volumes use release-specific names.
- Default scan context: `<repository>/vulseek-data-release` (the existing
  release data directory is renamed in place; its contents are preserved)

The Vulseek application connects to PostgreSQL and Redis by internal Swarm DNS
name and container port. It must not use the other environment's service name.

## Published Ports

Development remains in the `2xxxx` range:

| Service | Host port | Container port |
| --- | ---: | ---: |
| Vulseek | 23000 | 3000 |
| PostgreSQL | 25432 | 5432 |
| Redis | 26379 | 6379 |
| Traefik HTTP | 20080 | 80 |
| Traefik dashboard | 28080 | 8080 |
| Node debug | 29229 | 9229 |
| Drizzle Studio | 25555 | 5555 |

Release uses the corresponding `3xxxx` range:

| Service | Host port | Container port |
| --- | ---: | ---: |
| Vulseek | 33000 | 3000 |
| PostgreSQL | 35432 | 5432 |
| Redis | 36379 | 6379 |
| Traefik HTTP | 30080 | 80 |
| Traefik dashboard | 38080 | 8080 |

Release does not publish Node debug or Drizzle Studio ports. Each script
provides environment-variable overrides for its published ports while keeping
these values as defaults.

## Lifecycle and Safety

- `start`, `stop`, `restart`, `logs`, `ps`, and `status` operate only on the
  selected environment's services.
- `clean` removes only the selected environment's services and volumes and
  requires the existing explicit command; it never removes the other
  environment's resources.
- Existing databases, volumes, and scan directories are not automatically
  deleted or migrated.
- Startup checks fail with a clear message when a requested host port is
  occupied by an unrelated process or service.
- PostgreSQL and Redis health checks remain mandatory before the application is
  considered ready.

## Cloudflared and Task Containers

Cloudflared for the public release hostname joins only
`vulseek-release-network` and reaches `vulseek-release:3000`. It does not depend
on host port 33000.

Scan task containers continue to use the Docker socket and configured scan
context path. Development tasks write under `vulseek-data-dev`; release tasks
write under `vulseek-data-release`. Network separation does not provide a
security boundary against either Vulseek container because both retain access
to the host Docker socket.

## Verification

Verification starts both environments concurrently and confirms:

1. All dev and release services reach a healthy or running state.
2. The five dev and five release published ports do not conflict.
3. Each application resolves only its own PostgreSQL and Redis service names.
4. A marker written to one PostgreSQL database and Redis instance is absent
   from the other.
5. Scan context writes appear only in the selected environment directory.
6. Stopping either environment leaves all services in the other running.
7. Help text and deployment documentation no longer reference Docker Compose.
