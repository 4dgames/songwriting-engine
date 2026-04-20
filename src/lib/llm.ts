/**
 * Unified LLM streaming helper.
 *
 * Priority:
 *  1. LLM_GATEWAY_URL + LLM_GATEWAY_API_KEY  — Amplify internal gateway (local/VPN)
 *  2. ANTHROPIC_API_KEY                        — Anthropic API directly (Amplify Hosting)
 */

async function* streamViaGateway(
  system: string,
  messages: { role: string; content: string }[],
  maxTokens: number,
): AsyncGenerator<string> {
  const res = await fetch(process.env.LLM_GATEWAY_URL!, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.LLM_GATEWAY_API_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      model:      'claude-sonnet-4-6',
      max_tokens: maxTokens,
      stream:     true,
      messages: [{ role: 'system', content: system }, ...messages],
    }),
  });

  if (!res.ok) throw new Error(`LLM Gateway error: ${res.status} ${await res.text()}`);

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
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') continue;
      try {
        const chunk = JSON.parse(data);
        const content = chunk.choices?.[0]?.delta?.content;
        if (content) yield content as string;
      } catch { /* skip malformed */ }
    }
  }
}

async function* streamViaAnthropic(
  system: string,
  messages: { role: string; content: string }[],
  maxTokens: number,
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
      } catch { /* skip malformed */ }
    }
  }
}

export function streamLLM(
  system: string,
  messages: { role: string; content: string }[],
  maxTokens = 4096,
): AsyncGenerator<string> {
  if (process.env.LLM_GATEWAY_URL && process.env.LLM_GATEWAY_API_KEY) {
    return streamViaGateway(system, messages, maxTokens);
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return streamViaAnthropic(system, messages, maxTokens);
  }
  throw new Error('No LLM provider configured. Set LLM_GATEWAY_URL+LLM_GATEWAY_API_KEY or ANTHROPIC_API_KEY.');
}

/** Kept for backwards compatibility */
export const streamAnthropic = streamViaAnthropic;
