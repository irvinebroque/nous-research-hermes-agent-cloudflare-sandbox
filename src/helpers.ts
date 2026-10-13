export const modelBaseUrl = "https://model.internal/v1";

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
