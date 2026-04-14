import type { AudioProvider, AudioResult, SectionRegenerationContext } from './types';
import type { Song } from '../types';

export class RealSongGenerationProvider implements AudioProvider {
  private apiKey: string;
  private baseUrl: string;

  constructor() {
    this.apiKey = process.env.SUNO_API_KEY ?? '';
    this.baseUrl = process.env.SUNO_API_URL ?? 'https://api.suno.com/v1';
  }

  async generate(song: Song, _context?: SectionRegenerationContext): Promise<AudioResult> {
    const createRes = await fetch(`${this.baseUrl}/generations`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: song.audioPrompt, title: song.title, make_instrumental: false }),
    });
    if (!createRes.ok) throw new Error(`Suno API error: ${createRes.status} ${await createRes.text()}`);
    const { id: jobId } = await createRes.json();
    return { audioUrl: await this.poll(jobId) };
  }

  private async poll(jobId: string, attempts = 0): Promise<string> {
    if (attempts > 36) throw new Error('Suno generation timed out');
    await new Promise(r => setTimeout(r, 5000));
    const res = await fetch(`${this.baseUrl}/generations/${jobId}`, {
      headers: { 'Authorization': `Bearer ${this.apiKey}` },
    });
    if (!res.ok) throw new Error(`Suno poll error: ${res.status}`);
    const data = await res.json();
    if (data.status === 'complete' && data.audio_url) return data.audio_url;
    if (data.status === 'failed') throw new Error('Suno generation failed');
    return this.poll(jobId, attempts + 1);
  }
}

export class MockAudioProvider implements AudioProvider {
  async generate(_song: Song, _context?: SectionRegenerationContext): Promise<AudioResult> {
    await new Promise(r => setTimeout(r, 1500));
    // Fetch and re-serve as a data URL so the browser can fetch it without CORS issues
    const res = await fetch('https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3');
    const buf = await res.arrayBuffer();
    const base64 = Buffer.from(buf).toString('base64');
    return { audioUrl: `data:audio/mpeg;base64,${base64}` };
  }
}

export function getAudioProvider(): AudioProvider {
  if (process.env.ELEVENLABS_API_KEY) {
    const { ElevenLabsProvider } = require('./elevenlabs');
    return new ElevenLabsProvider();
  }
  if (process.env.SUNO_API_KEY) return new RealSongGenerationProvider();
  return new MockAudioProvider();
}
