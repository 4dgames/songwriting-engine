import type { Song } from './types';

const SYSTEM_PROMPT = `You are a professional songwriter and music producer. When given a description of a song, you return a structured JSON object representing the complete song.

Your response must be ONLY valid JSON — no markdown, no explanation, no code fences.

The JSON must follow this exact shape:
{
  "title": "string",
  "genre": "string",
  "mood": "string",
  "tempo": number (BPM),
  "key": "string (e.g. C major, A minor)",
  "sections": [
    {
      "type": "intro" | "verse" | "pre-chorus" | "chorus" | "bridge" | "outro",
      "label": "string (e.g. Verse 1, Chorus)",
      "lyrics": "string (full lyrics for this section, use \\n for line breaks)",
      "chords": ["string"] (e.g. ["Am", "F", "C", "G"]),
      "mood": "string (2-5 words describing the feel/energy of this specific section, e.g. 'tender and introspective', 'explosive and triumphant')",
      "instruments": ["string"] (instruments active in this section, e.g. ["acoustic guitar", "piano", "drums"] — vary by section to reflect dynamic arrangement)
    }
  ],
  "audioPrompt": "string (a single optimized prompt for an AI music generation API like Suno, describing genre, mood, instruments, vocal style, tempo, and vibe — 1-3 sentences)"
}

Guidelines:
- Write complete, meaningful lyrics — not placeholders
- Include a logical song structure (e.g. intro, verse, chorus, verse, chorus, bridge, chorus, outro)
- IMPORTANT: If there is any instrumental passage before the first vocal line, it MUST be its own section with type "intro" and label "Introduction" and empty lyrics "". Never embed an instrumental intro inside another section.
- Chords per section should be the repeating progression for that section (typically 4 chords)
- The audioPrompt should capture the essence of the song in a way that music AI models understand: mention genre, tempo feel, key instruments, vocal style, energy level
- For instruments: extract any instruments mentioned in the user's prompt and distribute them across sections. Add/remove instruments across sections to reflect natural song dynamics (e.g. sparse intro, full chorus, stripped-back bridge)`;

async function* streamLLM(userPrompt: string): AsyncGenerator<string> {
  const res = await fetch(process.env.LLM_GATEWAY_URL!, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.LLM_GATEWAY_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      stream: true,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
    }),
  });

  if (!res.ok) throw new Error(`LLM Gateway error: ${res.status} ${await res.text()}`);

  const reader = res.body!.getReader();
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
        if (content) yield content;
      } catch { /* skip malformed chunks */ }
    }
  }
}

/** Streams raw text deltas — used by the API route to push progress to the client. */
export async function composeSongStream(userPrompt: string): Promise<ReadableStream<Uint8Array>> {
  const encoder = new TextEncoder();
  const gen = streamLLM(userPrompt);
  return new ReadableStream({
    async pull(controller) {
      const { value, done } = await gen.next();
      if (done) { controller.close(); return; }
      controller.enqueue(encoder.encode(value));
    },
    cancel() { gen.return?.(''); },
  });
}

export async function composeSong(userPrompt: string): Promise<Song> {
  const stream = await composeSongStream(userPrompt);
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let fullText = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    fullText += decoder.decode(value, { stream: true });
  }
  return JSON.parse(fullText) as Song;
}
