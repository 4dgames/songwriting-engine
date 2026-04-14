import { NextRequest, NextResponse } from 'next/server';

/**
 * Proxies audio files from external CDNs (e.g. Replicate's output storage)
 * to avoid cross-origin restrictions when the browser fetches audio for
 * AudioContext.decodeAudioData() or Waveform rendering.
 *
 * Usage: /api/audio-proxy?url=<encoded-url>
 */
export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get('url');
  if (!url) {
    return NextResponse.json({ error: 'url param required' }, { status: 400 });
  }

  // Only allow HTTPS URLs to avoid SSRF
  if (!url.startsWith('https://')) {
    return NextResponse.json({ error: 'Only HTTPS URLs are allowed' }, { status: 400 });
  }

  const upstream = await fetch(url);
  if (!upstream.ok) {
    return NextResponse.json({ error: 'Upstream fetch failed' }, { status: upstream.status });
  }

  const contentType = upstream.headers.get('content-type') ?? 'audio/wav';
  return new NextResponse(upstream.body, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'private, max-age=3600',
    },
  });
}
