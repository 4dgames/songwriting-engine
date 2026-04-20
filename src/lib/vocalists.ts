export interface Vocalist {
  id: string;
  name: string;
  description: string;
  gender: 'female' | 'male';
  /** Tags passed to ElevenLabs to guide vocal style */
  styleTags: string[];
  /** HSL color for avatar background */
  color: string;
  /** Lighter shade for gradient */
  colorLight: string;
}

export const VOCALISTS: Vocalist[] = [
  {
    id: 'luna',
    name: 'Luna',
    description: 'Ethereal soprano',
    gender: 'female',
    styleTags: ['female vocalist', 'soprano', 'breathy', 'delicate', 'airy', 'ethereal'],
    color: '#7c3aed',
    colorLight: '#a78bfa',
  },
  {
    id: 'marcus',
    name: 'Marcus',
    description: 'Soulful baritone',
    gender: 'male',
    styleTags: ['male vocalist', 'baritone', 'soulful', 'warm', 'deep', 'resonant'],
    color: '#1d4ed8',
    colorLight: '#60a5fa',
  },
  {
    id: 'kai',
    name: 'Kai',
    description: 'Raw indie tenor',
    gender: 'male',
    styleTags: ['male vocalist', 'tenor', 'indie', 'raw', 'emotional', 'gravelly'],
    color: '#047857',
    colorLight: '#34d399',
  },
  {
    id: 'zara',
    name: 'Zara',
    description: 'Powerhouse R&B',
    gender: 'female',
    styleTags: ['female vocalist', 'mezzo-soprano', 'powerful', 'r&b', 'bold', 'commanding'],
    color: '#b45309',
    colorLight: '#fbbf24',
  },
  {
    id: 'finn',
    name: 'Finn',
    description: 'Folk storyteller',
    gender: 'male',
    styleTags: ['male vocalist', 'baritone', 'folk', 'warm', 'storytelling', 'intimate'],
    color: '#4d7c0f',
    colorLight: '#a3e635',
  },
  {
    id: 'nova',
    name: 'Nova',
    description: 'Bright pop voice',
    gender: 'female',
    styleTags: ['female vocalist', 'soprano', 'pop', 'bright', 'energetic', 'clear'],
    color: '#be185d',
    colorLight: '#f472b6',
  },
  {
    id: 'rex',
    name: 'Rex',
    description: 'Gritty blues tenor',
    gender: 'male',
    styleTags: ['male vocalist', 'tenor', 'blues', 'raspy', 'gritty', 'authentic', 'worn'],
    color: '#b91c1c',
    colorLight: '#f87171',
  },
  {
    id: 'iris',
    name: 'Iris',
    description: 'Smooth jazz mezzo',
    gender: 'female',
    styleTags: ['female vocalist', 'mezzo-soprano', 'jazz', 'smooth', 'sultry', 'velvet'],
    color: '#0e7490',
    colorLight: '#22d3ee',
  },
  {
    id: 'sage',
    name: 'Sage',
    description: 'Deep gospel bass',
    gender: 'male',
    styleTags: ['male vocalist', 'bass', 'gospel', 'deep', 'powerful', 'resonant', 'booming'],
    color: '#44403c',
    colorLight: '#a8a29e',
  },
  {
    id: 'aria',
    name: 'Aria',
    description: 'Classical crossover',
    gender: 'female',
    styleTags: ['female vocalist', 'soprano', 'classical', 'operatic', 'pure', 'vibrato', 'trained'],
    color: '#9d174d',
    colorLight: '#f9a8d4',
  },
  {
    id: 'dex',
    name: 'Dex',
    description: 'Smooth R&B falsetto',
    gender: 'male',
    styleTags: ['male vocalist', 'tenor', 'r&b', 'smooth', 'falsetto', 'modern', 'polished'],
    color: '#1e3a8a',
    colorLight: '#93c5fd',
  },
  {
    id: 'maya',
    name: 'Maya',
    description: 'Country storyteller',
    gender: 'female',
    styleTags: ['female vocalist', 'mezzo-soprano', 'country', 'twangy', 'heartfelt', 'americana', 'clear'],
    color: '#78350f',
    colorLight: '#fde68a',
  },
  {
    id: 'colt',
    name: 'Colt',
    description: 'Hard rock power',
    gender: 'male',
    styleTags: ['male vocalist', 'baritone', 'rock', 'powerful', 'gritty', 'aggressive', 'intense'],
    color: '#450a0a',
    colorLight: '#fca5a5',
  },
  {
    id: 'cleo',
    name: 'Cleo',
    description: 'Neo-soul alto',
    gender: 'female',
    styleTags: ['female vocalist', 'alto', 'neo-soul', 'warm', 'husky', 'expressive', 'soulful'],
    color: '#064e3b',
    colorLight: '#6ee7b7',
  },
  {
    id: 'rio',
    name: 'Rio',
    description: 'Latin pop tenor',
    gender: 'male',
    styleTags: ['male vocalist', 'tenor', 'latin', 'passionate', 'rhythmic', 'vibrant', 'dynamic'],
    color: '#7c2d12',
    colorLight: '#fdba74',
  },
  {
    id: 'vera',
    name: 'Vera',
    description: 'Dark indie alto',
    gender: 'female',
    styleTags: ['female vocalist', 'mezzo-soprano', 'indie', 'dark', 'haunting', 'introspective', 'breathy'],
    color: '#312e81',
    colorLight: '#a5b4fc',
  },
];

export function getVocalistById(id: string): Vocalist | undefined {
  return VOCALISTS.find(v => v.id === id);
}

/** Derive combined ElevenLabs style tags from a set of vocalist IDs */
export function getVocalStyleTags(vocalistIds: string[]): string[] {
  if (vocalistIds.length === 0) return [];

  const vocalists = vocalistIds.map(id => getVocalistById(id)).filter(Boolean) as Vocalist[];
  const tags = new Set<string>();

  for (const v of vocalists) {
    for (const tag of v.styleTags) tags.add(tag);
  }

  if (vocalists.length === 2) {
    tags.add('duet');
    tags.add('vocal harmonies');
  } else if (vocalists.length >= 3) {
    tags.add('ensemble vocals');
    tags.add('vocal harmonies');
    tags.add('layered vocals');
  }

  // Mixed gender → add explicit harmony descriptor
  const hasMale = vocalists.some(v => v.gender === 'male');
  const hasFemale = vocalists.some(v => v.gender === 'female');
  if (hasMale && hasFemale) tags.add('mixed vocal harmonies');

  return [...tags];
}
