// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { Questionnaire, QuestionnaireResponse } from '@medplum/fhirtypes';
import { describe, expect, test } from 'vitest';
import { postValidate } from './postValidate';

const ORDINAL = 'http://hl7.org/fhir/StructureDefinition/ordinalValue';

const questionnaire: Questionnaire = {
  resourceType: 'Questionnaire',
  status: 'active',
  url: 'https://www.medplum.com/questionnaire/gad-7',
  title: 'GAD-7',
  item: [
    {
      linkId: 'gad7-q1',
      text: 'Feeling nervous',
      type: 'choice',
      answerOption: [
        { valueCoding: { system: 'http://loinc.org', code: 'LA6568-5', display: 'Not at all' }, extension: [{ url: ORDINAL, valueDecimal: 0 }] },
        { valueCoding: { system: 'http://loinc.org', code: 'LA6569-3', display: 'Several days' }, extension: [{ url: ORDINAL, valueDecimal: 1 }] },
      ],
    },
  ],
};

describe('postValidate', () => {
  test('enriches a matched code to the canonical coding and stamps required fields', () => {
    const raw: QuestionnaireResponse = {
      resourceType: 'QuestionnaireResponse',
      status: 'in-progress',
      item: [{ linkId: 'gad7-q1', answer: [{ valueCoding: { code: 'LA6569-3' } }] }],
    };
    const { response, warnings } = postValidate(raw, questionnaire, {
      patient: { resourceType: 'Patient', id: 'p1', name: [{ text: 'Jane Doe' }] },
      encounter: { reference: 'Encounter/e1' },
    });

    expect(warnings).toHaveLength(0);
    expect(response.questionnaire).toBe(questionnaire.url);
    expect(response.status).toBe('in-progress');
    expect(response.subject).toEqual({ reference: 'Patient/p1', display: 'Jane Doe' });
    expect(response.encounter).toEqual({ reference: 'Encounter/e1' });
    expect(response.authored).toBeDefined();
    expect(response.item?.[0].answer?.[0].valueCoding).toEqual({ system: 'http://loinc.org', code: 'LA6569-3', display: 'Several days' });
  });

  test('maps a coded answer given as display text', () => {
    const raw: QuestionnaireResponse = {
      resourceType: 'QuestionnaireResponse',
      status: 'in-progress',
      item: [{ linkId: 'gad7-q1', answer: [{ valueString: 'Several days' }] }],
    };
    const { response, warnings } = postValidate(raw, questionnaire, {});
    expect(warnings).toHaveLength(0);
    expect(response.item?.[0].answer?.[0].valueCoding?.code).toBe('LA6569-3');
  });

  test('warns on a code outside the allowed set but keeps the answer', () => {
    const raw: QuestionnaireResponse = {
      resourceType: 'QuestionnaireResponse',
      status: 'in-progress',
      item: [{ linkId: 'gad7-q1', answer: [{ valueCoding: { code: 'NOT-A-CODE' } }] }],
    };
    const { response, warnings } = postValidate(raw, questionnaire, {});
    expect(warnings.some((w) => /not one of the allowed codes/i.test(w))).toBe(true);
    expect(response.item?.[0].answer?.[0].valueCoding?.code).toBe('NOT-A-CODE');
  });

  test('warns on invented linkIds not in the form', () => {
    const raw: QuestionnaireResponse = {
      resourceType: 'QuestionnaireResponse',
      status: 'in-progress',
      item: [{ linkId: 'made-up', answer: [{ valueString: 'x' }] }],
    };
    const { warnings } = postValidate(raw, questionnaire, {});
    expect(warnings.some((w) => /not in the questionnaire/i.test(w))).toBe(true);
  });

  test('guards a non-QuestionnaireResponse resourceType', () => {
    const { response, warnings } = postValidate(
      { resourceType: 'Patient' } as unknown as QuestionnaireResponse,
      questionnaire,
      {}
    );
    expect(response.resourceType).toBe('QuestionnaireResponse');
    expect(warnings.some((w) => /Expected a QuestionnaireResponse/i.test(w))).toBe(true);
  });
});
