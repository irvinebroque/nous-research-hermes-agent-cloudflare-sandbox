# Tailscale on deployed Cloudflare Containers

This standalone experiment tests kernel-mode Tailscale, custom split DNS, and
ordinary PostgreSQL clients. It does not give the public Hermes dashboard access
to a tailnet. Deploy it separately from the dashboard.

## Production evidence

On October 13, 2026 (October 14 UTC), both `durable_object` and `default`
scheduling policies passed these checks on Cloudflare infrastructure:

| Check | `durable_object` | `default` |
| --- | --- | --- |
| `/dev/net/tun` already exists | Pass | Pass |
| `TUNSETIFF`, interface up, address assignment | Pass | Pass |
| Route installation and `iptables` access | Pass | Pass |
| `/etc/resolv.conf` writable | Pass | Pass |
| Tailscale control-plane HTTPS reachable | Pass | Pass |
| Kernel `tailscaled` creates `tailscale0` | Pass | Pass |
| Authenticated tailnet, split DNS, TLS Postgres query | Pass (2 runs) | Pass (2 runs) |
| Repeat after container replacement | Pass | Pass |

The tested kernel was `6.18.54-cloudflare-microvm-2026.9.16`, with Tailscale
`1.104.1`. See the sanitized machine-readable results in [evidence](./evidence/).
These results establish runtime capability, not a platform guarantee or proof
that an arbitrary private database is reachable. The unauthenticated daemon
correctly reaches `NeedsLogin` in the credential-free probe. The authenticated
acceptance runs reach `Running`, resolve `replica.cf-tailscale.test` through the
normal system resolver, route to it over `tailscale0`, and return `1` with an
active TLS session using `sslmode=verify-full`. Both policies have distinct boot
IDs and hashed Tailscale node IDs across their two runs. The final four runs
needed zero capacity retries. After verification, the fixture was stopped, its
restricted DNS entry and temporary credential files were removed, the auth key
was revoked, and both test Workers rejected the deleted operator token (401).

The health server uses `socketserver.TCPServer` because the deployed
`durable_object` runtime can give a container a 64-character hostname. Python's
`HTTPServer` calls `getfqdn()` while binding and rejects that hostname as an
overlong DNS label. This was reproduced in production and checked locally with
a 64-character hostname. Postgres puts its Unix socket in its data directory,
because `/var/run/postgresql` is not present in this deployed image.

The fixture also passes an offline local smoke check: its DNS server resolves the
test hostname, Postgres returns `1` over verified TLS, and the same client rejects
a deliberately incorrect TLS hostname. That check stubs tailnet enrollment and
does not count as an authenticated Cloudflare/Tailscale result.

Tailscale's log line `NewUserspaceEngine(tun "tailscale0")` describes its Go
WireGuard engine. The real `tailscale0` TUN interface distinguishes this from
`--tun=userspace-networking` and its application-level proxies.

## Run it

Use Node.js 22+, Docker, and a Cloudflare account with Containers enabled. From
the repository root:

```sh
npm ci
npx wrangler login
npx wrangler deploy --config experiments/tailscale/wrangler.jsonc
npx wrangler deploy --config experiments/tailscale/wrangler.default.jsonc
```

`GET /probe` returns a cached, fixed diagnostic. It accepts no commands, keys, or
destination parameters. Test routes are disabled until you set an operator
token, using the same random token for the two test Workers:

```sh
npx wrangler secret put TEST_TOKEN --config experiments/tailscale/wrangler.jsonc
npx wrangler secret put TEST_TOKEN --config experiments/tailscale/wrangler.default.jsonc
```

Keep a copy in a mode-0600 file **outside this repository**, for example
`/tmp/tailscale-test/operator-token`. Keep all test configuration there too.
Never put real keys in JSONC, command arguments, Docker build arguments, Git, or
screenshots. The Worker passes configuration to the process through stdin;
responses and logs omit credentials. Fixture startup failures include sanitized
Postgres diagnostics; client failures report only their stage and error type.

Create a short-lived, reusable, ephemeral Tailscale auth key for the test tailnet.
For an existing private database, prepare a mode-0600 JSON file with these fields:

```json
{
  "TS_AUTHKEY": "<auth key>",
  "PGHOST": "<private DNS hostname>",
  "PGPORT": "5432",
  "PGDATABASE": "<database>",
  "PGUSER": "<read-only user>",
  "PGPASSWORD": "<password>",
  "PGSSLROOTCERT_PEM": "<trusted CA PEM, if not publicly trusted>"
}
```

Configure the tailnet's restricted nameserver for the database's DNS suffix.
Ensure tailnet grants allow DNS and database access. If the destination is behind
a subnet router, approve its route and allow the destination in your tailnet
policy. The client uses `--accept-routes=true` and `--accept-dns=true`.

Run the acceptance test twice, replacing the URL with the deployed Worker:

```sh
python3 experiments/tailscale/run-test.py \
  --url https://<worker>.<subdomain>.workers.dev \
  --token-file /tmp/tailscale-test/operator-token \
  --config-file /tmp/tailscale-test/database.json \
  --repeat 2
```

Each run starts a fresh container, joins the tailnet with kernel networking,
resolves the hostname with the normal system resolver, verifies the route uses
`tailscale0`, and runs ordinary `psql` with `sslmode=verify-full`. It executes
`SELECT 1` and checks the session's TLS flag. No SOCKS proxy, `/etc/hosts` entry,
`PGHOSTADDR`, or TLS downgrade is involved. Distinct boot IDs and Tailscale node
IDs prove container replacement and rejoining. Each client logs out and its
container is destroyed, including after failure.

## Disposable database fixture

If no database exists, `POST /fixture` on the `durable_object` Worker starts an
ephemeral Postgres server and DNS server listening only on its tailnet address.
Give it a JSON file containing `TS_AUTHKEY` and a random `PGPASSWORD`:

```sh
python3 experiments/tailscale/run-test.py \
  --url https://<worker>.<subdomain>.workers.dev \
  --token-file /tmp/tailscale-test/operator-token \
  --config-file /tmp/tailscale-test/fixture.json --operation fixture
```

The result supplies the fixture's Tailscale IP, database settings, and public CA
certificate. Set a restricted nameserver for **`cf-tailscale.test`** to that IP
in the Tailscale DNS console. Merge the returned database settings with the key
and password in your private client configuration file. Then run both scheduling
policies against `replica.cf-tailscale.test` with `--repeat 2`.

This checks custom split DNS and encrypted Postgres to a peer in the tailnet.
It does not establish a route to a separate VPC or validate a real replica's
firewall, credentials, or certificate. The fixture is disposable, has no real
data, and stops after 30 minutes without container activity.

After testing, remove the test-only restricted nameserver and revoke the test
auth key. Stop the fixture:

```sh
python3 experiments/tailscale/run-test.py \
  --url https://<worker>.<subdomain>.workers.dev \
  --token-file /tmp/tailscale-test/operator-token --operation cleanup
```

Delete temporary credential files and remove `TEST_TOKEN` from the two Workers
when finished. Ephemeral machines disappear after disconnecting.

When iterating on the image, use a new test Durable Object name after cleaning
up the previous fixture. In this deployment, an existing object continued
running its previous Worker version and image after a deployment; fresh object
names made the new code and image observable. The default-scheduling test
allows two instances. Immediate replacement can still return “no container
instance” during allocation. The Worker maps that specific error to HTTP 503;
the runner retries it every five seconds for up to two minutes and records the
retry count. Failed DNS or SQL checks are never retried by the runner.
The result includes the image reference when the native runtime exposes it.

## Why the egress configuration differs

The dashboard's `enableInternet: false` and HTTPS interception are appropriate
for its limited GitHub/model access. This experiment uses `enableInternet: true`
and no HTTP interception so Tailscale can reach its control plane and peers.
Moving this into a shared dashboard needs a deliberate identity-to-tailnet
authorization design; granting every admitted Gmail user the same private
network access would be inappropriate.

Tailscale userspace networking can proxy TCP, but ordinary libpq clients do not
honor `ALL_PROXY`. Its custom split-DNS behavior also cannot be inferred from a
successful MagicDNS lookup. This experiment tests the transparent kernel path.

Sources:

- [Cloudflare native Container API](https://developers.cloudflare.com/containers/api/durable-object-container/)
- [Cloudflare outbound networking](https://developers.cloudflare.com/containers/configuration/outbound-traffic/)
- [Tailscale Docker parameters](https://tailscale.com/docs/features/containers/docker/docker-params)
- [Tailscale userspace networking](https://tailscale.com/docs/concepts/userspace-networking)
- [Split-DNS userspace issue #9619](https://github.com/tailscale/tailscale/issues/9619)
- [Tailscale v1.104.1 dialer source](https://github.com/tailscale/tailscale/blob/v1.104.1/net/tsdial/tsdial.go#L417-L475)
