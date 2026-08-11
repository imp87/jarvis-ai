/** MCP returns structured content; the agent loop needs a single string. */
export function renderToolContent(content: unknown): string {
  if (!Array.isArray(content)) return JSON.stringify(content ?? null);
  const parts: string[] = [];
  for (const item of content as Array<Record<string, unknown>>) {
    if (item["type"] === "text" && typeof item["text"] === "string") {
      parts.push(item["text"]);
    } else if (item["type"] === "resource") {
      parts.push(JSON.stringify(item["resource"]));
    } else {
      // Images and audio can't go into a text tool result; describe them so the
      // model knows something came back rather than seeing an empty string.
      parts.push(`[${String(item["type"] ?? "unknown")} content omitted]`);
    }
  }
  return parts.join("\n");
}
