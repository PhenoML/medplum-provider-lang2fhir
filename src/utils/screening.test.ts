// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { Questionnaire, QuestionnaireItemAnswerOption, QuestionnaireResponse } from '@medplum/fhirtypes';
import { describe, expect, test } from 'vitest';
import {
  GAD7_QUESTIONNAIRE_URL,
  ORDINAL_VALUE_EXTENSION_URL,
  PHQ9_QUESTIONNAIRE_URL,
  SCREENING_QUESTIONNAIRE_URLS,
  scoreQuestionnaireResponse,
} from './screening';

function option(code: string, display: string, score: number): QuestionnaireItemAnswerOption {
  return {
    valueCoding: { system: 'http://loinc.org', code, display },
    extension: [{ url: ORDINAL_VALUE_EXTENSION_URL, valueDecimal: score }],
  };
}

const questionnaire: Questionnaire = {
  resourceType: 'Questionnaire',
  status: 'active',
  url: GAD7_QUESTIONNAIRE_URL,
  item: [
    {
      linkId: 'q1',
      text: 'Q1',
      type: 'choice',
      answerOption: [
        option('LA6568-5', 'Not at all', 0),
        option('LA6569-3', 'Several days', 1),
        option('LA6570-1', 'More than half the days', 2),
        option('LA6571-9', 'Nearly every day', 3),
      ],
    },
    {
      linkId: 'q2',
      text: 'Q2',
      type: 'choice',
      answerOption: [
        option('LA6568-5', 'Not at all', 0),
        option('LA6571-9', 'Nearly every day', 3),
      ],
    },
  ],
};

describe('screening constants', () => {
  test('exposes canonical URLs in display order', () => {
    expect(SCREENING_QUESTIONNAIRE_URLS).toEqual([GAD7_QUESTIONNAIRE_URL, PHQ9_QUESTIONNAIRE_URL]);
  });
});

describe('scoreQuestionnaireResponse', () => {
  test('sums the ordinal scores of selected answers', () => {
    const response: QuestionnaireResponse = {
      resourceType: 'QuestionnaireResponse',
      status: 'in-progress',
      item: [
        { linkId: 'q1', answer: [{ valueCoding: { code: 'LA6570-1' } }] }, // 2
        { linkId: 'q2', answer: [{ valueCoding: { code: 'LA6571-9' } }] }, // 3
      ],
    };
    expect(scoreQuestionnaireResponse(response, questionnaire)).toBe(5);
  });

  test('returns 0 when nothing is answered', () => {
    const response: QuestionnaireResponse = {
      resourceType: 'QuestionnaireResponse',
      status: 'in-progress',
      item: [{ linkId: 'q1' }, { linkId: 'q2' }],
    };
    expect(scoreQuestionnaireResponse(response, questionnaire)).toBe(0);
  });

  test('skips answers whose code is not a known option', () => {
    const response: QuestionnaireResponse = {
      resourceType: 'QuestionnaireResponse',
      status: 'in-progress',
      item: [
        { linkId: 'q1', answer: [{ valueCoding: { code: 'UNKNOWN' } }] },
        { linkId: 'q2', answer: [{ valueCoding: { code: 'LA6571-9' } }] }, // 3
      ],
    };
    expect(scoreQuestionnaireResponse(response, questionnaire)).toBe(3);
  });
});
