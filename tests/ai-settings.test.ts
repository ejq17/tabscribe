import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { useAiSettings } from '../src/ai/settings';
import { testClaudeKey } from '../src/ai/testKey';
import Settings from '../src/ui/Settings';
import { useUi } from '../src/ui/uiStore';
import { useStore } from '../src/store';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KEY = 'sk-ant-secret-1234';
let host: HTMLElement;
let root: Root;

function typeInto(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
const q = <T extends Element>(sel: string) => host.querySelector(sel) as T;
const testBtn = () => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Test key')) as HTMLButtonElement;

beforeEach(async () => {
  localStorage.clear();
  useAiSettings.setState({ enabled: false, apiKey: '', model: 'claude-haiku-5-5' });
  useUi.getState().setSettingsOpen(true);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(Settings)));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  useUi.getState().setSettingsOpen(false);
});

describe('AI settings UI', () => {
  it('saves a typed key to its own localStorage entry only', async () => {
    await act(async () => typeInto(q<HTMLInputElement>('input[placeholder="sk-ant-..."]'), KEY));
    expect(JSON.parse(localStorage.getItem('tabscribe.ai')!).apiKey).toBe(KEY);
    expect(localStorage.getItem('tabscribe.prefs.v1') ?? '').not.toContain(KEY);
    expect(JSON.stringify(useStore.getState())).not.toContain(KEY);
    expect(host.textContent).toContain('ends in ····1234');
  });

  it('toggle flips enabled', async () => {
    const box = [...host.querySelectorAll('label.check')].find((l) => l.textContent?.includes('with Claude'))!.querySelector('input')!;
    await act(async () => box.click());
    expect(useAiSettings.getState().enabled).toBe(true);
    expect(host.textContent).toContain('Nothing will happen until');
  });

  it('Test key is disabled with an empty key', () => {
    expect(testBtn().disabled).toBe(true);
  });
});

describe('testClaudeKey', () => {
  it('maps the CORS authentication error to the organisation message', async () => {
    const err = new Anthropic.AuthenticationError(401, undefined, 'CORS requests are not allowed for this Organization', new Headers());
    const { vi } = await import('vitest');
    const retrieve = vi
      .spyOn(Anthropic.Models.prototype, 'retrieve')
      .mockImplementation((() => Promise.reject(err)) as never);
    const r = await testClaudeKey('sk-ant-x', 'claude-haiku-5-5');
    retrieve.mockRestore();
    expect(r).toEqual({ ok: false, message: expect.stringContaining('organisation does not allow requests from a browser') });
  });

  it('maps a plain 401 to key rejected', async () => {
    const { vi } = await import('vitest');
    const retrieve = vi
      .spyOn(Anthropic.Models.prototype, 'retrieve')
      .mockImplementation((() => Promise.reject(new Anthropic.AuthenticationError(401, undefined, 'invalid x-api-key', new Headers()))) as never);
    const r = await testClaudeKey('sk-ant-x', 'claude-haiku-5-5');
    retrieve.mockRestore();
    expect(r).toEqual({ ok: false, message: 'Key rejected by Anthropic.' });
  });
});
