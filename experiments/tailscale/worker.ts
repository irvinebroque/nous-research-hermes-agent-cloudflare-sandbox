import { DurableObject } from "cloudflare:workers";
import { timingSafeEqual } from "node:crypto";

interface TestEnv extends Env { TEST_TOKEN?: string }

export class NetworkProbe extends DurableObject<TestEnv> {
  private pending?: Promise<unknown>;

  async probe() {
    const saved = await this.ctx.storage.get("result-v1");
    if (saved) return saved;
    this.pending ??= this.run().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async start(inactivityMs: number) {
    const container = this.ctx.container!;
    console.log("test: starting container");
    if (this.env.SCHEDULING_POLICY === "default") {
      container.start({ enableInternet: true });
    } else {
      container.start({ image: container.images.probe, instance: "lite", enableInternet: true });
    }
    await container.setInactivityTimeout(inactivityMs);
    console.log("test: waiting for HTTP readiness");
    const deadline = Date.now() + 90_000;
    let finished = false;
    const ready = async () => {
      while (!finished) {
        try {
          const response = await container.getTcpPort(9080).fetch("http://container/health", { signal: AbortSignal.timeout(3000) });
          await response.body?.cancel();
          if (response.ok) return;
        } catch { /* Default scheduling may need time to allocate an instance. */ }
        if (Date.now() > deadline) throw new Error("Probe container did not become ready");
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    };
    try {
      await Promise.race([ready(), container.monitor().then(() => { throw new Error("Container exited during startup"); })]);
    } finally {
      finished = true;
    }
    console.log("test: HTTP ready");
  }

  private async run() {
    const container = this.ctx.container!;
    try {
      await this.start(120_000);
      const process = await container.exec(["python3", "/opt/probe.py"], { signal: AbortSignal.timeout(90_000) });
      const output = await process.output();
      if (output.exitCode !== 0) throw new Error(new TextDecoder().decode(output.stderr));
      const result = { testedAt: new Date().toISOString(), schedulingPolicy: this.env.SCHEDULING_POLICY, ...JSON.parse(new TextDecoder().decode(output.stdout)) };
      await this.ctx.storage.put("result-v1", result);
      return result;
    } finally {
      await container.destroy();
    }
  }

  async acceptance(config: string, fixture = false) {
    if (this.pending) throw new Error("A test is already running");
    this.pending = this.runAcceptance(config, fixture).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async runAcceptance(config: string, fixture: boolean) {
    const container = this.ctx.container!;
    let keepFixture = false;
    try {
      // Always begin from a new container; Tailscale state is never restored.
      await container.destroy();
      await this.start(fixture ? 1_800_000 : 180_000);
      console.log("test: executing", fixture ? "fixture" : "acceptance");
      const process = await container.exec(["python3", fixture ? "/opt/fixture.py" : "/opt/acceptance.py"], {
        stdin: new Response(config).body!, signal: AbortSignal.timeout(150_000),
      });
      const output = await process.output();
      // Never forward stderr: it can contain credentials or database diagnostics.
      if (output.exitCode !== 0) throw new Error("Test process failed");
      const result = JSON.parse(new TextDecoder().decode(output.stdout));
      console.log("test: completed", result.stage, result.passed);
      keepFixture = fixture && result.passed === true;
      return { testedAt: new Date().toISOString(), schedulingPolicy: this.env.SCHEDULING_POLICY, image: container.images.probe, ...result };
    } catch (error) {
      // These errors originate in the Container API, not subprocess stderr or config.
      console.log("test: container failure", error instanceof Error ? error.name + ": " + error.message : "unknown");
      throw error;
    } finally {
      if (!keepFixture) await container.destroy();
    }
  }

  async cleanup() { await this.ctx.container!.destroy(); }
}

// The public route only runs a fixed, credential-free diagnostic. Private-network
// tests require an operator token stored with `wrangler secret put TEST_TOKEN`.
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/probe") {
      return Response.json(await env.PROBE.getByName("network-capabilities-v1").probe());
    }
    if (request.method !== "POST" || !["/acceptance", "/fixture", "/cleanup"].includes(path)) return new Response("Not found", { status: 404 });
    const actual = Buffer.from(request.headers.get("Authorization") ?? "");
    const expected = Buffer.from(`Bearer ${env.TEST_TOKEN ?? ""}`);
    if (!env.TEST_TOKEN || actual.length !== expected.length || !timingSafeEqual(actual, expected)) return new Response("Unauthorized", { status: 401 });
    const headers = { "Cache-Control": "no-store" };
    if (path === "/cleanup") {
      await env.PROBE.getByName("postgres-fixture-v4").cleanup();
      return Response.json({ cleanedUp: true }, { headers });
    }
    const body = await request.text();
    if (body.length > 32_768) return new Response("Too large", { status: 413 });
    try { JSON.parse(body); } catch { return new Response("Invalid JSON", { status: 400 }); }
    try {
      const fixture = path === "/fixture";
      const result = await env.PROBE.getByName(fixture ? "postgres-fixture-v4" : "postgres-acceptance-v3").acceptance(body, fixture);
      return Response.json(result, { headers });
    } catch (error) {
      console.log("test: RPC failure", error instanceof Error ? error.name + ": " + error.message : "unknown");
      if (error instanceof Error && error.message.includes("There is no container instance")) {
        return Response.json({ passed: false, stage: "capacity_pending" }, { status: 503, headers: { ...headers, "Retry-After": "5" } });
      }
      return Response.json({ passed: false, stage: "container_execution" }, { status: 500, headers });
    }
  },
} satisfies ExportedHandler<TestEnv>;
