// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { Questionnaire, QuestionnaireItem, QuestionnaireResponse } from '@medplum/fhirtypes';

// Shared constants + helpers for the Phase 2 visit-scribe screening flow (GAD-7 / PHQ-9).
//
// NOTE: the scribe-fill bot (src/bots/scribe-fill.ts) cannot import from src/utils (its tsconfig
// rootDir is src/bots), so it defines matching constants inline. Keep them in sync.

// Canonical URLs for the seeded screening Questionnaires (see src/data/screening-questionnaires-bundle.json).
export const GAD7_QUESTIONNAIRE_URL = 'https://www.medplum.com/questionnaire/gad-7';
export const PHQ9_QUESTIONNAIRE_URL = 'https://www.medplum.com/questionnaire/phq-9';

// Standard FHIR extension carrying the numeric score (0-3) of each answerOption.
export const ORDINAL_VALUE_EXTENSION_URL = 'http://hl7.org/fhir/StructureDefinition/ordinalValue';

// The screening questionnaires the Scribe tab pre-fills, in display order.
export const SCREENING_QUESTIONNAIRE_URLS = [GAD7_QUESTIONNAIRE_URL, PHQ9_QUESTIONNAIRE_URL] as const;

// Builds a lookup of linkId -> (answer code -> ordinal score) from a Questionnaire's answerOptions.
function buildScoreLookup(questionnaire: Questionnaire): Map<string, Map<string, number>> {
  const lookup = new Map<string, Map<string, number>>();
  const walk = (items: QuestionnaireItem[] | undefined): void => {
    for (const item of items ?? []) {
      if (item.linkId && item.answerOption) {
        const answers = new Map<string, number>();
        for (const option of item.answerOption) {
          const code = option.valueCoding?.code;
          if (!code) {
            continue;
          }
          const ordinal = option.extension?.find((e) => e.url === ORDINAL_VALUE_EXTENSION_URL)?.valueDecimal;
          answers.set(code, ordinal ?? Number.NaN);
        }
        lookup.set(item.linkId, answers);
      }
      walk(item.item);
    }
  };
  walk(questionnaire.item);
  return lookup;
}

// Sums the ordinal scores of the selected answers in a screening QuestionnaireResponse. Scores come
// from each answerOption's ordinalValue extension on the source Questionnaire; answers without a
// resolvable score (unknown code, or an answerOption missing the extension) are skipped.
export function scoreQuestionnaireResponse(
  response: QuestionnaireResponse,
  questionnaire: Questionnaire
): number {
  const lookup = buildScoreLookup(questionnaire);
  let total = 0;
  const walk = (items: QuestionnaireResponse['item']): void => {
    for (const item of items ?? []) {
      if (item.linkId) {
        const answers = lookup.get(item.linkId);
        for (const answer of item.answer ?? []) {
          const code = answer.valueCoding?.code;
          const score = code !== undefined ? answers?.get(code) : undefined;
          if (score !== undefined && Number.isFinite(score)) {
            total += score;
          }
        }
      }
      walk(item.item);
    }
  };
  walk(response.item);
  return total;
}
