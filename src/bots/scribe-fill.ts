// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { BotEvent, MedplumClient } from '@medplum/core';
import type {
  Encounter,
  Patient,
  Questionnaire,
  QuestionnaireItem,
  QuestionnaireResponse,
  QuestionnaireResponseItem,
  QuestionnaireResponseItemAnswer,
  Reference,
} from '@medplum/fhirtypes';
import { phenomlClient } from 'phenoml';

/**
 * A Medplum Bot that pre-fills a screening Questionnaire (e.g. GAD-7 / PHQ-9) from a visit
 * transcript using the PhenoML lang2fhir create API.
 *
 * This is a thin wrapper over the same lang2fhir/create call that lang2fhir-create uses: the SDK's
 * create request only accepts { version, resource, text }, with no field for the target
 * Questionnaire, so this bot shapes a prompt that embeds the questionnaire's items, linkIds, and
 * scored answer options alongside the transcript. It then reconciles the model's answers back onto
 * the source questionnaire so the returned QuestionnaireResponse uses the exact linkIds and answer
 * codes the QuestionnaireForm expects.
 *
 * Like the Phase 1 referral-intake bot, this bot does NOT persist anything — it returns the
 * QuestionnaireResponse for clinician review/edit, and the UI saves it at sign-off.
 *
 * Required bot secrets: (You need to have an active PhenoML subscription to use this bot)
 * - PHENOML_CLIENT_ID: Your PhenoML API client id
 * - PHENOML_CLIENT_SECRET: Your PhenoML API client secret
 * Optional bot secret:
 * - PHENOML_BASE_URL: Your PhenoML environment base URL. Defaults to https://experiment.app.pheno.ml.
 */

interface ScribeFillInput {
  transcript: string;
  questionnaire: Questionnaire;
  patient?: Patient;
  encounter?: Reference<Encounter>;
}

const DEFAULT_PHENOML_BASE_URL = 'https://experiment.app.pheno.ml';
// Standard FHIR extension carrying the numeric score of each answerOption (keep in sync with
// src/utils/screening.ts — bots cannot import from src/utils).
const ORDINAL_VALUE_EXTENSION_URL = 'http://hl7.org/fhir/StructureDefinition/ordinalValue';

// Returns the leaf choice items (the scorable questions) of a questionnaire, depth-first.
function getChoiceItems(questionnaire: Questionnaire): QuestionnaireItem[] {
  const result: QuestionnaireItem[] = [];
  const walk = (items: QuestionnaireItem[] | undefined): void => {
    for (const item of items ?? []) {
      if (item.answerOption?.length && item.linkId) {
        result.push(item);
      }
      walk(item.item);
    }
  };
  walk(questionnaire.item);
  return result;
}

// Builds the natural-language prompt sent to lang2fhir. It lists every question with its linkId and
// the allowed answer options (code, label, and score) and instructs the model to pick, for each
// question, the option best supported by the transcript.
export function buildScribePrompt(transcript: string, questionnaire: Questionnaire): string {
  const items = getChoiceItems(questionnaire);
  const questionLines = items.map((item) => {
    const options = (item.answerOption ?? [])
      .map((opt) => {
        const code = opt.valueCoding?.code ?? '';
        const label = opt.valueCoding?.display ?? '';
        const score = opt.extension?.find((e) => e.url === ORDINAL_VALUE_EXTENSION_URL)?.valueDecimal;
        return `      - code "${code}": "${label}"${score !== undefined ? ` (score ${score})` : ''}`;
      })
      .join('\n');
    return `  linkId "${item.linkId}": ${item.text ?? ''}\n${options}`;
  });

  return [
    `You are a clinical scribe filling out the "${questionnaire.title ?? questionnaire.name ?? 'screening'}" questionnaire from a visit transcript.`,
    `Produce a FHIR QuestionnaireResponse. For every question below, choose exactly one answer option whose meaning is best supported by the transcript. Use the given linkId and the option's coding code verbatim. If the transcript gives no evidence for a question, choose the lowest-severity ("Not at all") option.`,
    ``,
    `Questions:`,
    ...questionLines,
    ``,
    `Transcript:`,
    transcript,
  ].join('\n');
}

// Normalizes a raw answer (however the model expressed it) to one of the item's answerOptions.
function matchAnswerOption(
  item: QuestionnaireItem,
  rawAnswers: QuestionnaireResponseItemAnswer[] | undefined
): QuestionnaireResponseItemAnswer | undefined {
  const options = item.answerOption ?? [];
  const raw = rawAnswers?.[0];
  if (!raw) {
    return undefined;
  }
  // Candidate identifiers the model might have returned.
  const candidates: string[] = [];
  if (raw.valueCoding?.code) {
    candidates.push(raw.valueCoding.code);
  }
  if (raw.valueCoding?.display) {
    candidates.push(raw.valueCoding.display);
  }
  if (raw.valueString) {
    candidates.push(raw.valueString);
  }
  if (typeof raw.valueInteger === 'number') {
    candidates.push(String(raw.valueInteger));
  }
  if (typeof raw.valueDecimal === 'number') {
    candidates.push(String(raw.valueDecimal));
  }
  const norm = (s: string): string => s.trim().toLowerCase();
  const normalized = candidates.map(norm);

  const match = options.find((opt) => {
    const code = opt.valueCoding?.code;
    const display = opt.valueCoding?.display;
    const score = opt.extension?.find((e) => e.url === ORDINAL_VALUE_EXTENSION_URL)?.valueDecimal;
    return (
      (code && normalized.includes(norm(code))) ||
      (display && normalized.includes(norm(display))) ||
      (score !== undefined && normalized.includes(String(score)))
    );
  });

  return match?.valueCoding ? { valueCoding: match.valueCoding } : undefined;
}

// Rebuilds a clean QuestionnaireResponse from the source questionnaire and the model's raw response,
// guaranteeing valid linkIds and answer codes. Answers that cannot be matched to an option are left
// unanswered for the clinician to complete.
export function reconcileResponse(
  raw: QuestionnaireResponse | undefined,
  questionnaire: Questionnaire,
  input: Pick<ScribeFillInput, 'patient' | 'encounter'>
): QuestionnaireResponse {
  const rawByLinkId = new Map<string, QuestionnaireResponseItem>();
  const indexRaw = (items: QuestionnaireResponseItem[] | undefined): void => {
    for (const item of items ?? []) {
      if (item.linkId) {
        rawByLinkId.set(item.linkId, item);
      }
      indexRaw(item.item);
    }
  };
  indexRaw(raw?.item);

  const responseItems: QuestionnaireResponseItem[] = getChoiceItems(questionnaire).map((item) => {
    const rawItem = rawByLinkId.get(item.linkId);
    const answer = matchAnswerOption(item, rawItem?.answer);
    return {
      linkId: item.linkId,
      text: item.text,
      ...(answer ? { answer: [answer] } : {}),
    };
  });

  return {
    resourceType: 'QuestionnaireResponse',
    status: 'in-progress',
    questionnaire: questionnaire.url,
    ...(input.patient
      ? {
          subject: {
            reference: `Patient/${input.patient.id}`,
            display: input.patient.name?.[0]?.text ?? `Patient/${input.patient.id}`,
          },
        }
      : {}),
    ...(input.encounter ? { encounter: input.encounter } : {}),
    authored: new Date().toISOString(),
    item: responseItems,
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

    const text = buildScribePrompt(transcript, questionnaire);
    const generated = (await client.lang2Fhir.create({
      version: 'R4',
      resource: 'questionnaireresponse',
      text,
    })) as unknown as QuestionnaireResponse;

    return reconcileResponse(generated, questionnaire, { patient, encounter });
  } catch (error) {
    throw new Error(`Bot execution failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
