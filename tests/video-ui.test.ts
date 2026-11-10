import 'fake-indexeddb/auto';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyScore } from '../src/core';
import { exportProject, importProject } from '../src/importers';

const fakePlayer = {
  load: vi.fn(), play: vi.fn(), pause: vi.fn(), seek: vi.fn(), getTime: vi.fn(() => 42), getState: vi.fn(() => 'paused'),
  setRate: vi.fn(), getAvailableRates: vi.fn(() => [1]), setVolume: vi.fn(), destroy: vi.fn(), onStateChange: vi.fn(() => () => {}),
};
const createVideoPlayer = vi.fn(async () => fakePlayer);
// The IFrame API must never load in tests.
vi.mock('../src/video/player', () => ({
  createVideoPlayer: (...a: unknown[]) => (createVideoPlayer as (...x: unknown[]) => unknown)(...a),
  loadYouTubeApi: vi.fn(async () => {
    throw new Error('not in tests');
  }),
}));

import { useStore } from '../src/store';
import * as lib from '../src/store/library';
import VideoPanel from '../src/ui/VideoPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ID = 'dQw4w9WgXcQ';
let host: HTMLDivElement;
let root: Root;

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const urlInput = () => host.querySelector<HTMLInputElement>('input[aria-label="YouTube link"]')!;
const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(label))!;
async function submit() {
  await act(async () => {
    button('Load').click();
  });
}

describe('VideoPanel', () => {
  beforeEach(async () => {
    createVideoPlayer.mockClear();
    useStore.getState().loadScore(createEmptyScore({ title: 'Song' }));
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root.render(createElement(VideoPanel)));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it('renders just the URL field when no video is set', () => {
    expect(urlInput().value).toBe('');
    expect(button('Load')).toBeTruthy();
    expect(host.querySelector('.vp-frame')).toBeNull();
    expect(host.textContent).not.toContain('Start in video');
  });

  it('shows an error for a bad URL and stores nothing', async () => {
    await type(urlInput(), 'https://example.com/nope');
    await submit();
    expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/YouTube/);
    expect(useStore.getState().score?.meta.video).toBeUndefined();
  });

  it('stores meta.video for a valid URL (prefilling t=) and mounts the player', async () => {
    await type(urlInput(), `https://youtu.be/${ID}?t=1m30s`);
    await submit();
    expect(useStore.getState().score?.meta.video).toEqual({ youtubeId: ID, startSec: 90 });
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Start in video"]')!.value).toBe('1:30');
    expect(createVideoPlayer).toHaveBeenCalledTimes(1);
  });

  it('edits the start point, uses the current video time, and removes the video', async () => {
    await type(urlInput(), ID);
    await submit();
    const start = host.querySelector<HTMLInputElement>('input[aria-label="Start in video"]')!;
    await type(start, '0:12');
    await act(async () => start.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    expect(useStore.getState().score?.meta.video?.startSec).toBe(12);
    await act(async () => button('Use current video time').click());
    expect(useStore.getState().score?.meta.video?.startSec).toBe(42);
    await act(async () => button('Remove video').click());
    expect(useStore.getState().score?.meta.video).toBeUndefined();
    expect(fakePlayer.destroy).toHaveBeenCalled();
  });

  it('carries meta.video into library entries and project files', async () => {
    await type(urlInput(), `${ID}`);
    await submit();
    const score = useStore.getState().score!;
    expect((await lib.saveEntry({ id: 'v1', name: 'Song', score })).id).toBe('v1');
    expect((await lib.getEntry('v1'))?.score.meta.video).toEqual({ youtubeId: ID, startSec: 0 });
    const text = exportProject(score, 'Song');
    expect(JSON.parse(text).score.meta.video).toEqual({ youtubeId: ID, startSec: 0 });
    expect(importProject(text).score.meta.video).toEqual({ youtubeId: ID, startSec: 0 });
  });
});
