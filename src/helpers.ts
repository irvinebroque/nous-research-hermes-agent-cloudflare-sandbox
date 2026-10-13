import { timingSafeEqual } from "node:crypto";

export function authorized(header: string | null, token: string): boolean {
  if (!token || !header) return false;
  const actual = new TextEncoder().encode(header);
  const expected = new TextEncoder().encode(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// Drain stdout and stderr separately with a limit; output() would buffer without a limit.
export async function readText(stream: ReadableStream<Uint8Array> | null, limit: number): Promise<string> {
  if (!stream) return "";
  let bytes = 0;
  let text = "";
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    bytes += chunk.byteLength;
    if (bytes > limit) throw new Error(`Output exceeds ${limit} bytes`);
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

export function parseTask(body: string): { repository: string; prompt: string } {
  const task = JSON.parse(body);
  if (typeof task?.prompt !== "string" || !task.prompt.trim() || task.prompt.length > 8000) {
    throw new Error("prompt must contain 1–8000 characters");
  }
  // Accept public GitHub clone URLs, with no credentials, query, ref, or shell syntax.
  if (typeof task.repository !== "string" ||
      !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(task.repository)) {
    throw new Error("repository must be https://github.com/OWNER/REPO");
  }
  return { repository: task.repository, prompt: task.prompt };
}
