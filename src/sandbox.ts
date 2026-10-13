import { DurableObject } from "cloudflare:workers";
import { readText } from "./helpers";

const ca = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
const processEnv = {
  HOME: "/root",
  HERMES_HOME: "/tmp/hermes-home",
  TERMINAL_ENV: "local",
  TERMINAL_CWD: "/workspace/repo",
  OPENROUTER_API_KEY: "provided-by-worker",
  PYTHONUNBUFFERED: "1",
  GIT_TERMINAL_PROMPT: "0",
  // exec() inherits only PATH. Python and Git must trust the interception CA.
  SSL_CERT_FILE: ca,
  REQUESTS_CA_BUNDLE: ca,
  GIT_SSL_CAINFO: ca,
};

export class HermesSandbox extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const container = this.ctx.container!;
    const task: { repository: string; prompt: string } = await request.json();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort = () => {};
    const stopped = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Task exceeded five minutes")), 5 * 60_000);
      onAbort = () => reject(new Error("Client disconnected"));
      request.signal.addEventListener("abort", onAbort, { once: true });
    });

    try {
      if (request.signal.aborted) throw new Error("Client disconnected");
      const result = await Promise.race([this.run(task), stopped]);
      return Response.json(result, { status: result.exitCode === 0 ? 200 : 422 });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "Sandbox failed" }, { status: 502 });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      request.signal.removeEventListener("abort", onAbort);
      // Destroy the whole container, including any children Hermes started.
      await container.destroy();
    }
  }

  private async run(task: { repository: string; prompt: string }) {
    const container = this.ctx.container!;
    container.start({ image: container.images.hermes, instance: "standard-1", enableInternet: false });
    await container.setInactivityTimeout(60_000);
    await container.interceptAllOutboundHttp(this.ctx.exports.Outbound);
    await container.interceptOutboundHttps("*", this.ctx.exports.Outbound);

    const clone = await this.exec(["git", "clone", "--depth", "1", "--", task.repository, "/workspace/repo"], "/workspace");
    if (clone.exitCode !== 0) return { stage: "clone", ...clone, diff: "" };
    const base = await this.exec(["git", "rev-parse", "HEAD"]);
    if (base.exitCode !== 0) return { stage: "clone", ...base, diff: "" };

    const agent = await this.exec([
      "hermes", "chat", "--quiet", "--provider", "openrouter", "--model", this.env.MODEL,
      "--toolsets", "terminal,file", "--max-turns", "12", "--yolo", `--query=${task.prompt}`,
    ]);
    // Compare to the original commit even if Hermes staged or committed changes.
    const diff = await this.exec([
      "sh", "-c", 'git add --intent-to-add --all && git diff --no-ext-diff --binary "$1" --',
      "diff", base.stdout.trim(),
    ]);
    if (diff.exitCode !== 0) throw new Error(`Cannot collect diff: ${diff.stderr}`);
    return { stage: "hermes", ...agent, diff: diff.stdout };
  }

  private async exec(argv: string[], cwd = "/workspace/repo") {
    const process = await this.ctx.container!.exec(argv, { cwd, env: processEnv });
    const [stdout, stderr, exitCode] = await Promise.all([
      readText(process.stdout, 1024 * 1024),
      readText(process.stderr, 1024 * 1024),
      process.exitCode,
    ]);
    return { exitCode, stdout, stderr };
  }
}
