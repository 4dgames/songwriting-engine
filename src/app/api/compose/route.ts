import { NextRequest } from 'next/server';
import { composeSongStream } from '@/lib/claude';

export const maxDuration = 120;

export async function POST(req: NextRequest) {
  const { prompt } = await req.json() as { prompt: string };

  if (!prompt?.trim()) {
    return new Response(JSON.stringify({ error: 'Prompt is required' }), { status: 400 });
  }

  const stream = await composeSongStream(prompt);
  return new Response(stream, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Accel-Buffering': 'no' },
  });
}
