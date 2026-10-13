import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => {
  class WorkerBase {
    constructor(public ctx: unknown, public env: unknown) {}
  }
  return { DurableObject: WorkerBase, WorkerEntrypoint: WorkerBase };
});

import worker from "../src/index";
import { Outbound } from "../src/outbound";
import { HermesSandbox } from "../src/sandbox";
import { aiGatewayBaseUrl, parseTask, readText } from "../src/helpers";

const gatewayEnv = {
  CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  AI_GATEWAY_ID: "hermes-test",
  AI_GATEWAY_API_TOKEN: "real-key",
};
const modelUrl = `${aiGatewayBaseUrl(gatewayEnv.CLOUDFLARE_ACCOUNT_ID)}/chat/completions`;
const body = { repository: "https://github.com/octocat/Hello-World", prompt: "Write NOTES.md" };
const stream = (text: string) => new Response(text).body!;
const request = (data = body, signal?: AbortSignal) => new Request("https://example.com/run", {
  method: "POST", body: JSON.stringify(data), headers: { Authorization: "Bearer test-token" }, signal,
});

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("request boundary", () => {
  it.each(["API_TOKEN", "AI_GATEWAY_API_TOKEN", "AI_GATEWAY_ID", "CLOUDFLARE_ACCOUNT_ID"])("rejects missing %s before allocating a container", async (missing) => {
    const allocate = vi.fn();
    const env = { API_TOKEN: "test-token", ...gatewayEnv, [missing]: "", SANDBOX: { newUniqueId: allocate } };
    expect((await worker.fetch(request(), env as never)).status).toBe(503);
    expect(allocate).not.toHaveBeenCalled();
  });

  it("does not allocate a container for unauthorized or invalid input", async () => {
    const allocate = vi.fn();
    const env = { API_TOKEN: "test-token", ...gatewayEnv, SANDBOX: { newUniqueId: allocate } };
    const unauthorized = request();
    unauthorized.headers.delete("Authorization");
    expect((await worker.fetch(unauthorized, env as never)).status).toBe(401);
    expect((await worker.fetch(request({ ...body, repository: "file:///etc" }), env as never)).status).toBe(400);
    expect(allocate).not.toHaveBeenCalled();
  });

  it.each(["https://github.com.evil.com/a/b", "https://user:pass@github.com/a/b", "https://github.com/a/b?x=1", "https://github.com/a/b;touch /tmp/x"])("rejects %s", (repository) => {
    expect(() => parseTask(JSON.stringify({ ...body, repository }))).toThrow();
  });

  it("preserves prompt metacharacters as data", () => {
    const prompt = '--help $(touch /tmp/no) `id` "hello"\nnext';
    expect(parseTask(JSON.stringify({ ...body, prompt })).prompt).toBe(prompt);
  });

  it("enforces actual streamed byte limits, including multibyte text", async () => {
    expect(await readText(stream("✓"), 3)).toBe("✓");
    await expect(readText(stream("✓"), 2)).rejects.toThrow("exceeds");
  });
});

describe("outbound credentials", () => {
  const outbound = () => new Outbound({} as never, gatewayEnv as never);

  it("replaces the placeholder only on the exact model endpoint", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fetch);
    await outbound().fetch(new Request(modelUrl, {
      method: "POST", headers: { Authorization: "Bearer placeholder", "cf-aig-gateway-id": "wrong-gateway", "cf-aig-byok-alias": "wrong-key" }, body: '{"messages":[]}',
    }));
    const sent = fetch.mock.calls[0][0] as Request;
    expect(sent.headers.get("Authorization")).toBe("Bearer real-key");
    expect(sent.url).toBe(modelUrl);
    expect(sent.headers.get("cf-aig-gateway-id")).toBe("hermes-test");
    expect(sent.headers.get("cf-aig-skip-cache")).toBe("true");
    expect(sent.headers.has("cf-aig-byok-alias")).toBe(false);
    expect(await sent.text()).toBe('{"messages":[]}');
    expect(sent.redirect).toBe("manual");
  });

  it("passes through streamed tool calls and upstream errors without rewriting them", async () => {
    const event = 'data: {"choices":[{"delta":{"tool_calls":[]}}]}\n\ndata: [DONE]\n\n';
    const upstream = new Response(stream(event), { headers: { "Content-Type": "text/event-stream" } });
    const fetch = vi.fn().mockResolvedValueOnce(upstream).mockResolvedValueOnce(new Response("Invalid token", { status: 401 }));
    vi.stubGlobal("fetch", fetch);
    const response = await outbound().fetch(new Request(modelUrl, { method: "POST" }));
    expect(response).toBe(upstream);
    expect(await response.text()).toBe(event);
    expect((await outbound().fetch(new Request(modelUrl, { method: "POST" }))).status).toBe(401);
  });

  it.each([
    modelUrl.replace("https:", "http:"),
    modelUrl.replace("api.cloudflare.com", "api.cloudflare.com.evil.com"),
    modelUrl.replace("/chat/completions", "/models"),
    modelUrl.replace(gatewayEnv.CLOUDFLARE_ACCOUNT_ID, "another-account"),
    modelUrl.replace("api.cloudflare.com", "api.cloudflare.com:444"),
    `${modelUrl}?gateway=other`,
    "https://openrouter.ai/api/v1/chat/completions",
    "https://example.com",
  ])("blocks %s", async (url) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect((await outbound().fetch(new Request(url, { method: "POST" }))).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });
});

function fixture(agentCode = 0) {
  const output = [
    { stdout: "", stderr: "", exitCode: 0 },
    { stdout: "abc123\n", stderr: "", exitCode: 0 },
    { stdout: "Done", stderr: "session_id: test", exitCode: agentCode },
    { stdout: "+New file\n", stderr: "", exitCode: 0 },
  ];
  const container = {
    images: { hermes: "test-image" }, start: vi.fn(), destroy: vi.fn().mockResolvedValue(undefined),
    setInactivityTimeout: vi.fn(), interceptAllOutboundHttp: vi.fn(), interceptOutboundHttps: vi.fn(),
    exec: vi.fn().mockImplementation(() => {
      const next = output.shift()!;
      return { stdout: stream(next.stdout), stderr: stream(next.stderr), exitCode: Promise.resolve(next.exitCode) };
    }),
  };
  const sandbox = new HermesSandbox({ container, exports: { Outbound: {} } } as never, { ...gatewayEnv, MODEL: "test-model" } as never);
  return { sandbox, container };
}

describe("task lifecycle", () => {
  it("runs literal argv, returns new files, and destroys the container", async () => {
    const { sandbox, container } = fixture();
    const prompt = "$(touch /tmp/no)";
    const response = await sandbox.fetch(request({ ...body, prompt }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ stage: "hermes", exitCode: 0, stdout: "Done", diff: "+New file\n" });
    expect(container.exec.mock.calls[2][0]).toContain("custom");
    const processEnv = container.exec.mock.calls[2][1].env;
    expect(processEnv.CUSTOM_BASE_URL).toBe(aiGatewayBaseUrl(gatewayEnv.CLOUDFLARE_ACCOUNT_ID));
    expect(processEnv.OPENAI_BASE_URL).toBe(processEnv.CUSTOM_BASE_URL);
    expect(processEnv.OPENAI_API_KEY).toBe("provided-by-worker");
    expect(JSON.stringify(container.exec.mock.calls)).not.toContain(gatewayEnv.AI_GATEWAY_API_TOKEN);
    expect(container.exec.mock.calls[2][0].at(-1)).toBe(`--query=${prompt}`);
    expect(container.exec.mock.calls[3][0].at(-1)).toBe("abc123");
    expect(container.start).toHaveBeenCalledWith(expect.objectContaining({ enableInternet: false }));
    expect(container.destroy).toHaveBeenCalledOnce();
  });

  it("does not report a failed Hermes run as successful", async () => {
    const { sandbox, container } = fixture(1);
    expect((await sandbox.fetch(request())).status).toBe(422);
    expect(container.destroy).toHaveBeenCalledOnce();
  });

  it("destroys the container if a command fails to start", async () => {
    const { sandbox, container } = fixture();
    container.exec.mockRejectedValue(new Error("cannot start"));
    expect((await sandbox.fetch(request())).status).toBe(502);
    expect(container.destroy).toHaveBeenCalledOnce();
  });

  it("destroys the container on deadline even if a child process hangs", async () => {
    vi.useFakeTimers();
    const { sandbox, container } = fixture();
    container.exec.mockReturnValue(new Promise(() => {}));
    const response = sandbox.fetch(request());
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect((await response).status).toBe(502);
    expect(container.destroy).toHaveBeenCalledOnce();
  });

  it("destroys the container when the client disconnects", async () => {
    const { sandbox, container } = fixture();
    container.exec.mockReturnValue(new Promise(() => {}));
    const controller = new AbortController();
    const pending = sandbox.fetch(request(body, controller.signal));
    await vi.waitFor(() => expect(container.exec).toHaveBeenCalled());
    controller.abort();
    expect((await pending).status).toBe(502);
    expect(container.destroy).toHaveBeenCalledOnce();
  });
});
