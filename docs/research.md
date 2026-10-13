# Research and design record

Research date: 2026-10-13. Sources were read from live documentation and the Hermes source tree, including its tagged release. This record separates implementation decisions from platform guarantees.

## Findings that determine the design

| Finding | Evidence | Consequence |
| --- | --- | --- |
| Current Sandbox docs use a Durable Object's native Container API. | [Sandbox quickstart](https://developers.cloudflare.com/sandbox/get-started/), [Container API](https://developers.cloudflare.com/containers/api/durable-object-container/), [SDK 1.0 changes](https://developers.cloudflare.com/sandbox/sdk/migrate/changes-in-1-0/) | Use `container.start()` and argv-based `container.exec()`. Installed local skill notes describing `getSandbox()` were stale. |
| `@cloudflare/sandbox` 1.0.1 provides file/storage helpers and does not manage lifecycle. | [Package reference](https://developers.cloudflare.com/sandbox/reference/); npm `latest` was `1.0.1`. | An exec-only example needs neither that package nor `sandbox-shim`. |
| `exec()` inherits only PATH; process output has no built-in memory bound; killing its parent does not kill descendants. | [Container process API](https://developers.cloudflare.com/containers/api/durable-object-container/#exec) | Pass the runtime environment explicitly, drain both output streams with limits, and destroy the container on completion/deadline/disconnect. |
| The latest tagged Hermes release is v2026.9.24 / v0.21.5; it accepts Python 3.11–3.13. | [Release](https://github.com/nousresearch/hermes-agent/releases/tag/v2026.9.24), [pinned pyproject.toml](https://github.com/nousresearch/hermes-agent/blob/f97608f178d1ffeca59860195ab7da295f7c8e5f/pyproject.toml) | Pin that commit and Python 3.13. Main was at `e06df9c2eae6901f4c88f464e0ae6e753c0428b8` and had materially different Python requirements. |
| Hermes already has a finite CLI with configurable toolsets and useful exit codes. | [Pinned parser](https://github.com/nousresearch/hermes-agent/blob/f97608f178d1ffeca59860195ab7da295f7c8e5f/hermes_cli/_parser.py), [single-query execution](https://github.com/nousresearch/hermes-agent/blob/f97608f178d1ffeca59860195ab7da295f7c8e5f/hermes_cli/cli_single_query.py), [CLI documentation](https://hermes-agent.nousresearch.com/docs/reference/cli-commands) | Use `hermes chat --quiet`, not a custom Python agent wrapper, HTTP server, or interactive setup wizard. |
| `terminal` and `file` are explicit Hermes toolsets. Its local backend executes on the host running Hermes. | [Pinned toolsets](https://github.com/nousresearch/hermes-agent/blob/f97608f178d1ffeca59860195ab7da295f7c8e5f/toolsets.py), [local environment](https://github.com/nousresearch/hermes-agent/blob/f97608f178d1ffeca59860195ab7da295f7c8e5f/tools/environments/local.py) | Run the entire agent in Cloudflare. No new Hermes terminal backend or Docker-in-Docker is required. |
| Cloudflare can intercept HTTPS and inject credentials outside the container. Python/Git need the interception CA. | [Authenticated API guide](https://developers.cloudflare.com/sandbox/network/call-an-authenticated-api/), [coding-agent runner](https://developers.cloudflare.com/sandbox/get-started/build-a-coding-agent-runner/), [Hermes CA selection](https://github.com/nousresearch/hermes-agent/blob/f97608f178d1ffeca59860195ab7da295f7c8e5f/agent/ssl_verify.py) | Inject the Cloudflare token only on the configured account's exact HTTPS chat-completions endpoint; set the gateway ID in the Worker. Pass `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, and `GIT_SSL_CAINFO` to processes. |
| AI Gateway's current REST API accepts Chat Completions at `/accounts/{account_id}/ai/v1/chat/completions`; it requires Workers AI > Read and supports a `cf-aig-gateway-id` header. | [REST API](https://developers.cloudflare.com/ai-gateway/usage/rest-api/), [Unified Billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/) | Use a Cloudflare API token and Gateway credits; keep credentials and gateway selection in the Worker. No separate provider key is required. |
| Hermes's custom provider accepts `CUSTOM_BASE_URL`; a generic `OPENAI_API_KEY` is host-gated and needs the matching `OPENAI_BASE_URL`. Its built-in `ai-gateway` provider means Vercel. | [Pinned custom resolver](https://github.com/nousresearch/hermes-agent/blob/f97608f178d1ffeca59860195ab7da295f7c8e5f/hermes_cli/runtime_provider_backends.py), [key selection](https://github.com/nousresearch/hermes-agent/blob/f97608f178d1ffeca59860195ab7da295f7c8e5f/hermes_cli/runtime_provider.py), [provider constants](https://github.com/nousresearch/hermes-agent/blob/f97608f178d1ffeca59860195ab7da295f7c8e5f/hermes_constants.py) | Select `--provider custom`, set both URL variables to Cloudflare, and supply only a placeholder key in the container. |
| Cloudflare's GPT-4.1 mini catalog entry supports Chat Completions and function tools. | [Model and schemas](https://developers.cloudflare.com/ai/models/openai/gpt-4.1-mini/) | Default to `openai/gpt-4.1-mini`; keep the model configurable. A catalog model with only Messages or Responses support is not a drop-in replacement. |
| The existing coding-agents landing page is navigation, with separate pages per agent. | [Live landing page](https://developers.cloudflare.com/sandbox/coding-agents/), [source](https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/sandbox/coding-agents/index.mdx), [Pi page](https://developers.cloudflare.com/sandbox/coding-agents/pi/) | Add `/sandbox/coding-agents/hermes/` and a landing-page card. Keep the existing overview. |

## Alternatives considered

**Entire Hermes process inside a sandbox — selected.** This uses unmodified upstream behavior and makes `local` shell/file tools useful immediately. The main runtime code is a small Worker plus a Dockerfile. Native Containers and current Sandboxes are layers of this same design, not separate deployments.

**Hermes outside Cloudflare, remote shell inside Cloudflare.** This would demonstrate a new Hermes backend integration rather than running Hermes on Cloudflare. It needs additional transport, session, file, and credential plumbing, and leaves the agent loop elsewhere.

**Long-running Hermes gateway.** Suitable for Telegram/Discord and ongoing personal assistance, but adds gateway lifecycle, channel credentials, durable home storage, concurrency, and recovery. It obscures the coding-agent example.

**A background task API.** The official runner supports repository setup, starting work, polling status, and fetching a diff. That is the right next step for long runs. This repository deliberately uses a connected request with a hard deadline so readers can trace the whole example in one pass. Client retry starts a new task and may incur new charges.

**AI Gateway REST transport — selected.** Hermes already emits Chat Completions HTTP requests, including streaming tool calls. Forward those requests and responses unchanged through Cloudflare's current `/ai/v1/chat/completions` endpoint. The [AI binding](https://developers.cloudflare.com/ai-gateway/usage/worker-binding-methods/) is useful when authoring the model caller in a Worker; this example keeps the existing Python caller and HTTP transport. The legacy Gateway `/compat/chat/completions` route is [deprecated for new single-model integrations](https://developers.cloudflare.com/ai-gateway/usage/chat-completion/).

**Persistent memory.** Keeping `/workspace/repo` alone does not preserve Hermes's memory. A persistent variant must also save `HERMES_HOME` (sessions, memory, skills/configuration), restore it before running the agent, and assign separate state to each user. Live SQLite state should not simply be put on an object-store FUSE mount. Consult [snapshot persistence](https://developers.cloudflare.com/sandbox/files/save-and-restore-a-workspace/) and upstream storage behavior before adding this.

## Boundaries worth explaining

- The Cloudflare inference token stays in the Worker, but sandbox code is still allowed to make model calls with it. Credential isolation does not enforce a model-spend quota.
- Repository content is input to the model. The GitHub/model allowlist constrains destinations, not the information sent to those destinations.
- `--yolo` is intentional for this unattended container. Shell and file tools can control the entire disposable container. File permissions are not presented as a second isolation boundary.
- `--max-turns 12` bounds agent iterations, not tokens, dollars, or command duration. The Worker separately enforces the five-minute deadline.
- The captured base commit makes the returned diff include changes Hermes staged or committed, plus new non-ignored files. Ignored/generated files are not automatically exported.
- No Worker, Cloudflare resource, GitHub repository, or documentation page is published by the validation commands.

## Validation

Checked on 2026-10-13:

| Check | Result |
| --- | --- |
| `npm run check` | Passed: Wrangler 4.150.0 generated bindings/runtime types; TypeScript passed. |
| `npm test` | Passed: 26 tests for input/authentication, literal prompts, byte limits, exact account/endpoint routing, gateway header selection, stream/error passthrough, failure status, deadlines, and cleanup. Container calls are mocked in these tests. |
| Docker build, `linux/amd64` | Passed. The image installed the pinned release and its 63 locked Python packages. Local image size approximately 302 MB. |
| Actual Hermes CLI in the Linux image | Passed with the AI Gateway custom-provider settings against a local deterministic model stub: wrote `hello.py`, executed a Python assertion via the terminal tool, returned a final answer, preserved shell metacharacters in the prompt, and exited `1` on model authentication failure. The container smoke test has no external network access. |
| `wrangler deploy --dry-run` | Passed, including the Docker image build and Worker bundle (7.41 KiB before compression). Nothing deployed. |
| Actual `wrangler dev` / Container / GitHub / AI Gateway path | With a dummy account ID and token: unauthorized caller returned `401`; invalid repository returned `400`; valid input cloned GitHub, launched Hermes, reached Cloudflare's `401` / code `10000` authentication error, and returned `422`, `stage: hermes`, `exitCode: 1`. The task container was removed afterward. A successful paid inference request has not been run. |
| Local disconnect experiment | Before the AI Gateway change, a client timeout after one second did **not** promptly cancel the local task. It completed with the expected authentication failure about 12 seconds after starting, then removed its task container. The abort-handler unit test passes, but immediate disconnect propagation through Wrangler's local proxy is not established. Documentation qualifies this behavior. |
| Documentation | MDX parsed successfully; all six embedded source/configuration snippets matched the runnable files; the overview patch applied to the fetched upstream source. Full Cloudflare docs-site build not run here. |

A deterministic model stub verifies the real Hermes tool loop; it is not evidence of a successful paid model call or a deployed Cloudflare run. No real Cloudflare inference token was supplied, and no Cloudflare deployment was made. A live end-to-end run remains a publication prerequisite. The request-cancellation implementation follows the current [Container API documentation](https://developers.cloudflare.com/containers/api/durable-object-container/#process-lifetime); the local experiment above is deliberately recorded separately from that documented behavior.
