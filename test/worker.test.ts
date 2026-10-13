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
import { parseTask, readText } from "../src/helpers";

const body = { repository: "https://github.com/octocat/Hello-World", prompt: "Write NOTES.md" };
const stream = (text: string) => new Response(text).body!;
const request = (data = body, signal?: AbortSignal) => new Request("https://example.com/run", {
  method: "POST", body: JSON.stringify(data), headers: { Authorization: "Bearer test-token" }, signal,
});

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("request boundary", () => {
  it("does not allocate a container for unauthorized or invalid input", async () => {
    const allocate = vi.fn();
    const env = { API_TOKEN: "test-token", OPENROUTER_API_KEY: "key", SANDBOX: { newUniqueId: allocate } };
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
  const outbound = () => new Outbound({} as never, { OPENROUTER_API_KEY: "real-key" } as never);

  it("replaces the placeholder only on the exact model endpoint", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fetch);
    await outbound().fetch(new Request("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST", headers: { Authorization: "Bearer placeholder" }, body: "{}",
    }));
    const sent = fetch.mock.calls[0][0] as Request;
    expect(sent.headers.get("Authorization")).toBe("Bearer real-key");
    expect(sent.redirect).toBe("manual");
  });

  it.each(["http://openrouter.ai/api/v1/chat/completions", "https://openrouter.ai.evil.com/api/v1/chat/completions", "https://openrouter.ai/api/v1/keys", "https://example.com", "https://openrouter.ai:444/api/v1/chat/completions"])("blocks %s", async (url) => {
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
  const sandbox = new HermesSandbox({ container, exports: { Outbound: {} } } as never, { MODEL: "test-model" } as never);
  return { sandbox, container };
}

describe("task lifecycle", () => {
  it("runs literal argv, returns new files, and destroys the container", async () => {
    const { sandbox, container } = fixture();
    const prompt = "$(touch /tmp/no)";
    const response = await sandbox.fetch(request({ ...body, prompt }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ stage: "hermes", exitCode: 0, stdout: "Done", diff: "+New file\n" });
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
