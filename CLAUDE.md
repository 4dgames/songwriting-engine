# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev       # Start dev server at localhost:3000
npm run build     # Production build (also runs TypeScript check)
npm run lint      # ESLint
```

## Architecture

This is a Next.js 16 (App Router) TypeScript project. Three layers interact:

**1. Composition layer** (`src/app/api/compose/route.ts` → `src/lib/claude.ts`)
The user's natural language prompt is sent to Claude (claude-opus-4-6). Claude returns a structured `Song` JSON object including lyrics by section, chord progressions, and an `audioPrompt` optimized for music-generation APIs. The system prompt in `claude.ts` enforces strict JSON output with no markdown or prose.

**2. Audio generation layer** (`src/app/api/generate/route.ts` → `src/lib/audio/`)
`src/lib/audio/types.ts` defines an `AudioProvider` interface. `suno.ts` exports both `SunoProvider` (real Suno API) and `MockAudioProvider` (returns a sample MP3 for development). `getAudioProvider()` picks the right one based on whether `SUNO_API_KEY` is set. Suno's API uses async job polling — submit a job, get an ID, poll until `status === 'complete'`.

**3. UI layer** (`src/components/`)
- `PromptInput` — textarea + submit that calls `/api/compose`
- `SongEditor` — displays `Song` metadata, editable `audioPrompt`, section list, and the "Generate Audio" button that calls `/api/generate`
- `SectionEditor` — per-section editor for lyrics (textarea) and chords (space-separated text input parsed to `string[]`)
- `AudioPlayer` — HTML `<audio>` element with a custom progress bar and download link

State lives in `page.tsx` (the `Song` object) and flows down as props. No global state library.

## Core Types (`src/lib/types.ts`)

```ts
type SectionType = 'intro' | 'verse' | 'pre-chorus' | 'chorus' | 'bridge' | 'outro';

interface SongSection {
  type: SectionType;
  label: string;       // "Verse 1", "Chorus"
  lyrics: string;      // \n-separated lines
  chords: string[];    // ["Am", "F", "C", "G"]
}

interface Song {
  title: string;
  genre: string;
  mood: string;
  tempo: number;
  key: string;
  sections: SongSection[];
  audioPrompt: string; // optimized prompt sent to Suno
  audioUrl?: string;   // set after audio is generated
}
```

## Environment Variables

Copy `.env.local.example` to `.env.local` and fill in:
- `ANTHROPIC_API_KEY` — required for song composition
- `SUNO_API_KEY` — optional; without it the mock provider returns a sample MP3

## Adding a New Audio Provider

Implement `AudioProvider` from `src/lib/audio/types.ts` and update `getAudioProvider()` in `src/lib/audio/suno.ts`.
