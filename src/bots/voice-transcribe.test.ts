// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { BotEvent, MedplumClient } from '@medplum/core';
import { Buffer } from 'buffer';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { VoiceTranscribeInput } from './voice-transcribe';
import { handler } from './voice-transcribe';

// Mock the PhenoML SDK so no network call is made; the bot uses phenomlClient().voice.voice.transcribe.
const { mockTranscribe } = vi.hoisted(() => ({ mockTranscribe: vi.fn() }));
vi.mock('phenoml', () => ({
  phenomlClient: class {
    voice = { voice: { transcribe: mockTranscribe } };
  },
}));

function makeEvent(input: VoiceTranscribeInput): BotEvent<VoiceTranscribeInput> {
  return {
    input,
    secrets: {
      PHENOML_CLIENT_ID: { name: 'PHENOML_CLIENT_ID', valueString: 'id' },
      PHENOML_CLIENT_SECRET: { name: 'PHENOML_CLIENT_SECRET', valueString: 'secret' },
    },
  } as unknown as BotEvent<VoiceTranscribeInput>;
}

const medplum = {} as unknown as MedplumClient;

describe('voice-transcribe handler', () => {
  beforeEach(() => {
    mockTranscribe.mockReset();
  });

  test('throws when audio is missing', async () => {
    await expect(handler(medplum, makeEvent({ audio: '' }))).rejects.toThrow(/No audio/);
  });

  test('throws when PhenoML credentials are missing', async () => {
    const event = { input: { audio: 'aGVsbG8=' }, secrets: {} } as unknown as BotEvent<VoiceTranscribeInput>;
    await expect(handler(medplum, event)).rejects.toThrow(/PhenoML credentials/);
  });

  test('decodes the audio and returns the transcript', async () => {
    mockTranscribe.mockResolvedValue({ transcript: 'patient reports feeling anxious' });

    const audio = Buffer.from('fake-audio-bytes').toString('base64');
    const result = await handler(medplum, makeEvent({ audio, contentType: 'audio/webm', language: 'en-US' }));

    expect(result).toEqual({ transcript: 'patient reports feeling anxious' });
    expect(mockTranscribe).toHaveBeenCalledTimes(1);
    const [uploadable, request] = mockTranscribe.mock.calls[0];
    expect(uploadable).toEqual({ data: Buffer.from('fake-audio-bytes'), contentType: 'audio/webm' });
    expect(request).toEqual({ language: 'en-US' });
  });

  test('passes the raw buffer when no content type is given', async () => {
    mockTranscribe.mockResolvedValue({ transcript: 'hello' });

    const audio = Buffer.from('abc').toString('base64');
    await handler(medplum, makeEvent({ audio }));

    const [uploadable, request] = mockTranscribe.mock.calls[0];
    expect(Buffer.isBuffer(uploadable)).toBe(true);
    expect(uploadable).toEqual(Buffer.from('abc'));
    expect(request).toEqual({});
  });
});
