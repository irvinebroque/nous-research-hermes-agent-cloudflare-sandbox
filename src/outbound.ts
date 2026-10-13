import { WorkerEntrypoint } from "cloudflare:workers";
import { aiGatewayBaseUrl } from "./helpers";

export class Outbound extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.protocol !== "https:" || (url.port && url.port !== "443")) {
      return new Response("HTTPS only", { status: 403 });
    }

    if (url.href === `${aiGatewayBaseUrl(this.env.CLOUDFLARE_ACCOUNT_ID)}/chat/completions` && request.method === "POST") {
      // The Worker selects the gateway and credentials, not sandbox-supplied headers.
      const headers = new Headers({
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.env.AI_GATEWAY_API_TOKEN}`,
        "cf-aig-gateway-id": this.env.AI_GATEWAY_ID,
        "cf-aig-skip-cache": "true",
      });
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
