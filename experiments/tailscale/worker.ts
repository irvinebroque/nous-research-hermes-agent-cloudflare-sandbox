import { DurableObject } from "cloudflare:workers";
import { timingSafeEqual } from "node:crypto";

interface TestEnv extends Env { TEST_TOKEN?: string }

export class NetworkProbe extends DurableObject<TestEnv> {
  async check(config: string): Promise<unknown> {
    const container = this.ctx.container!;
    try {
      container.start({ image: container.images.probe, enableInternet: true });
      await container.setInactivityTimeout(180_000);
      // exec waits for startup; this container does not need an HTTP server.
      const process = await container.exec(["python3", "/opt/check.py"], {
        stdin: new Response(config).body!, signal: AbortSignal.timeout(150_000),
      });
      const output = await process.output();
      // Command diagnostics can contain credentials. Only return the check's JSON.
      if (output.exitCode !== 0) throw new Error("Check failed");
      return JSON.parse(new TextDecoder().decode(output.stdout));
    } finally {
      await container.destroy();
    }
  }
}

export default {
  async fetch(request, env) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/check") {
      return new Response("Not found", { status: 404 });
    }
    const actual = Buffer.from(request.headers.get("Authorization") ?? "");
    const expected = Buffer.from(`Bearer ${env.TEST_TOKEN ?? ""}`);
    if (!env.TEST_TOKEN || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      return new Response("Unauthorized", { status: 401 });
    }
    // Read at most 32 KiB, including chunked requests.
    let config = "";
    const reader = request.body?.getReader();
    if (!reader) return new Response("Missing configuration", { status: 400 });
    const decoder = new TextDecoder();
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 32_768) {
        await reader.cancel();
        return new Response("Too large", { status: 413 });
      }
      config += decoder.decode(value, { stream: true });
    }
    config += decoder.decode();
    try { JSON.parse(config); } catch { return new Response("Invalid JSON", { status: 400 }); }
    const headers = { "Cache-Control": "no-store" };
    try {
      const result = await env.PROBE.getByName(crypto.randomUUID()).check(config);
      return Response.json(result, { headers });
    } catch {
      return Response.json({ passed: false, stage: "container_execution" }, { status: 500, headers });
    }
  },
} satisfies ExportedHandler<TestEnv>;
