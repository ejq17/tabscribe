import Anthropic from '@anthropic-ai/sdk';
import type { ClaudeModel } from './settings';

export type TestKeyResult = { ok: true } | { ok: false; message: string };

/** Verify a key by retrieving model metadata (no tokens are billed). */
export async function testClaudeKey(apiKey: string, model: ClaudeModel): Promise<TestKeyResult> {
  try {
    const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
    await client.models.retrieve(model);
    return { ok: true };
  } catch (e) {
    return { ok: false, message: describeError(e) };
  }
}

function describeError(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) {
    // the SDK prefixes the status code ('401 CORS requests ...'), so match anywhere rather than at the start
    if (/CORS requests are not allowed/.test(`${e.apiMessage ?? ''} ${e.message}`)) {
      return 'Your Anthropic organisation does not allow requests from a browser (zero data retention or Compliance API is enabled). Use a key from a different organisation.';
    }
    return 'Key rejected by Anthropic.';
  }
  if (e instanceof Anthropic.PermissionDeniedError) return 'This key cannot use that model.';
  if (e instanceof Anthropic.APIConnectionError) return 'Could not reach Anthropic. Check your connection.';
  if (e instanceof Anthropic.APIError) return e.message;
  return 'Unexpected error';
}
