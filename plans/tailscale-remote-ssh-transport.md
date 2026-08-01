# Tailscale Remote SSH Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow each configured Server to use either direct TCP or the host's Tailscale daemon for every Vulseek SSH operation, while preserving the existing `execAsyncRemote(serverId, command, onData?)` API.

**Architecture:** Add a `direct | tailscale` connection setting to Server. A shared SSH transport factory creates either a normal TCP-backed `ssh2.Client` or a `tailscale nc`-backed client using the host `tailscaled.sock`. Ordinary remote commands reuse a process-local SSH connection pool; interactive terminals and log streams use dedicated connections through the same transport factory.

**Tech Stack:** TypeScript, Node.js 20 streams/child processes, `ssh2`, Drizzle/PostgreSQL, React Hook Form/Zod, Docker Swarm, Tailscale CLI 1.96.4.

## Global Constraints

- Do not change the public signature or behavior of `execAsyncRemote`.
- Do not add scan job, task, artifact, ACP, or remote scan scheduling changes.
- Existing Server rows default to `direct` and require no manual migration action.
- A `tailscale` Server never falls back to direct TCP after a Tailscale failure.
- Keep SSH key authentication; Tailscale supplies transport only.
- Never mount `tailscaled.sock` into managed, scan, or Agent containers.

---

### Task 1: Persist the Server connection type

**Files:**
- Modify: `packages/server/src/db/schema/server.ts`
- Create: `apps/vulseek/drizzle/0214_server_connection_type.sql`
- Modify: `apps/vulseek/drizzle/meta/_journal.json`
- Modify: `apps/vulseek/components/dashboard/settings/servers/handle-servers.tsx`
- Modify: `apps/vulseek/components/dashboard/settings/servers/show-servers.tsx`

**Interfaces:**
- Add `serverConnectionTypeEnum = pgEnum("serverConnectionType", ["direct", "tailscale"])`.
- Add `server.connectionType`, non-null with default `direct`.
- Include `connectionType` in `apiCreateServer` and `apiUpdateServer`.

- [ ] Add schema tests or type assertions proving create/update inputs accept only `direct` and `tailscale`.
- [ ] Add the enum and column migration with `direct` as the database default.
- [ ] Add a Connection Type select to create/edit Server forms; keep address, port, username, and SSH Key unchanged.
- [ ] Show a Direct/Tailscale badge in the Server list.
- [ ] Run the relevant schema/UI tests and `pnpm --filter @vulseek/server typecheck`.
- [ ] Commit as `feat(server): add remote connection type`.

### Task 2: Add the shared SSH transport factory

**Files:**
- Create: `packages/server/src/utils/servers/remote-ssh-transport.ts`
- Create: `packages/server/src/utils/servers/remote-ssh-transport.test.ts`

**Interfaces:**

```ts
export type RemoteSshHandle = {
	client: Client;
	close: () => Promise<void>;
};

export const connectRemoteSsh = async (
	server: ServerWithSshKey,
): Promise<RemoteSshHandle>;
```

- [ ] Write failing tests for direct configuration, Tailscale spawn arguments, missing socket, proxy early exit, SSH authentication failure, and cleanup.
- [ ] For `direct`, connect `ssh2.Client` with the existing host, port, username, private key, and timeout behavior.
- [ ] For `tailscale`, verify `VULSEEK_TAILSCALE_SOCKET` (default `/var/run/tailscale/tailscaled.sock`) is a Unix socket, then call `spawn("tailscale", ["--socket=...", "nc", host, String(port)])` without a shell.
- [ ] Wrap child stdout/stdin as a Node `Duplex` and pass it as `ssh2`'s `sock`; retain stderr for diagnostics without treating normal output as SSH data.
- [ ] Make `close()` idempotently end the SSH client, destroy the stream, and terminate/reap `tailscale nc`.
- [ ] Reject if the proxy exits before SSH becomes ready; never retry through direct TCP.
- [ ] Verify tests pass and commit as `feat(server): add tailscale ssh transport`.

### Task 3: Add the process-local SSH command pool

**Files:**
- Create: `packages/server/src/utils/servers/remote-ssh-pool.ts`
- Create: `packages/server/src/utils/servers/remote-ssh-pool.test.ts`
- Modify: `packages/server/src/utils/process/execAsync.ts`

**Interfaces:**

```ts
export const acquireRemoteSsh = async (
	serverId: string,
): Promise<{ client: Client; release: () => void }>;

export const invalidateRemoteSsh = async (serverId: string): Promise<void>;
export const closeAllRemoteSshConnections = async (): Promise<void>;
```

- [ ] Write failing tests proving concurrent first calls share one connection, commands open separate channels, idle connections close, config changes invalidate the entry, and transport errors evict it.
- [ ] Store ready connections in a module-level `Map<serverId, entry>` and in-flight creation in a second single-flight map.
- [ ] Compute a non-logged SHA-256 fingerprint from connection type, address, port, username, SSH Key ID, and private-key content; replace entries whose fingerprint changes.
- [ ] Increment active channels on acquire, cancel the idle timer, and start a 60-second timer after the last release.
- [ ] On SSH/proxy `error` or `close`, evict and close the entry. Do not replay commands whose channel may already have been accepted.
- [ ] Refactor `execAsyncRemote` to acquire the pooled client, call `client.exec`, preserve stdout/stderr/onData behavior, and release exactly once on every completion path.
- [ ] Register backend shutdown cleanup to call `closeAllRemoteSshConnections`.
- [ ] Verify pool and `execAsyncRemote` tests pass and commit as `refactor(server): pool remote ssh commands`.

### Task 4: Route every direct SSH entry through the factory

**Files:**
- Modify: `packages/server/src/setup/server-validate.ts`, `server-setup.ts`, and `server-audit.ts`
- Modify: `packages/server/src/utils/builders/drop.ts`
- Modify: `apps/vulseek/server/wss/terminal.ts`, `listen-deployment.ts`, `docker-container-terminal.ts`, and `docker-container-logs.ts`

**Interfaces:**
- Short commands continue through pooled `execAsyncRemote`.
- Interactive shells, SFTP, deployment listeners, and container log streams call `connectRemoteSsh` directly and own a dedicated `RemoteSshHandle`.

- [ ] Add tests/mocks proving each feature requests the shared transport rather than constructing `ssh2.Client` directly.
- [ ] Replace direct `.connect({ host, ... })` blocks while preserving existing authorization, stream handling, and user-facing errors.
- [ ] Close dedicated handles on WebSocket close, stream close, setup completion, SFTP completion, and every error path.
- [ ] Run `rg 'new Client\('` and confirm only the transport implementation or explicitly local-only code remains.
- [ ] Run relevant server and WebSocket tests and commit as `refactor(server): unify remote ssh connections`.

### Task 5: Mount the host Tailscale management socket

**Files:**
- Modify: `Dockerfile`
- Modify: `Dockerfile.dev`
- Modify: `dev.sh`
- Modify: `run.sh`

**Interfaces:**
- `VULSEEK_TAILSCALE_SOCKET_HOST_PATH`, default `/var/run/tailscale/tailscaled.sock`.
- `VULSEEK_TAILSCALE_SOCKET`, container path `/var/run/tailscale/tailscaled.sock`.

- [ ] Install the pinned Tailscale CLI 1.96.4 in development and release backend images and verify `tailscale version` during image build.
- [ ] At service start, detect whether the host socket exists. If present, add a read-only bind mount and set `VULSEEK_TAILSCALE_SOCKET`; if absent, start normally so Direct servers remain usable.
- [ ] Extend `status` output to show whether the socket is mounted and reachable.
- [ ] Do not mount the socket into PostgreSQL, Redis, Traefik, tools, checkout, scan, or Agent containers.
- [ ] Verify both scripts still start without Tailscale installed and commit as `feat(runtime): expose host tailscale socket`.

### Task 6: Validate behavior and document operations

**Files:**
- Modify: repository deployment/operations documentation near the existing remote Server setup instructions.

- [ ] Document prerequisites: host `tailscaled` online, backend socket mount, remote node reachable in the same tailnet, tailnet policy permitting TCP/22, remote OpenSSH and Docker installed, and an existing Vulseek SSH Key.
- [ ] Document that socket access is privileged and limited to the backend container.
- [ ] Test a Direct Server and confirm `execAsyncRemote(serverId, "docker info")` remains unchanged.
- [ ] Test a Tailscale IPv4 Server and a MagicDNS Server with `docker info`, setup/validate, terminal, and container logs.
- [ ] Test missing socket, daemon offline, ACL denial, unknown MagicDNS name, SSH rejection, and backend restart.
- [ ] Run `pnpm --filter @vulseek/server typecheck`, relevant Vitest suites, and `pnpm check` on touched files.
- [ ] Commit as `docs(server): document tailscale remote access`.

## Acceptance Criteria

- Existing Server records remain Direct after migration.
- Selecting Tailscale causes all SSH-based Server operations to use the mounted host daemon.
- `execAsyncRemote` callers remain unchanged and reuse one SSH connection per Server for sequential commands within 60 seconds.
- Interactive and streaming operations use the same transport but dedicated SSH connections.
- Tailscale failures never bypass the configured transport.
- Backend shutdown and idle timeout leave no orphan `tailscale nc` processes.
- No scan job/task behavior or schema is changed.
