// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { BotEvent, MedplumClient } from '@medplum/core';
import { Buffer } from 'buffer';
import { phenomlClient } from 'phenoml';

/**
 * A Medplum Bot that transcribes an audio recording to text using the PhenoML voice API
 * (POST /transcribe, https://developer.pheno.ml/reference/transcribe).
 *
 * The browser captures audio and posts it here as base64 (PhenoML credentials must stay server-side,
 * so transcription cannot be called directly from the browser). The bot decodes the bytes and returns
 * the transcript for a downstream text step (e.g. the scribe-fill bot's lang2fhir/create call).
 *
 * The PhenoML voice API auto-detects the audio format (WAV, FLAC, MP3, OGG/WebM Opus) and supports
 * up to ~5 minutes of audio per request.
 *
 * Required bot secrets: (You need to have an active PhenoML subscription to use this bot)
 * - PHENOML_CLIENT_ID: Your PhenoML API client id
 * - PHENOML_CLIENT_SECRET: Your PhenoML API client secret
 * Optional bot secret:
 * - PHENOML_BASE_URL: Your PhenoML environment base URL. Defaults to https://experiment.app.pheno.ml.
 */

export interface VoiceTranscribeInput {
  /** Base64-encoded audio bytes (any format the PhenoML voice API accepts). */
  audio: string;
  /** MIME type of the audio, e.g. 'audio/webm' (optional; the API also auto-detects). */
  contentType?: string;
  /** BCP-47 language tag(s); defaults to en-US. */
  language?: string | string[];
}

interface VoiceTranscribeOutput {
  transcript: string;
}

const DEFAULT_PHENOML_BASE_URL = 'https://experiment.app.pheno.ml';

export async function handler(
  _medplum: MedplumClient,
  event: BotEvent<VoiceTranscribeInput>
): Promise<VoiceTranscribeOutput> {
  try {
    const { audio, contentType, language } = event.input;

    if (!audio) {
      throw new Error('No audio provided to bot');
    }

    const clientId = event.secrets['PHENOML_CLIENT_ID']?.valueString;
    const clientSecret = event.secrets['PHENOML_CLIENT_SECRET']?.valueString;
    if (!clientId || !clientSecret) {
      throw new Error('PhenoML credentials (PHENOML_CLIENT_ID and PHENOML_CLIENT_SECRET) are required');
    }
    const baseUrl = event.secrets['PHENOML_BASE_URL']?.valueString ?? DEFAULT_PHENOML_BASE_URL;

    // The SDK handles OAuth client-credentials auth automatically.
    const client = new phenomlClient({ clientId, clientSecret, baseUrl });

    const data = Buffer.from(audio, 'base64');
    const uploadable = contentType ? { data, contentType } : data;

    const response = await client.voice.voice.transcribe(uploadable, language ? { language } : {});

    return { transcript: response.transcript ?? '' };
  } catch (error) {
    throw new Error(`Bot execution failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
