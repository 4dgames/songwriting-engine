/**
 * Returns the Deepgram API key for browser-side WebSocket STT.
 * The key is kept server-side in an env var and served through this route,
 * which is protected by the app's existing auth layer (same-origin).
 *
 * For stricter isolation, Deepgram's key management API can be used to issue
 * short-lived keys — but that requires an admin-scoped key; for now we pass
 * the key directly since this is an internal/dev deployment.
 */
export async function GET() {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) {
    return Response.json({ error: 'DEEPGRAM_API_KEY not configured' }, { status: 500 });
  }
  return Response.json({ key: apiKey });
}
