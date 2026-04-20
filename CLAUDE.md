# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev       # Start dev server at localhost:3000
npm run build     # Production build (also runs TypeScript check)
npm run lint      # ESLint
```

## Observing the UI (localhost:3000)

To take a screenshot of the running app and inspect it visually:

```bash
npx playwright screenshot --browser chromium "http://localhost:3000" /tmp/song_screenshot.png --wait-for-timeout 3000 --viewport-size "1400,900"
```

Then read `/tmp/song_screenshot.png` with the Read tool to see the current state of the page. Use a different path or query param to screenshot other routes (e.g. `"http://localhost:3000/?demo=1"`).

To capture the full page including content below the fold, add `--full-page`:

```bash
npx playwright screenshot --browser chromium "http://localhost:3000" /tmp/song_screenshot.png --wait-for-timeout 3000 --viewport-size "1400,900" --full-page
```

## Watching the Browser Console

To stream browser console output (errors, logs, hydration warnings) in real time:

```bash
node /tmp/watch_console.js > /tmp/browser_console.log 2>&1 &
```

Then read `/tmp/browser_console.log` with the Read tool. The script `/tmp/watch_console.js` uses the Playwright Node API (not the CLI). If the file is missing from /tmp, recreate it:

```js
const { chromium } = require('/Users/gabeturow/.npm/_npx/e41f203b7505f1fb/node_modules/playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('console', msg => {
    const ts = new Date().toISOString().slice(11, 23);
    process.stdout.write(`[${ts}] [${msg.type().toUpperCase()}] ${msg.text()}\n`);
  });
  page.on('pageerror', err => {
    const ts = new Date().toISOString().slice(11, 23);
    process.stdout.write(`[${ts}] [PAGE ERROR] ${err.message}\n`);
  });
  await page.goto('http://localhost:3000', { waitUntil: 'networkidle' });
  process.stdout.write('[ready] watching\n');
  await new Promise(() => {});
})();
```

## Interactive UI Testing with Playwright

Beyond static screenshots, the Playwright Node API can click, scroll, fill inputs, and interact with the page. Use inline `node -e` scripts:

```bash
node -e "
const { chromium } = require('/Users/gabeturow/.npm/_npx/e41f203b7505f1fb/node_modules/playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('http://localhost:3000/?demo=1', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  // Examples:
  await page.getByText('Instruments').first().click();   // click by visible text
  await page.locator('button[title=\"Generate\"]').click(); // click by selector
  await page.evaluate(() => window.scrollBy(0, 600));    // scroll
  await page.fill('input[placeholder=\"Search…\"]', 'guitar'); // fill input

  await page.waitForTimeout(500);
  await page.screenshot({ path: '/tmp/result.png' });
  await browser.close();
})();
"
```

Then read `/tmp/result.png` with the Read tool. This is the right approach when you need to verify a feature that requires interaction (open an accordion, hover a button, etc.) rather than just the initial page state.

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
