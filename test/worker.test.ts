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
import { modelBaseUrl, parseTask, readText } from "../src/helpers";

const gatewayEnv = {
  AI_GATEWAY_ID: "hermes-test",
  MODEL: "openai/gpt-4.1-mini",
};
const modelUrl = `${modelBaseUrl}/chat/completions`;
const body = { repository: "https://github.com/octocat/Hello-World", prompt: "Write NOTES.md" };
const stream = (text: string) => new Response(text).body!;
const request = (data = body, signal?: AbortSignal) => new Request("https://example.com/run", {
  method: "POST", body: JSON.stringify(data), headers: { Authorization: "Bearer test-token" }, signal,
});

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("request boundary", () => {
  it.each(["API_TOKEN", "AI_GATEWAY_ID"])("rejects missing %s before allocating a container", async (missing) => {
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

describe("AI Gateway bridge", () => {
  const inputs = { model: gatewayEnv.MODEL, messages: [{ role: "user", content: "hello" }], stream: true };
  const modelRequest = (data = inputs) => new Request(modelUrl, {
    method: "POST", body: JSON.stringify(data),
    headers: { Authorization: "Bearer placeholder", "cf-aig-gateway-id": "wrong-gateway" },
  });
  const outbound = (run = vi.fn()) => new Outbound({} as never, { ...gatewayEnv, AI: { run } } as never);

  it("uses the binding and configured gateway, ignoring sandbox credentials", async () => {
    const run = vi.fn().mockResolvedValue(new Response("ok"));
    await outbound(run).fetch(modelRequest());
    expect(run).toHaveBeenCalledWith(gatewayEnv.MODEL, { messages: inputs.messages, stream: true }, {
      gateway: { id: "hermes-test", skipCache: true }, returnRawResponse: true,
    });
  });

  it("passes through streamed tool calls and upstream errors without rewriting them", async () => {
    const event = 'data: {"choices":[{"delta":{"tool_calls":[]}}]}\n\ndata: [DONE]\n\n';
    const upstream = new Response(stream(event), { headers: { "Content-Type": "text/event-stream" } });
    const run = vi.fn().mockResolvedValueOnce(upstream).mockResolvedValueOnce(new Response("No credits", { status: 402 }));
    const response = await outbound(run).fetch(modelRequest());
    expect(response).toBe(upstream);
    expect(await response.text()).toBe(event);
    expect((await outbound(run).fetch(modelRequest())).status).toBe(402);
  });

  it.each(["openai/gpt-4.1-mini", "openai/gpt-5-mini"])("handles Hermes's default reasoning option for %s", async (model) => {
    const run = vi.fn().mockResolvedValue(new Response("ok"));
    const bridge = new Outbound({} as never, { ...gatewayEnv, MODEL: model, AI: { run } } as never);
    await bridge.fetch(new Request(modelUrl, {
      method: "POST", body: JSON.stringify({ ...inputs, model, reasoning_effort: "medium" }),
    }));
    expect(run.mock.calls[0][1].reasoning_effort).toBe(model === "openai/gpt-4.1-mini" ? undefined : "medium");
  });

  it("rejects another model, malformed JSON, and oversized requests before inference", async () => {
    const run = vi.fn();
    expect((await outbound(run).fetch(modelRequest({ ...inputs, model: "another-model" }))).status).toBe(400);
    for (const body of ["invalid-json", " ".repeat(4 * 1024 * 1024 + 1)]) {
      expect((await outbound(run).fetch(new Request(modelUrl, { method: "POST", body }))).status).toBe(400);
    }
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    modelUrl.replace("https:", "http:"),
    modelUrl.replace("model.internal", "model.internal.evil.com"),
    modelUrl.replace("/chat/completions", "/models"),
    modelUrl.replace("model.internal", "model.internal:444"),
    `${modelUrl}?gateway=other`,
    "https://openrouter.ai/api/v1/chat/completions",
    "https://example.com",
  ])("blocks %s", async (url) => {
    const run = vi.fn();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect((await outbound(run).fetch(new Request(url, { method: "POST" }))).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
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
    expect(processEnv.CUSTOM_BASE_URL).toBe(modelBaseUrl);
    expect(processEnv.OPENAI_BASE_URL).toBe(processEnv.CUSTOM_BASE_URL);
    expect(processEnv.OPENAI_API_KEY).toBe("provided-by-worker");
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
