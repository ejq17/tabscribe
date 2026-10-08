import type { Score } from '../core';

/** Version of the `.tabscribe.json` project file. */
export const PROJECT_VERSION = 1;

export interface ProjectFile {
  format: 'tabscribe';
  version: number;
  name?: string;
  savedAt: string;
  score: Score;
}

export function exportProject(score: Score, name?: string): string {
  const file: ProjectFile = { format: 'tabscribe', version: PROJECT_VERSION, name, savedAt: new Date().toISOString(), score };
  return JSON.stringify(file);
}

/** Parse and validate a project file; returns the score plus the saved name. */
export function importProject(text: string): { score: Score; name?: string } {
  let data: Partial<ProjectFile>;
  try {
    data = JSON.parse(text) as Partial<ProjectFile>;
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  if (!data || data.format !== 'tabscribe') throw new Error('That JSON file is not a TabScribe tab.');
  if (typeof data.version !== 'number' || data.version > PROJECT_VERSION) {
    throw new Error('This tab was saved by a newer version of TabScribe.');
  }
  const s = data.score;
  if (!s || !Array.isArray(s.tracks) || !Array.isArray(s.timeSignatures) || !Array.isArray(s.keySignatures) || !Array.isArray(s.tempos) || typeof s.ppq !== 'number') {
    throw new Error('The tab file is missing score data.');
  }
  s.meta ??= {};
  return { score: s, name: data.name };
}

/** True when the text looks like a TabScribe project (cheap check on the head). */
export function looksLikeProject(head: string): boolean {
  return /"format"\s*:\s*"tabscribe"/.test(head);
}
