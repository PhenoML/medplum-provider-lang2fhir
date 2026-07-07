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
    vi.spyOn(medplum, 'searchOne').mockResolvedValue({ resourceType: 'Bot', id: 'bot-123', name: 'scribe-fill' });
    const executeSpy = vi.spyOn(medplum, 'executeBot').mockResolvedValue({ ok: true });

    const result = await executeBotByName(medplum, 'scribe-fill', { transcript: 'hi' });

    expect(medplum.searchOne).toHaveBeenCalledWith('Bot', { name: 'scribe-fill' });
    expect(executeSpy).toHaveBeenCalledWith('bot-123', { transcript: 'hi' });
    expect(result).toEqual({ ok: true });
  });

  test('throws a helpful error when the bot is not deployed', async () => {
    vi.spyOn(medplum, 'searchOne').mockResolvedValue(undefined);

    await expect(executeBotByName(medplum, 'scribe-fill', {})).rejects.toThrow(/not found.*Deploy bots first/i);
  });
});
