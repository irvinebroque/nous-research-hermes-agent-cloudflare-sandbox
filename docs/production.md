# Production verification

Deployment date: 2026-10-13. Target: [Hermes dashboard](https://hermes-sandbox.roundtrip.workers.dev), in the Roundtrip Cloudflare account.

## Current dashboard deployment

- Worker: `hermes-sandbox`.
- Version: `cfe80c26-d063-4858-8051-8f5e50c939c3`.
- Container image digest: `sha256:12deefcc59d1044f72af5e72c1ff18fff1a207dfb05ade04ddef05ddeaac8111`.
- AI Gateway: `hermes-sandbox`; model `openai/gpt-4.1-mini` through the AI binding.
- Access: application `Hermes Sandbox Dashboard`, one-time PIN, Allow Everyone. Any verified email can sign in.
- Managed OAuth: enabled; dynamic client registration allows localhost and loopback callbacks.
- No inference API key or Cloudflare management token supplied to the container.

Verified against the public deployment:

- Browser requests redirect to Cloudflare Access sign-in.
- Unauthenticated JSON/API requests receive HTTP 401.
- `/.well-known/oauth-authorization-server` returns HTTP 200 and the configured authorization, token, registration and revocation endpoints, with S256 PKCE support.
- Access API readback confirms the intended policy and managed OAuth configuration.

Authenticated browser, WebSocket and live model checks for the new dashboard are still pending sign-in. The earlier CLI runner's successful inference tests below are not evidence that this new dashboard flow has passed those checks.

## Local dashboard validation

- TypeScript and 19 unit tests passed.
- The real Linux dashboard started with authentication enabled and prebuilt assets.
- The offline WebSocket smoke test passed: native Node TUI, streamed model responses, file creation and a Python assertion executed by the terminal tool.
- The unattended smoke test sets `HERMES_YOLO_MODE=1` only in its local test environment. The deployed dashboard retains Hermes's tool-approval prompts.

## Earlier CLI runner validation

Before switching the demo to the native dashboard, the same Container outbound bridge and AI Gateway integration passed these production tests:

- Real Hermes created `hello.py` and `test_hello.py`, ran two Python unit tests, and returned a Git diff (HTTP 200, exit 0; 55.30 seconds).
- The diff was independently applied and both tests rerun in a network-disabled Docker container.
- A second fresh-container task confirmed prior files and API secrets were absent, and a request to PyPI returned 403 (HTTP 200, exit 0; 44.85 seconds).
- Five Gateway calls returned HTTP 200; recorded model cost was $0.0037068, excluding Workers and Containers.
- Task containers stopped after completion.

This earlier `/run` interface has been replaced by the dashboard.

## Repeat the dashboard verification

1. Sign in at the deployed URL and open **Chat**.
2. Ask Hermes to write a small Python module and unittest in `/workspace`, then run the test.
3. Confirm the streamed answer, tool output and files in the dashboard; check successful calls in AI Gateway.
4. Refresh and confirm the same session remains while its container is running.
5. Sign in as a different identity and confirm the first user's files and sessions are absent.
6. Close connections and verify inactivity stops the container. Reopening after stop should create a fresh workspace.

Do not save Access cookies, bearer tokens, one-time codes or full request headers in this record. Local smoke tests use a fake model; they do not establish production networking or paid inference behavior.
