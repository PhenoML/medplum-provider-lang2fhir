// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type {
  Coding,
  Encounter,
  Patient,
  Questionnaire,
  QuestionnaireResponse,
  QuestionnaireResponseItem,
  QuestionnaireResponseItemAnswer,
  Reference,
} from '@medplum/fhirtypes';
import { getAnswerableItems, valueTypesFor } from './buildProfile';

/**
 * Post-validation of the lang2fhir output. The profile constrains the model on the server side; this
 * treats the returned QuestionnaireResponse as untrusted and:
 *  - guards the resourceType,
 *  - compares every answer against the deterministic question map (built from the Questionnaire),
 *    collecting warnings for type mismatches, coded answers outside the allowed set, and invented
 *    linkIds not in the form,
 *  - normalizes a matched coded/string answer onto the source answerOption's canonical Coding so the
 *    Medplum QuestionnaireForm renders it and scoring resolves (the selected option is unchanged),
 *  - stamps the FHIR-required fields (status, authored, questionnaire) and links subject/encounter.
 *
 * It does not rebuild the response from the Questionnaire or invent answers — unmatched items are
 * kept as-is and surfaced as warnings for the clinician to correct in the editable form.
 */

export interface PostValidateInput {
  patient?: Patient;
  encounter?: Reference<Encounter>;
}

export interface PostValidateResult {
  response: QuestionnaireResponse;
  warnings: string[];
}

interface QuestionInfo {
  type?: string;
  valueTypes: string[];
  /** allowed answer code -> canonical Coding from the source answerOption */
  codings: Map<string, Coding>;
  /** normalized display text -> answer code, for matching model output given as text */
  displaysToCode: Map<string, string>;
}

const norm = (value: string): string => value.trim().toLowerCase();

function buildQuestionMap(questionnaire: Questionnaire): Map<string, QuestionInfo> {
  const map = new Map<string, QuestionInfo>();
  for (const item of getAnswerableItems(questionnaire)) {
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
    map.set(item.linkId, { type: item.type, valueTypes: valueTypesFor(item), codings, displaysToCode });
  }
  return map;
}

// Attempts to resolve a raw answer against a coded question's allowed options. Returns the canonical
// Coding when the model's code/display/string unambiguously matches one; undefined otherwise.
function resolveCoding(info: QuestionInfo, answer: QuestionnaireResponseItemAnswer): Coding | undefined {
  const code = answer.valueCoding?.code;
  if (code && info.codings.has(code)) {
    return info.codings.get(code);
  }
  const candidates = [answer.valueCoding?.display, answer.valueString].filter(
    (value): value is string => Boolean(value)
  );
  for (const candidate of candidates) {
    const byCode = info.codings.get(candidate);
    if (byCode) {
      return byCode;
    }
    const mappedCode = info.displaysToCode.get(norm(candidate));
    if (mappedCode) {
      return info.codings.get(mappedCode);
    }
  }
  return undefined;
}

function validateAnswers(
  linkId: string,
  info: QuestionInfo,
  answers: QuestionnaireResponseItemAnswer[],
  warnings: string[]
): QuestionnaireResponseItemAnswer[] {
  const codedQuestion = info.valueTypes.includes('Coding');
  return answers.map((answer) => {
    if (codedQuestion) {
      const coding = resolveCoding(info, answer);
      if (coding) {
        return { valueCoding: coding };
      }
      const seen = answer.valueCoding?.code ?? answer.valueString ?? '(no value)';
      warnings.push(`Answer "${seen}" for "${linkId}" is not one of the allowed codes; left for review.`);
      return answer;
    }
    // Non-coded questions: tolerate valueString flex and numeric-as-Quantity, warn on clear mismatch.
    const hasExpectedType = info.valueTypes.some((type) => `value${type.charAt(0).toUpperCase()}${type.slice(1)}` in answer);
    const numericAsQuantity =
      info.valueTypes.includes('Quantity') &&
      (typeof answer.valueDecimal === 'number' || typeof answer.valueInteger === 'number');
    if (!hasExpectedType && answer.valueString === undefined && !numericAsQuantity) {
      warnings.push(`Answer for "${linkId}" has an unexpected type (expected ${info.valueTypes.join('/')}).`);
    }
    return answer;
  });
}

function validateItems(
  items: QuestionnaireResponseItem[] | undefined,
  qmap: Map<string, QuestionInfo>,
  warnings: string[]
): QuestionnaireResponseItem[] {
  return (items ?? []).map((item) => {
    const info = item.linkId ? qmap.get(item.linkId) : undefined;
    if (item.linkId && !info) {
      warnings.push(`Response references linkId "${item.linkId}" that is not in the questionnaire; left for review.`);
    }
    return {
      ...item,
      ...(info && item.answer ? { answer: validateAnswers(item.linkId, info, item.answer, warnings) } : {}),
      ...(item.item ? { item: validateItems(item.item, qmap, warnings) } : {}),
    };
  });
}

export function postValidate(
  raw: QuestionnaireResponse | undefined,
  questionnaire: Questionnaire,
  input: PostValidateInput
): PostValidateResult {
  const warnings: string[] = [];

  if (raw?.resourceType !== 'QuestionnaireResponse') {
    warnings.push(`Expected a QuestionnaireResponse from lang2fhir but got "${raw?.resourceType ?? 'nothing'}".`);
    raw = { resourceType: 'QuestionnaireResponse', status: 'in-progress' };
  }

  const qmap = buildQuestionMap(questionnaire);
  const items = validateItems(raw.item, qmap, warnings);

  const response: QuestionnaireResponse = {
    ...raw,
    resourceType: 'QuestionnaireResponse',
    status: 'in-progress',
    questionnaire: questionnaire.url ?? raw.questionnaire,
    authored: raw.authored ?? new Date().toISOString(),
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

  return { response, warnings };
}
