// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { BotEvent, MedplumClient } from '@medplum/core';
import type {
  Coding,
  Encounter,
  Patient,
  Questionnaire,
  QuestionnaireResponse,
  QuestionnaireResponseItem,
  QuestionnaireResponseItemAnswer,
  Reference,
  StructureDefinition,
} from '@medplum/fhirtypes';
import { Buffer } from 'buffer';
import { phenomlClient } from 'phenoml';
import {
  buildQuestionnaireResponseProfile,
  composeExtractionText,
  getAnswerableItems,
  IMPLEMENTATION_GUIDE,
  profileContextFor,
  valueTypesFor,
} from './buildProfile';

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
 *   5. finalizeResponse — enrich each answer to its canonical answerOption Coding (so the Medplum
 *      QuestionnaireForm pre-selects it and scoring resolves) and stamp the required fields, returning
 *      the QuestionnaireResponse for clinician review/edit.
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

// Allowed answer codings for a single coded question, keyed for lookup by code or by display text.
interface CodedInfo {
  codings: Map<string, Coding>;
  displaysToCode: Map<string, string>;
}

const norm = (value: string): string => value.trim().toLowerCase();

// Maps each coded question's linkId to its allowed answerOption codings (built from the Questionnaire).
function buildCodedMap(questionnaire: Questionnaire): Map<string, CodedInfo> {
  const map = new Map<string, CodedInfo>();
  for (const item of getAnswerableItems(questionnaire)) {
    if (!valueTypesFor(item).includes('Coding')) {
      continue;
    }
    const codings = new Map<string, Coding>();
    const displaysToCode = new Map<string, string>();
    for (const opt of item.answerOption ?? []) {
      const coding = opt.valueCoding;
      if (coding?.code) {
        codings.set(coding.code, coding);
        if (coding.display) {
          displaysToCode.set(norm(coding.display), coding.code);
        }
      }
    }
    map.set(item.linkId, { codings, displaysToCode });
  }
  return map;
}

// Enriches a model answer to the questionnaire's canonical Coding when its code/display/string
// matches an allowed option. Unmatched answers are returned unchanged for the clinician to correct.
function enrichAnswer(info: CodedInfo, answer: QuestionnaireResponseItemAnswer): QuestionnaireResponseItemAnswer {
  const byCode = answer.valueCoding?.code ? info.codings.get(answer.valueCoding.code) : undefined;
  if (byCode) {
    return { valueCoding: byCode };
  }
  const candidates = [answer.valueCoding?.display, answer.valueString].filter((v): v is string => Boolean(v));
  for (const candidate of candidates) {
    const exact = info.codings.get(candidate);
    if (exact) {
      return { valueCoding: exact };
    }
    const mappedCode = info.displaysToCode.get(norm(candidate));
    const byDisplay = mappedCode ? info.codings.get(mappedCode) : undefined;
    if (byDisplay) {
      return { valueCoding: byDisplay };
    }
  }
  return answer;
}

function enrichItems(
  items: QuestionnaireResponseItem[] | undefined,
  codedMap: Map<string, CodedInfo>
): QuestionnaireResponseItem[] {
  return (items ?? []).map((item) => {
    const info = item.linkId ? codedMap.get(item.linkId) : undefined;
    return {
      ...item,
      ...(info && item.answer ? { answer: item.answer.map((answer) => enrichAnswer(info, answer)) } : {}),
      ...(item.item ? { item: enrichItems(item.item, codedMap) } : {}),
    };
  });
}

// Enriches answers to canonical codings and stamps the FHIR-required fields (status, questionnaire,
// authored) plus subject/encounter links. The profile already conforms the model output on the server
// side; this trusts it and only normalizes codings + fills required fields for the review form.
function finalizeResponse(
  raw: QuestionnaireResponse | undefined,
  questionnaire: Questionnaire,
  input: { patient?: Patient; encounter?: Reference<Encounter> }
): QuestionnaireResponse {
  const source: QuestionnaireResponse =
    raw?.resourceType === 'QuestionnaireResponse' ? raw : { resourceType: 'QuestionnaireResponse', status: 'in-progress' };
  const items = enrichItems(source.item, buildCodedMap(questionnaire));

  return {
    ...source,
    resourceType: 'QuestionnaireResponse',
    status: 'in-progress',
    questionnaire: questionnaire.url ?? source.questionnaire,
    authored: source.authored ?? new Date().toISOString(),
    ...(input.patient
      ? {
          subject: {
            reference: `Patient/${input.patient.id}`,
            display: input.patient.name?.[0]?.text ?? `Patient/${input.patient.id}`,
          },
        }
      : {}),
    ...(input.encounter ? { encounter: input.encounter } : {}),
    ...(items.length ? { item: items } : {}),
  };
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

    // 5. Enrich answers to canonical codings, stamp required fields, and return for review (never
    // persisted here).
    return finalizeResponse(raw, questionnaire, { patient, encounter });
  } catch (error) {
    throw new Error(`Bot execution failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
