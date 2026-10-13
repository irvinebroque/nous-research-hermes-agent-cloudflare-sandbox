import { authorized, parseTask, readText } from "./helpers";

export { HermesSandbox } from "./sandbox";
export { Outbound } from "./outbound";

export default {
  async fetch(request, env): Promise<Response> {
    if (new URL(request.url).pathname !== "/run") return new Response("Not found", { status: 404 });
    if (request.method !== "POST") return new Response("Use POST", { status: 405, headers: { Allow: "POST" } });
    if (!env.API_TOKEN || !env.AI_GATEWAY_ID) {
      return new Response("Configure API_TOKEN and AI_GATEWAY_ID", { status: 503 });
    }
    if (!authorized(request.headers.get("Authorization"), env.API_TOKEN)) {
      return new Response("Unauthorized", { status: 401 });
    }

    let body: string;
    try {
      body = JSON.stringify(parseTask(await readText(request.body, 16 * 1024)));
    } catch {
      return Response.json({ error: "Send JSON with a public GitHub repository URL and a prompt (1–8000 characters; body ≤16 KiB)." }, { status: 400 });
    }

    // Each request gets its own container, filesystem, and Hermes home directory.
    const sandbox = env.SANDBOX.get(env.SANDBOX.newUniqueId());
    return sandbox.fetch(new Request(request, { body }));
  },
} satisfies ExportedHandler<Env>;
