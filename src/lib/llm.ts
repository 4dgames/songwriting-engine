/**
 * Shared helper for streaming from the Anthropic Messages API.
 * Used by both the compose and wizard routes.
 */
export async function* streamAnthropic(
  system: string,
  messages: { role: string; content: string }[],
  maxTokens = 4096,
): AsyncGenerator<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key':         process.env.ANTHROPIC_API_KEY!,
      'anthropic-version': '2023-06-01',
      'content-type':      'application/json',
    },
    body: JSON.stringify({
      model:      'claude-sonnet-4-6',
      max_tokens: maxTokens,
      stream:     true,
      system,
      messages,
    }),
  });

  if (!res.ok) throw new Error(`Anthropic API error: ${res.status} ${await res.text()}`);

  const reader  = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      try {
        const chunk = JSON.parse(trimmed.slice(5).trim());
        if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
          yield chunk.delta.text as string;
        }
      } catch { /* skip malformed chunks */ }
    }
  }
}
