/**
 * Settings for the optional Claude chord-symbol reader (bring-your-own-key).
 *
 * Kept OUTSIDE the main app store on purpose: the main store's state is serialised into library entries and project
 * files, and the API key must never leave this browser except in requests to Anthropic. Persisted under its own
 * localStorage key.
 */
import { create } from 'zustand';

export type ClaudeModel = 'claude-haiku-5-5' | 'claude-sonnet-5-5';

export const CLAUDE_MODELS: { id: ClaudeModel; label: string; note: string }[] = [
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', note: 'fast and cheap; fine for clean charts' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', note: 'more accurate on scans; about 20x the cost' },
];

export interface AiSettings {
  /** use Claude to read chord symbols during OMR (needs a key) */
  enabled: boolean;
  /** Anthropic API key; '' = none */
  apiKey: string;
  model: ClaudeModel;
}

interface AiSettingsStore extends AiSettings {
  set: (p: Partial<AiSettings>) => void;
}

const LS_KEY = 'tabscribe.ai';
const defaults: AiSettings = { enabled: false, apiKey: '', model: 'claude-haiku-5-5' };

function read(): AiSettings {
  try {
    if (typeof localStorage === 'undefined') return defaults;
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return defaults;
    const j = JSON.parse(raw) as Partial<AiSettings>;
    const model = CLAUDE_MODELS.some((m) => m.id === j.model) ? (j.model as ClaudeModel) : defaults.model;
    return { enabled: !!j.enabled, apiKey: typeof j.apiKey === 'string' ? j.apiKey : '', model };
  } catch {
    return defaults;
  }
}

function write(s: AiSettings) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(LS_KEY, JSON.stringify(s));
  } catch {
    /* private mode / quota: settings simply do not persist */
  }
}

export const useAiSettings = create<AiSettingsStore>((set, get) => ({
  ...read(),
  set: (p) => {
    const next: AiSettings = { enabled: get().enabled, apiKey: get().apiKey, model: get().model, ...p };
    write(next);
    set(next);
  },
}));

/** True when the Claude reader should run: enabled and a key is present. */
export function claudeReaderActive(): boolean {
  const s = useAiSettings.getState();
  return s.enabled && s.apiKey.trim().length > 0;
}
