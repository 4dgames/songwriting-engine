'use client';

import { useState } from 'react';

interface Props {
  onCompose: (prompt: string) => void;
  loading: boolean;
  defaultValue?: string;
}

export default function PromptInput({ onCompose, loading, defaultValue = '' }: Props) {
  const [prompt, setPrompt] = useState(defaultValue);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (prompt.trim() && !loading) onCompose(prompt.trim());
  };

  return (
    <form onSubmit={handleSubmit} className="w-full">
      <div className="flex flex-col gap-3">
        <label className="text-sm font-medium text-[#3b3b3b]">
          Describe your song
        </label>
        <textarea
          value={prompt}
          onChange={e => setPrompt(e.target.value)}
          placeholder="e.g. An upbeat indie pop song about chasing dreams in a big city, with driving guitar and hopeful vocals"
          rows={3}
          className="w-full rounded-lg bg-white border border-[#bdbdbd] text-[#3b3b3b] placeholder-[#929292] px-4 py-3 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-[#f37321] focus:border-[#f37321] transition-colors"
          disabled={loading}
        />
        <button
          type="submit"
          disabled={loading || !prompt.trim()}
          className="self-end px-6 py-2.5 rounded-lg bg-[#f37321] hover:bg-[#da6520] disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold transition-colors shadow-[0_2px_4px_rgba(243,115,33,0.3)]"
        >
          {loading ? 'Composing…' : 'Compose Song'}
        </button>
      </div>
    </form>
  );
}
