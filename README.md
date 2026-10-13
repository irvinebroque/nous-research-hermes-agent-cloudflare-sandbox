# Hermes on Cloudflare

Run [Nous Research's Hermes Agent](https://github.com/nousresearch/hermes-agent) in a Linux sandbox on [Cloudflare Containers](https://developers.cloudflare.com/containers/). Send a public GitHub repository and a prompt; receive Hermes's answer and a Git diff.

```mermaid
sequenceDiagram
    participant Client
    participant Worker
    participant Sandbox as Container / Hermes
    participant Model as AI Gateway
    Client->>Worker: POST /run (repository, prompt)
    Worker->>Worker: Check API_TOKEN
    Worker->>Sandbox: Start a fresh sandbox; clone repository
    Worker->>Sandbox: Run hermes chat
    Sandbox->>Worker: Model request with placeholder key
    Worker->>Model: AI binding with gateway ID
    Model-->>Sandbox: Reply / tool calls, through Worker
    Sandbox->>Sandbox: Read files, edit code, run commands
    Sandbox-->>Worker: Answer, exit code, diff
    Worker->>Sandbox: Destroy container
    Worker-->>Client: JSON result
```

The Python agent and its tools run in the container. The Worker handles authentication, lifecycle, and model access through its AI binding. Inference runs through [AI Gateway](https://developers.cloudflare.com/ai-gateway/) using Cloudflare credits. No separate model-provider key is needed.

## Run locally

You need Node.js 22 or newer, Docker running, and a Cloudflare account with [AI Gateway credits](https://developers.cloudflare.com/ai-gateway/features/unified-billing/). Configure inference first:

Keep `AI_GATEWAY_ID` as `default` (created on the first authenticated request), or set it to an [existing gateway](https://developers.cloudflare.com/ai-gateway/get-started/) in your account. The [AI binding](https://developers.cloudflare.com/ai-gateway/usage/worker-binding-methods/) authenticates model requests; no Cloudflare inference token or provider key needs to be stored.

From this repository's root:

```sh
npm ci
npx wrangler login
cp .dev.vars.example .dev.vars
openssl rand -hex 32
```

Edit `.dev.vars`: use the generated random value for `API_TOKEN`, which protects this example's HTTP endpoint. Local development uses real Gateway credits. `.dev.vars` is ignored by Git and excluded from the Docker build context.

```sh
npm run dev
```

The first run builds the image. In another terminal, set `API_TOKEN` to the same value you saved in `.dev.vars`, then run:

```sh
export WORKER_URL=http://localhost:8787
# Set API_TOKEN in this shell without committing it to a file.
curl --fail-with-body --max-time 330 "$WORKER_URL/run" \
  -H "Authorization: Bearer $API_TOKEN" \
  --json '{
    "repository": "https://github.com/octocat/Hello-World",
    "prompt": "Read README. Create NOTES.md with one sentence explaining this repository. Use the terminal to check that NOTES.md exists."
  }' > result.json
```

If `API_TOKEN` is unset or differs from `.dev.vars`, the endpoint returns `401`. The request stays open while the agent works. On success, `result.json` contains:

```json
{
  "stage": "hermes",
  "exitCode": 0,
  "stdout": "…Hermes's final answer…",
  "stderr": "…diagnostics and session ID…",
  "diff": "diff --git a/NOTES.md b/NOTES.md\n…"
}
```

This is the response shape, not a recorded live model response. The wording and diff depend on the model. With `jq` installed, use `jq -r .diff result.json` to read the patch.

## Deploy

You need a Cloudflare account with Containers enabled and a Workers Paid plan. Docker must be running to build the deployment image. Consult the current [Containers prerequisites](https://developers.cloudflare.com/containers/get-started/) and [pricing](https://developers.cloudflare.com/containers/pricing/).

```sh
npx wrangler login
npx wrangler secret put API_TOKEN
npm run deploy
```

Use a random token for `API_TOKEN`. Wrangler may ask to create the Worker when adding its first secret. Local `.dev.vars` values are not uploaded automatically. Set `WORKER_URL` to the `workers.dev` URL printed by Wrangler and send the same request. Image rollout can take a few minutes after a first deployment.

The default model is [`openai/gpt-4.1-mini`](https://developers.cloudflare.com/ai/models/openai/gpt-4.1-mini/). To change `MODEL` in `wrangler.jsonc`, choose a [Cloudflare catalog model](https://developers.cloudflare.com/ai/models/) that supports **Chat Completions and function tools**. Models that accept only Anthropic Messages or Responses need a different Hermes API mode.

## Read the implementation

| File | Responsibility |
| --- | --- |
| [`Dockerfile`](Dockerfile) | Install a pinned Hermes release and its locked Python dependencies. |
| [`src/index.ts`](src/index.ts) | Authenticate, validate the request, allocate a fresh sandbox. |
| [`src/sandbox.ts`](src/sandbox.ts) | Clone, run Hermes, read the diff, and destroy the container. |
| [`src/outbound.ts`](src/outbound.ts) | Allow GitHub/model requests; call the configured model through the AI binding and AI Gateway. |
| [`src/helpers.ts`](src/helpers.ts) | Compare tokens, validate input, and bound output buffering. |
| [`wrangler.jsonc`](wrangler.jsonc) | Declare the image, Durable Object binding, AI binding, gateway, model, and API token. |

This follows the current [Sandboxes architecture](https://developers.cloudflare.com/sandbox/): a Durable Object controls a Linux container through `this.ctx.container`. Process execution is built into the [Container API](https://developers.cloudflare.com/containers/api/durable-object-container/). The `@cloudflare/sandbox` 1.x package supplies optional file and storage helpers; this example doesn't need them. The old `getSandbox()` / `Sandbox` class examples are for SDK 0.x.

Hermes sends Chat Completions requests to `https://model.internal/v1`, a hostname handled entirely by the container's outbound interceptor. The Worker validates the model, calls `env.AI.run()` with `gateway.id`, and returns the raw response so streaming tool calls reach Hermes unchanged. The Worker limits model request bodies to 4 MiB. For GPT-4.1 mini, the bridge removes Hermes's default `reasoning_effort` option because that model rejects it. Other models retain their reasoning settings.

`CUSTOM_BASE_URL` and `OPENAI_BASE_URL` both point to that internal URL. `OPENAI_API_KEY` is only a placeholder required by Hermes's compatible client; no OpenAI credential is used. The container never receives a Cloudflare credential.

The important Hermes invocation is:

```sh
hermes chat --quiet --provider custom --model openai/gpt-4.1-mini \
  --toolsets terminal,file --max-turns 12 --yolo --query="Your task"
```

`--quiet` runs one query and exits. `terminal,file` enables shell and file tools. `TERMINAL_ENV=local` means the shell runs **inside the Cloudflare container**. `--yolo` permits unattended commands inside that disposable environment. The implementation passes an argument array, so the caller's prompt is never interpolated into a shell command.

The image pins Hermes v0.21.5 (`v2026.9.24`, commit `f97608f178d1ffeca59860195ab7da295f7c8e5f`) and Python 3.13. It uses the upstream `uv.lock`; it does not install the messaging/browser extras. Runtime dependency auto-installation is disabled with `HERMES_DISABLE_LAZY_INSTALLS=1`. Base image tags and Debian package updates can still change rebuilt images.

## Scope and limits

- **One short task per request.** The request must stay connected. Five minutes includes startup, cloning, and inference. There is no job queue, reconnect, or retry protocol. Use the [background coding-agent runner](https://developers.cloudflare.com/sandbox/get-started/build-a-coding-agent-runner/) for longer tasks.
- **Fresh state each time.** Files, sessions, memory, and learned skills disappear when the container is destroyed. This demonstrates Hermes's coding tools, not its persistent personal-assistant experience. The returned diff is the artifact to keep.
- **Public GitHub repositories.** The default branch is cloned at depth one. Submodules, Git LFS, private repositories, and arbitrary Git hosts are outside this example.
- **Restricted network.** The container has no direct Internet access. The Worker allows HTTPS to `github.com` and POSTs to the internal model endpoint backed by AI Gateway. Package registries and web browsing are blocked. Install task dependencies in the image. Allowed model/GitHub traffic can carry repository data out of the sandbox.
- **Bounded output.** Request bodies are limited to 16 KiB, prompts to 8,000 characters, and each command's stdout/stderr to 1 MiB. Exceeding a limit fails the request; output is not silently truncated.
- **Trusted caller demo.** Anyone holding `API_TOKEN` can start containers and spend the configured model credit. Multiuser authorization and per-user quotas are not implemented.

HTTP `200` means Hermes exited successfully. `422` includes a nonzero clone or Hermes exit code and any available diff; inspect both `stdout` and `stderr` for errors. `400` means invalid input, `401` means missing/wrong authentication, `503` means a missing API token or gateway ID, and `502` means a sandbox/timeout/output failure. A successful exit does not prove the generated code is correct; inspect the diff and run its tests.

Disconnect cleanup runs when the runtime delivers the request's abort signal. In local Wrangler testing, closing the client did not promptly deliver that signal: the task finished and then cleaned up. The separate five-minute deadline and inactivity timeout bound the container lifetime; closing the client is not a verified immediate cancellation mechanism.

## Verify

```sh
npm run check
npm test
npx wrangler deploy --dry-run
docker build --platform linux/amd64 -t hermes-cloudflare-sandbox:test .
docker run --rm --platform linux/amd64 --network none \
  -v "$PWD/test/hermes-smoke.py:/test/hermes-smoke.py:ro" \
  hermes-cloudflare-sandbox:test python3 /test/hermes-smoke.py
```

The smoke test runs the real Hermes CLI against a deterministic local model stub. It checks file writing, terminal execution, literal prompt handling, and authentication-failure exit codes without a paid model call. Unit tests cover HTTP validation, endpoint/model restrictions, Worker-selected Gateway options, and container cleanup. See [`docs/research.md`](docs/research.md) for sources, design decisions, and validation evidence.

To test a deployed Worker with real model calls (this uses Gateway credits and Containers):

```sh
export WORKER_URL=https://hermes-sandbox.YOUR_SUBDOMAIN.workers.dev
# Set API_TOKEN to the deployed endpoint's token.
python3 test/production-smoke.py
```

This checks authentication and invalid input, asks Hermes to create and test Python code, then uses a second fresh container to check state isolation, absent credentials, and blocked package-registry access. Results are saved in `.wrangler/production-smoke.json`. Both tasks passed against the deployed Worker on 2026-10-13; see the [production verification record](docs/production.md) for the deployment and evidence.

The Cloudflare docs draft is [`docs/hermes.mdx`](docs/hermes.mdx), intended for `/sandbox/coding-agents/hermes/`. Publication instructions are in [`docs/README.md`](docs/README.md).
