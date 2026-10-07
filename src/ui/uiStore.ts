import { create } from 'zustand';

/** Ephemeral UI state (not part of the document). */
interface UiState {
  editorOpen: boolean;
  settingsOpen: boolean;
  setEditorOpen: (v: boolean) => void;
  setSettingsOpen: (v: boolean) => void;
}
export const useUi = create<UiState>()((set) => ({
  editorOpen: false,
  settingsOpen: false,
  setEditorOpen: (editorOpen) => set({ editorOpen }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
}));

/** Audio loading state for the lazily created Player. */
interface AudioUi {
  loading: boolean;
  error?: string;
}
export const useAudioUi = create<AudioUi>()(() => ({ loading: false }));
