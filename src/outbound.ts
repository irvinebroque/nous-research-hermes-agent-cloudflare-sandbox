import { WorkerEntrypoint } from "cloudflare:workers";

export class Outbound extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.protocol !== "https:" || (url.port && url.port !== "443")) {
      return new Response("HTTPS only", { status: 403 });
    }

    if (url.hostname === "openrouter.ai" && url.pathname === "/api/v1/chat/completions" && request.method === "POST") {
      const headers = new Headers(request.headers);
      headers.set("Authorization", `Bearer ${this.env.OPENROUTER_API_KEY}`);
      // Do not follow redirects with a credential attached.
      return fetch(new Request(request, { headers, redirect: "manual" }));
    }
    // Git smart HTTP uses GET and POST. No GitHub token is supplied.
    if (url.hostname === "github.com" && ["GET", "POST"].includes(request.method)) {
      const headers = new Headers(request.headers);
      headers.delete("Authorization");
      return fetch(new Request(request, { headers, redirect: "manual" }));
    }
    return new Response("Destination is not allowed", { status: 403 });
  }
}
