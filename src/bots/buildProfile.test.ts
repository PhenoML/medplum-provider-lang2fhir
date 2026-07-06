// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { Questionnaire } from '@medplum/fhirtypes';
import { describe, expect, test } from 'vitest';
import {
  buildQuestionnaireResponseProfile,
  composeExtractionText,
  getAnswerableItems,
  profileIdFor,
  valueTypesFor,
} from './buildProfile';

const ORDINAL = 'http://hl7.org/fhir/StructureDefinition/ordinalValue';

const questionnaire: Questionnaire = {
  resourceType: 'Questionnaire',
  status: 'active',
  url: 'https://www.medplum.com/questionnaire/gad-7',
  title: 'GAD-7',
  item: [
    {
      linkId: 'group-1',
      text: 'Over the last 2 weeks',
      type: 'group',
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
    },
    { linkId: 'note', text: 'Clinician note', type: 'text' },
    { linkId: 'display-1', text: 'Instructions', type: 'display' },
  ],
};

describe('getAnswerableItems', () => {
  test('recurses into groups and skips group/display items', () => {
    const items = getAnswerableItems(questionnaire);
    expect(items.map((i) => i.linkId)).toEqual(['gad7-q1', 'note']);
  });
});

describe('valueTypesFor', () => {
  test('maps item types to FHIR value[x] types', () => {
    expect(valueTypesFor({ linkId: 'a', type: 'boolean' })).toEqual(['boolean']);
    expect(valueTypesFor({ linkId: 'b', type: 'decimal' })).toEqual(['decimal']);
    expect(valueTypesFor({ linkId: 'c', type: 'text' })).toEqual(['string']);
    expect(valueTypesFor({ linkId: 'd', type: 'choice', answerOption: [{ valueCoding: { code: 'x' } }] })).toEqual(['Coding']);
    expect(valueTypesFor({ linkId: 'e', type: 'choice', answerOption: [{ valueString: 'x' }] })).toEqual(['string']);
  });
});

describe('profileIdFor', () => {
  test('is deterministic and content-derived', () => {
    expect(profileIdFor(questionnaire)).toBe(profileIdFor(questionnaire));
    expect(profileIdFor(questionnaire)).toMatch(/^qr-gad-7-[0-9a-f]{8}$/);
  });

  test('changes when the question set changes', () => {
    const changed: Questionnaire = { ...questionnaire, item: (questionnaire.item ?? []).slice(0, 1) };
    expect(profileIdFor(changed)).not.toBe(profileIdFor(questionnaire));
  });
});

describe('buildQuestionnaireResponseProfile', () => {
  test('produces a QuestionnaireResponse StructureDefinition with per-question slices', () => {
    const sd = buildQuestionnaireResponseProfile(questionnaire);
    expect(sd.resourceType).toBe('StructureDefinition');
    expect(sd.type).toBe('QuestionnaireResponse');
    expect(sd.derivation).toBe('constraint');
    expect(sd.baseDefinition).toBe('http://hl7.org/fhir/StructureDefinition/QuestionnaireResponse');
    expect(sd.id).toMatch(/^qr-gad-7-/);
    expect(sd.url).toContain(sd.id as string);

    const elements = sd.snapshot?.element ?? [];
    // Slicing on item by linkId, rules open.
    const itemSlice = elements.find((e) => e.id === 'QuestionnaireResponse.item');
    expect(itemSlice?.slicing?.discriminator?.[0]).toEqual({ type: 'pattern', path: 'linkId' });
    expect(itemSlice?.slicing?.rules).toBe('open');

    // Fixed linkId for the answerable question slice.
    const fixedLinkId = elements.find((e) => e.id === 'QuestionnaireResponse.item:gad7-q1.linkId');
    expect(fixedLinkId?.fixedString).toBe('gad7-q1');
    expect(fixedLinkId?.min).toBe(1);

    // Constrained answer value type + required binding carrying the allowed codes.
    const value = elements.find((e) => e.id === 'QuestionnaireResponse.item:gad7-q1.answer.value[x]');
    expect(value?.type).toEqual([{ code: 'Coding' }]);
    expect(value?.binding?.strength).toBe('required');
    expect(value?.binding?.description).toContain('LA6569-3');

    // min:0 everywhere on the slices so nothing is forced.
    expect(elements.find((e) => e.id === 'QuestionnaireResponse.item:gad7-q1')?.min).toBe(0);
    expect(value?.min).toBe(0);
  });
});

describe('composeExtractionText', () => {
  test('inlines a compact question key ahead of the transcript', () => {
    const text = composeExtractionText('patient reports feeling nervous several days', questionnaire);
    expect(text).toContain('- [gad7-q1] Feeling nervous (choice; allowed codes: LA6568-5=Not at all, LA6569-3=Several days)');
    expect(text).toContain('patient reports feeling nervous several days');
    // Only answerable leaves appear in the key.
    expect(text).not.toContain('[group-1]');
    expect(text).not.toContain('[display-1]');
  });
});
