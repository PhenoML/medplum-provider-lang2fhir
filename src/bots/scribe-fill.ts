// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { BotEvent, MedplumClient } from '@medplum/core';
import type {
  Encounter,
  Patient,
  Questionnaire,
  QuestionnaireResponse,
  Reference,
  StructureDefinition,
} from '@medplum/fhirtypes';
import { Buffer } from 'buffer';
import { phenomlClient } from 'phenoml';
import {
  buildQuestionnaireResponseProfile,
  composeExtractionText,
  IMPLEMENTATION_GUIDE,
  profileContextFor,
} from './buildProfile';
import { postValidate } from './postValidate';

/**
 * A Medplum Bot that pre-fills a screening Questionnaire (e.g. GAD-7 / PHQ-9) from a visit
 * transcript by conforming lang2fhir output to an auto-generated QuestionnaireResponse profile.
 *
 * Pipeline:
 *   1. buildQuestionnaireResponseProfile(questionnaire) — deterministically synthesize a
 *      StructureDefinition that profiles QuestionnaireResponse for this exact form (pure code).
 *   2. Ensure the profile exists in Medplum — look it up by content-derived url; if it does not
 *      match deterministically, create it on the fly so profiles are cached/inspectable.
 *   3. Register the profile with PhenoML via lang2Fhir.uploadProfile (once per warm session;
 *      "already exists" is treated as success).
 *   4. lang2Fhir.create({ resource: <profileId>, text }) — conform the output to the profile. The
 *      text embeds a compact "question key" (linkId/text/type/allowed codes) ahead of the transcript.
 *   5. postValidate — treat the model output as untrusted: validate against the questionnaire, stamp
 *      required fields, and return the QuestionnaireResponse for clinician review/edit.
 *
 * Like the Phase 1 referral-intake bot, this bot does NOT persist the QuestionnaireResponse — the UI
 * saves it at sign-off.
 *
 * Required bot secrets: (You need to have an active PhenoML subscription to use this bot)
 * - PHENOML_CLIENT_ID: Your PhenoML API client id
 * - PHENOML_CLIENT_SECRET: Your PhenoML API client secret
 * Optional bot secret:
 * - PHENOML_BASE_URL: Your PhenoML environment base URL. Defaults to https://experiment.app.pheno.ml.
 */

export interface ScribeFillInput {
  transcript: string;
  questionnaire: Questionnaire;
  patient?: Patient;
  encounter?: Reference<Encounter>;
}

const DEFAULT_PHENOML_BASE_URL = 'https://experiment.app.pheno.ml';

// Profiles uploaded during this (warm) Lambda invocation, so a repeated call in the same session
// doesn't re-upload. Cold starts reset this — the "already exists" path below handles re-uploads.
const uploadedProfiles = new Set<string>();

// A PhenoML "profile already exists" rejection means the upload succeeded on a prior call — treat as
// success rather than failing the whole fill.
function isDuplicateProfileError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /already\s+(exists|been\s+uploaded)|duplicate/i.test(message);
}

// Looks up the profile in Medplum by its content-derived canonical URL. If no profile matches
// deterministically, creates it on the fly so it is cached and inspectable in Medplum.
async function ensureProfileInMedplum(medplum: MedplumClient, profile: StructureDefinition): Promise<void> {
  const existing = await medplum.searchOne('StructureDefinition', { url: profile.url });
  if (!existing) {
    await medplum.createResource(profile);
  }
}

// Registers the profile with PhenoML so create() can target it. Idempotent within a session and
// tolerant of "already exists" across cold starts.
async function ensureProfileUploaded(
  client: InstanceType<typeof phenomlClient>,
  profile: StructureDefinition,
  questionnaire: Questionnaire
): Promise<void> {
  const id = profile.id as string;
  if (uploadedProfiles.has(id)) {
    return;
  }
  const encoded = Buffer.from(JSON.stringify(profile)).toString('base64');
  try {
    await client.lang2Fhir.uploadProfile({
      profile: encoded,
      implementation_guide: IMPLEMENTATION_GUIDE,
      profile_context: profileContextFor(questionnaire),
    });
  } catch (error) {
    if (!isDuplicateProfileError(error)) {
      throw error;
    }
  }
  uploadedProfiles.add(id);
}

// Calls lang2fhir/create against the custom profile. Falls back to the generic questionnaireresponse
// profile (same prompt text, which already carries the question key) if the custom profile can't be
// used — e.g. an account tier without custom profiles — so the flow still returns a usable response.
async function createConformed(
  client: InstanceType<typeof phenomlClient>,
  profileId: string,
  text: string
): Promise<QuestionnaireResponse> {
  type CreateRequest = Parameters<typeof client.lang2Fhir.create>[0];
  try {
    return (await client.lang2Fhir.create({
      version: 'R4',
      resource: profileId,
      text,
    } as unknown as CreateRequest)) as unknown as QuestionnaireResponse;
  } catch (error) {
    console.warn(
      `lang2fhir create against profile "${profileId}" failed; falling back to generic questionnaireresponse: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return (await client.lang2Fhir.create({
      version: 'R4',
      resource: 'questionnaireresponse',
      text,
    })) as unknown as QuestionnaireResponse;
  }
}

export async function handler(
  medplum: MedplumClient,
  event: BotEvent<ScribeFillInput>
): Promise<QuestionnaireResponse> {
  try {
    const { transcript, questionnaire, patient, encounter } = event.input;

    if (!transcript?.trim()) {
      throw new Error('No transcript provided to bot');
    }
    if (!questionnaire?.item?.length) {
      throw new Error('A target Questionnaire (with items) is required');
    }

    const clientId = event.secrets['PHENOML_CLIENT_ID']?.valueString;
    const clientSecret = event.secrets['PHENOML_CLIENT_SECRET']?.valueString;
    if (!clientId || !clientSecret) {
      throw new Error('PhenoML credentials (PHENOML_CLIENT_ID and PHENOML_CLIENT_SECRET) are required');
    }
    const baseUrl = event.secrets['PHENOML_BASE_URL']?.valueString ?? DEFAULT_PHENOML_BASE_URL;

    // The SDK handles OAuth client-credentials auth automatically.
    const client = new phenomlClient({ clientId, clientSecret, baseUrl });

    // 1. Deterministically build the QR profile from the questionnaire.
    const profile = buildQuestionnaireResponseProfile(questionnaire);

    // 2. Cache the profile in Medplum (created on the fly when it doesn't already match).
    await ensureProfileInMedplum(medplum, profile);

    // 3. Register the profile with PhenoML.
    await ensureProfileUploaded(client, profile, questionnaire);

    // 4. Conform the transcript to the profile.
    const text = composeExtractionText(transcript, questionnaire);
    const raw = await createConformed(client, profile.id as string, text);

    // 5. Validate/stamp and return for review (never persisted here).
    const { response, warnings } = postValidate(raw, questionnaire, { patient, encounter });
    if (warnings.length) {
      console.warn(`scribe-fill post-validation warnings for ${profile.id}:\n- ${warnings.join('\n- ')}`);
    }
    return response;
  } catch (error) {
    throw new Error(`Bot execution failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
