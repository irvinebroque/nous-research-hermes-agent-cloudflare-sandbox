# Production verification

Verified on 2026-10-13 against the deployed service in the **Roundtrip** Cloudflare account.

| Resource | Value |
| --- | --- |
| Endpoint | `POST https://hermes-sandbox.roundtrip.workers.dev/run` |
| Worker | `hermes-sandbox` |
| Worker version | `aaf0e4c9-cd09-45fe-aa1b-735614c8013b` |
| AI Gateway | `hermes-sandbox` |
| Model | `openai/gpt-4.1-mini`, through the AI binding and AI Gateway Unified Billing |
| Container application | `hermes-sandbox-hermessandbox` |
| Image digest | `sha256:55a1a0b05dad571fa2b27207313179e7d791d7991a1880d651159bb7024dd27f` |

The endpoint requires a bearer token. The generated token is in this checkout's ignored `.dev.vars` file and was uploaded as the Worker's `API_TOKEN` secret. No inference token or model-provider key is stored in the Worker or container. Wrangler's OAuth login is used for deployment, not production inference.

## Results

`test/production-smoke.py` exercised the actual deployed Worker, Linux containers, GitHub clone, Hermes CLI, shell/file tools, and live model calls:

| Check | Result |
| --- | --- |
| Unknown path, wrong method, missing bearer token, invalid repository | Expected `404`, `405`, `401`, and `400`. |
| Coding task | HTTP `200`, exit `0`, in **55.30 seconds**. Created `hello.py` and `test_hello.py`, ran both Python unit tests, and returned a patch containing both files. |
| Independent patch check | Applied the returned patch with `git apply` in a separate Docker container with networking disabled. Both tests passed again. |
| Second, isolated task | HTTP `200`, exit `0`, in **44.85 seconds**. Confirmed the first task's files were absent, neither `API_TOKEN` nor `AI_GATEWAY_API_TOKEN` was in the environment, and a request to PyPI returned `403`. Returned no file changes. |
| Gateway evidence | All **five** model calls for these two tasks returned HTTP `200` in the dedicated gateway's logs, with model `openai/gpt-4.1-mini`. Reported inference cost was **$0.0037068**, excluding Containers and Workers. This is one observed run, not a cost estimate. |
| Cleanup | The Containers API reported both task instances stopped with exit code `0` after their responses, then zero active or starting instances. Worker request logs contained no exceptions. |

The raw task responses are retained locally in ignored `.wrangler/production-smoke.json`. Gateway logs can also be inspected in the Cloudflare dashboard. Request identifiers for this run:

```text
bd78f33ac7cd1dca10143819654c06828d85f4ec04eaf66c60ea38394dbfee3e
0f5f75f2d2c76023185c2ef1ce2e079ec7d27fa3e795374c78d6ab281ac86a09
5e0fcb0ce80d63b56e14f411e364db056086e3786bc218ff9d1c19b63de2bd06
f15ea2b40f938456a9008fa40da76051a355a278eb09a6b295832ac9a830f453
98bd0756c3421d42644bb2e75d0c1bf3988559fd39694c229ca3237de0684dda
```

Hermes reports that its optional Tirith scanner is unavailable and uses pattern matching instead. The network allowlist blocks its release-asset download and optional provider-discovery/update requests. These do not prevent the coding tools or model calls from working. Container isolation and the Worker-enforced network policy are the boundaries used by this example.

## Reproduce on this account

This account's existing Containers registry is `registry.cloudchamber.cfdata.org`. It required a registry override; keep this account-specific setting out of the portable example configuration:

```sh
CLOUDFLARE_CONTAINER_REGISTRY=registry.cloudchamber.cfdata.org \
  npx wrangler deploy --var AI_GATEWAY_ID:hermes-sandbox
```

Use that command when redeploying this checkout to preserve the dedicated gateway. The generic configuration defaults to the automatically created `default` gateway for new users.

To rerun the production checks with this checkout's existing token:

```sh
set -a
source .dev.vars
set +a
export WORKER_URL=https://hermes-sandbox.roundtrip.workers.dev
python3 test/production-smoke.py
```

The checks create temporary containers and use paid inference. The Worker remains deployed; each task's container is destroyed when the task ends. No background monitor or scheduled test was created.
