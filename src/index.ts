import { createRemoteJWKSet, jwtVerify } from "jose";

export { HermesSandbox } from "./sandbox";
export { Outbound } from "./outbound";

const keysets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export default {
  async fetch(request, env): Promise<Response> {
    if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD || !env.AI_GATEWAY_ID) {
      return new Response("Configure Access and AI Gateway first", { status: 503 });
    }
    const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
    let keys = keysets.get(issuer);
    if (!keys) {
      keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
      keysets.set(issuer, keys);
    }
    let identity: string;
    try {
      const { payload } = await jwtVerify(request.headers.get("Cf-Access-Jwt-Assertion") ?? "", keys, {
        issuer, audience: env.ACCESS_AUD, algorithms: ["RS256"], requiredClaims: ["exp"],
      });
      // Service tokens also support automated tests when an Access policy allows them.
      if (typeof payload.sub === "string" && payload.sub) identity = `user:${payload.sub}`;
      else if (typeof payload.common_name === "string" && payload.common_name) identity = `service:${payload.common_name}`;
      else throw new Error("Missing identity");
    } catch {
      return new Response("Unauthorized", { status: 401 });
    }
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    if (origin && origin !== url.origin) return new Response("Cross-origin requests are disabled", { status: 403 });
    if (url.pathname === "/auth/logout") return Response.redirect(`${url.origin}/cdn-cgi/access/logout`, 302);
    // Only verified identities choose a container; paths and caller headers cannot.
    return env.SANDBOX.get(env.SANDBOX.idFromName(identity)).fetch(request);
  },
} satisfies ExportedHandler<Env>;
