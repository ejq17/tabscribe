import { create } from 'zustand';

/** Ephemeral UI state (not part of the document). */
interface UiState {
  editorOpen: boolean;
  settingsOpen: boolean;
  libraryOpen: boolean;
  videoOpen: boolean;
  setVideoOpen: (v: boolean) => void;
  setLibraryOpen: (v: boolean) => void;
  setEditorOpen: (v: boolean) => void;
  setSettingsOpen: (v: boolean) => void;
}
export const useUi = create<UiState>()((set) => ({
  editorOpen: false,
  settingsOpen: false,
  libraryOpen: false,
  videoOpen: false,
  setVideoOpen: (videoOpen) => set({ videoOpen }),
  setLibraryOpen: (libraryOpen) => set({ libraryOpen }),
  setEditorOpen: (editorOpen) => set({ editorOpen }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
}));

/** Audio loading state for the lazily created Player. */
interface AudioUi {
  loading: boolean;
  error?: string;
}
export const useAudioUi = create<AudioUi>()(() => ({ loading: false }));
