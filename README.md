# csc3131-visits

A small teaching app for the CSC3131 Week 03 practical. Every student runs the **same public image**
on Azure App Service (Linux, single container) and connects it to **their own** Azure Database for
PostgreSQL flexible server, configured only through environment variables (Portal, Terraform or Bicep).

Its main job is to make it obvious whether a student's setup is right and, if not, exactly what to fix:

- **`/`**: a visit counter (one row per page load), a **setup checklist** with a ✓ or ✗ for each
  setting and for "Database reachable and signed in", and a panel showing what the request looked
  like (container hostname, the address that connected, `X-Forwarded-For`, `X-Forwarded-Proto`, `Host`).
  Returns **200** when everything works and **503** when the database check fails. The page still renders.
- **`/api`**: the same information as JSON (no secrets), with the same 200/503 status.
- **`/health`**: always `200 ok` and never touches the database (a liveness check).

The app never crashes over a missing, misconfigured or unreachable database. It retries on every
request, so once a student fixes the server side (firewall, database created, server started), a
refresh is enough. Changing an environment variable restarts the app on App Service anyway.

## Configuration

| Variable      | Required | Notes |
|---------------|----------|-------|
| `PGHOST`      | yes | `psql-<name>.postgres.database.azure.com` (just the name: no `https://`, no port) |
| `PGDATABASE`  | yes | must already exist on the server |
| `PGUSER`      | yes | the server admin login |
| `PGPASSWORD`  | yes | never shown or logged |
| `PGPORT`      | no  | default `5432` |
| `PGSSL`       | no  | TLS with certificate verification is **on** by default. `PGSSL=disable` turns it off, for local development only |
| `WEBSITES_PORT` | on Azure | set to `3000` so App Service routes to the container |

`APP_VERSION` is baked into the image at build time and shown on the page.

### What the checklist tells students

The classifier lives in [`diagnose.js`](diagnose.js), with a unit test for every branch.

| Situation | Cause shown |
|-----------|-------------|
| Required variables missing | These settings are missing: … (no connection attempted) |
| `PGHOST` contains `https://`, a port or slashes | PGHOST should be just the server name … |
| `ENOTFOUND` / `EAI_AGAIN` | PGHOST doesn't resolve. Check the spelling … |
| `ECONNREFUSED` | Nothing is accepting connections at that address … |
| Connect timeout (5 s) / `ETIMEDOUT` | The connection timed out. The database firewall is probably blocking Azure … |
| `28000` no pg_hba.conf entry | The database refused this address. Check the firewall rules and that TLS is on |
| `28P01` | Wrong password for user … Check PGPASSWORD. |
| `3D000` | The database … doesn't exist on this server … |
| TLS on, server without TLS | This server doesn't use TLS. Locally, set PGSSL=disable … |
| Certificate errors | TLS certificate couldn't be verified … |
| Anything else | Unexpected database error: *raw message* |

The raw error message is always shown underneath in small grey text.

## Run locally

Requires Docker. `compose.yaml` is for local development only: it runs `postgres:16-alpine`
(the same major version as the Azure server) without TLS, so the app gets `PGSSL=disable`.

```sh
docker compose up --build
open http://localhost:3000        # refresh: the counter goes up
curl localhost:3000/api
curl localhost:3000/health
docker compose down               # add -v to delete the database volume too
```

To demonstrate a misconfiguration, run the image against the compose database with different
settings, for example a wrong password:

```sh
docker run --rm -p 3001:3000 --network csc3131-week3practical_default \
  -e PGHOST=db -e PGDATABASE=visits -e PGUSER=visits -e PGPASSWORD=wrong -e PGSSL=disable \
  csc3131-week3practical-web
```

(The network name is `<folder name>_default`. Check it with `docker network ls`.)

Note: stopping the `db` container locally shows "PGHOST doesn't resolve", because Docker's DNS drops
a stopped container's name. On Azure a stopped server still resolves, so students get the
"Nothing is accepting connections" or timeout message instead.

## Unit tests

Node.js 24 or later:

```sh
npm ci
npm test
```

## Publish the image to GitHub Container Registry

Students run the image on App Service, which is usually amd64. Build for both architectures so the
same tag also runs on Apple Silicon. Log in with a personal access token (classic) that has the
`write:packages` scope. The `<owner>` part of the image name must be **lower case**.

```sh
echo "$GHCR_TOKEN" | docker login ghcr.io -u <github-username> --password-stdin

docker buildx build --platform linux/amd64,linux/arm64 \
  --build-arg APP_VERSION=1 -t ghcr.io/<owner>/csc3131-visits:1 --push .

docker buildx build --platform linux/amd64,linux/arm64 \
  --build-arg APP_VERSION=2 -t ghcr.io/<owner>/csc3131-visits:2 --push .
```

Deploying `:1` and then `:2` demonstrates a release: the version badge on the page changes.

If buildx says the driver doesn't support multi-platform builds, create a builder once with
`docker buildx create --use`.

### Make the package public

New GHCR packages are private, and App Service would need registry credentials to pull them.
Make it public once:

1. GitHub → your profile (or the organisation) → **Packages** → `csc3131-visits`.
2. **Package settings** → **Danger Zone** → **Change visibility** → **Public**.

Then check that an anonymous pull works:

```sh
docker logout ghcr.io
docker pull ghcr.io/<owner>/csc3131-visits:1
docker pull ghcr.io/<owner>/csc3131-visits:2
```

### Or let GitHub Actions publish it

[`.github/workflows/publish.yml`](.github/workflows/publish.yml) builds both architectures and pushes
`ghcr.io/<owner>/csc3131-visits:<tag without the v>` with that version baked in, using the
workflow's `GITHUB_TOKEN`:

```sh
git tag v2
git push origin v2        # publishes ghcr.io/<owner>/csc3131-visits:2 with APP_VERSION=2
```

The image is labelled with the repository, so the package is linked to it. You still need to make
the package public once, as above.

## Notes for the module team

- The image is `node:24-alpine` plus express and pg. It runs as the non-root `node` user and has no
  dev dependencies or tests in it. It is about 63 MB compressed.
- Logs go to stdout and appear in App Service's **Log stream**. You get one line per request
  (`GET / 200 12ms`) plus a startup line listing which settings are present (names only, never values).
- Every request to `/` adds a row, including App Service's "Always On" pings, which hit `/`.
  Point the App Service health check at `/health`.
