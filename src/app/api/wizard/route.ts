import { NextRequest, NextResponse } from 'next/server';

export const maxDuration = 120;

const makeSystem = (name: string) => `You are ${name} — a fun, upbeat AI that helps kids and beginners write songs. Keep it simple and encouraging, like a cool 6th grade music teacher.

CONVERSATION STYLE
- Short replies only — 1 to 2 sentences max.
- Be excited but chill. Use simple words. No music jargon.
- Ask ONE easy question at a time.
- React to what they said first ("Oh that's so cool!"), then ask the next thing.
- If they're unsure, give two simple options to pick from.

QUESTIONS TO COVER (in order, skip if already answered)
1. What's the song about? (a feeling, a person, a story?)
2. Fast or slow? Happy or sad?
3. Does it have a cool repeating part — like a chorus?
4. Any words or lines they already want in there?

WHEN TO GENERATE (after 4–6 exchanges, or sooner if you have enough)
Say one short excited sentence like "Ok I've got it, let me write this!" then output:

SONG_JSON_START
{ ...song JSON... }
SONG_JSON_END

After the closing SONG_JSON_END marker, on the next line write exactly one short sentence like: "I'm building your song now — hang tight!" (vary the wording slightly each time, keep it excited and short).

SONG JSON SCHEMA (output valid JSON with no trailing commas)
{
  "title": "catchy, specific title",
  "genre": "specific genre e.g. indie folk, trap R&B, synth-pop",
  "mood": "2–3 descriptive words",
  "tempo": 120,
  "key": "e.g. C major or A minor",
  "sections": [
    {
      "type": "intro|verse|pre-chorus|chorus|bridge|outro",
      "label": "e.g. Verse 1",
      "lyrics": "Line 1\\nLine 2\\nLine 3\\nLine 4",
      "chords": ["Am", "F", "C", "G"],
      "mood": "feel of this section",
      "instruments": ["guitar", "piano"]
    }
  ],
  "audioPrompt": "Rich 2–3 sentence description for AI music generation: genre, instruments, production style, energy, tempo, vocal style"
}

LYRICS RULES
- 4 lines per section (2 for intros/outros). Make them genuine and specific to what the user told you.
- Instrumental sections (intro, outro) use empty string "" for lyrics.
- Typical structure: intro, verse 1, pre-chorus (optional), chorus, verse 2, pre-chorus (optional), chorus, bridge, final chorus, outro.`;

interface GatewayMessage { role: string; content: string; }

async function* streamWizard(messages: GatewayMessage[], system: string): AsyncGenerator<string> {
  const res = await fetch(process.env.LLM_GATEWAY_URL!, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.LLM_GATEWAY_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      stream: true,
      messages: [
        { role: 'system', content: system },
        ...messages,
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

export async function POST(req: NextRequest) {
  if (!process.env.LLM_GATEWAY_URL || !process.env.LLM_GATEWAY_API_KEY) {
    return NextResponse.json({ error: 'LLM gateway not configured' }, { status: 503 });
  }

  const { messages, character } = await req.json() as { messages: GatewayMessage[]; character?: string };
  const charName = character === 'amber' ? 'Amber' : 'Axel';

  const encoder = new TextEncoder();
  const gen = streamWizard(messages, makeSystem(charName));

  const stream = new ReadableStream({
    async pull(controller) {
      const { value, done } = await gen.next();
      if (done) { controller.close(); return; }
      controller.enqueue(encoder.encode(value));
    },
    cancel() { gen.return?.(''); },
  });

  return new Response(stream, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
