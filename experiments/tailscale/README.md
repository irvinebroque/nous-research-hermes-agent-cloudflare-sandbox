# Tailscale in a Cloudflare Container

One authenticated request starts a fresh container, joins your tailnet using
kernel networking, and runs `SELECT 1` against your Postgres database with
`sslmode=verify-full`. The hostname uses the normal system resolver; its route
must go through `tailscale0`. The container logs out and is destroyed afterward.

This is a standalone connection example. It does not grant the public Hermes
dashboard access to your tailnet.

## Deploy and run

From the repository root, with Node.js 22+, Docker, Python 3, and Containers enabled:

```sh
npm ci
npx wrangler login
npx wrangler deploy --config experiments/tailscale/wrangler.jsonc
npx wrangler secret put TEST_TOKEN --config experiments/tailscale/wrangler.jsonc
```

Use a randomly generated operator token. Keep a copy in a mode-0600 file outside
Git, such as `/tmp/tailscale-test/token`. Requests fail closed without this token.

Create a short-lived **ephemeral** Tailscale auth key, reusable if you want to run
the check more than once. In the Tailscale console, configure the restricted
nameserver for your database's DNS suffix and allow the client to reach DNS and
Postgres. If the database is behind a subnet router, approve that subnet route.

Create `/tmp/tailscale-test/database.json` with mode 0600:

```json
{
  "TS_AUTHKEY": "<Tailscale auth key>",
  "PGHOST": "<private database hostname>",
  "PGPORT": "5432",
  "PGDATABASE": "<database>",
  "PGUSER": "<read-only user>",
  "PGPASSWORD": "<password>",
  "PGSSLROOTCERT_PEM": "<trusted CA PEM; omit for a publicly trusted certificate>"
}
```

```sh
python3 experiments/tailscale/run-test.py \
  --url https://<worker>.<subdomain>.workers.dev \
  --token-file /tmp/tailscale-test/token \
  --config-file /tmp/tailscale-test/database.json
```

Success returns `passed: true`, `postgres_result: ["1", "t"]`, and
`sslmode: "verify-full"`. Failures report their stage without raw command output.
Run the command again to check a new container. Credentials travel over HTTPS
and into the process through stdin; never put them in Git or Docker build args.
After testing, revoke the auth key, delete the private files, and disable the
endpoint with `npx wrangler secret delete TEST_TOKEN --config experiments/tailscale/wrangler.jsonc`.

## How it works

- `Dockerfile` adds Tailscale and the Postgres client.
- `worker.ts` authenticates `/check`, starts a container with `enableInternet: true`, executes the check, and destroys the container in `finally`.
- `check.py` starts `tailscaled --tun=tailscale0`, enables tailnet DNS/routes, and runs ordinary `psql`. No SOCKS proxy or TLS downgrade is used.
- `run-test.py` sends your local configuration without exposing secrets in command arguments.

The example uses the `durable_object` scheduling policy. Unrestricted container
egress is needed for Tailscale; Hermes's HTTP interception configuration cannot
be copied unchanged. See the [Container API](https://developers.cloudflare.com/containers/api/durable-object-container/)
and [Tailscale kernel networking](https://tailscale.com/docs/features/containers/docker/docker-params).

On October 13, 2026, deployed checks passed twice under **both** scheduling
policies, including replacement, custom split DNS, and TLS Postgres. That test
used a disposable tailnet database, not an actual private replica or subnet
router. The [original investigation and evidence](https://github.com/irvinebroque/nous-research-hermes-agent-cloudflare-sandbox/tree/aff034f/experiments/tailscale)
remain in Git history; the fixture and diagnostics are omitted from this example.
