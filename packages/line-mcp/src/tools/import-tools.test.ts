import { describe, expect, it } from 'vitest';
import { translateOutcome } from './import-tools';

describe('complete_import success translation', () => {
  it('reports parsed and newly imported counts separately', () => {
    const result = translateOutcome({
      kind: 'success',
      parsed: 3,
      imported: 1,
      chat_mid: 'chat-1',
      chat_name: 'Test Chat',
      date_range: null,
    });

    expect(JSON.parse(result.content[0].text)).toEqual({
      status: 'success',
      parsed: 3,
      imported: 1,
      chat_mid: 'chat-1',
      chat_name: 'Test Chat',
      date_range: null,
    });
  });
});
