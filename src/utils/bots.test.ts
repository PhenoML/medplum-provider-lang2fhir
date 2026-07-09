// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { MockClient } from '@medplum/mock';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { executeBotByName } from './bots';

describe('executeBotByName', () => {
  let medplum: MockClient;

  beforeEach(() => {
    medplum = new MockClient();
    vi.clearAllMocks();
  });

  test('looks up the bot by name and executes it with the given input', async () => {
    vi.spyOn(medplum, 'searchOne').mockResolvedValue({ resourceType: 'Bot', id: 'bot-123', name: 'scribe-soap-note' });
    const executeSpy = vi.spyOn(medplum, 'executeBot').mockResolvedValue({ ok: true });

    const result = await executeBotByName(medplum, 'scribe-soap-note', { transcript: 'hi' });

    expect(medplum.searchOne).toHaveBeenCalledWith('Bot', { name: 'scribe-soap-note' });
    expect(executeSpy).toHaveBeenCalledWith('bot-123', { transcript: 'hi' });
    expect(result).toEqual({ ok: true });
  });

  test('throws a helpful error when the bot is not deployed', async () => {
    vi.spyOn(medplum, 'searchOne').mockResolvedValue(undefined);

    await expect(executeBotByName(medplum, 'scribe-soap-note', {})).rejects.toThrow(/not found.*Deploy bots first/i);
  });
});
