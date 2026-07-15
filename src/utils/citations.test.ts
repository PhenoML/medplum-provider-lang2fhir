// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { ChargeItem, Condition } from '@medplum/fhirtypes';
import { describe, expect, test } from 'vitest';
import {
  BILLING_ACUITY_SOURCE_EXTENSION_URL,
  BILLING_CITATION_EXTENSION_URL,
  buildHighlightSegments,
  buildReviewItems,
  getCitations,
  isBotGenerated,
  resolveCitationSpans,
} from './citations';

const condition: Condition = {
  resourceType: 'Condition',
  id: 'condition-1',
  subject: { reference: 'Patient/patient-1' },
  code: { coding: [{ system: 'http://hl7.org/fhir/sid/icd-10-cm', code: 'I10', display: 'Hypertension' }] },
  note: [{ text: 'Confirmed active diagnosis' }],
  extension: [
    { url: BILLING_ACUITY_SOURCE_EXTENSION_URL, valueString: 'billing-acuity' },
    {
      url: BILLING_CITATION_EXTENSION_URL,
      extension: [
        { url: 'text', valueString: 'hypertension' },
        { url: 'beginOffset', valueInteger: 4 },
        { url: 'endOffset', valueInteger: 16 },
      ],
    },
  ],
};

test('reads marker and complex citation extensions', () => {
  expect(isBotGenerated(condition)).toBe(true);
  expect(getCitations(condition)).toEqual([{ text: 'hypertension', beginOffset: 4, endOffset: 16 }]);
});

test('resolves exact, shifted, and missing citations', () => {
  const note = 'The patient has hypertension today.';
  expect(resolveCitationSpans(note, [{ text: 'hypertension', beginOffset: 16, endOffset: 28 }])).toEqual([
    { text: 'hypertension', beginOffset: 16, endOffset: 28 },
  ]);
  expect(resolveCitationSpans(note, [{ text: 'hypertension', beginOffset: 0, endOffset: 12 }])).toEqual([
    { text: 'hypertension', beginOffset: 16, endOffset: 28 },
  ]);
  expect(resolveCitationSpans(note, [{ text: 'diabetes', beginOffset: 0, endOffset: 8 }])).toEqual([]);
});

test('builds segments with all keys on overlapping citations', () => {
  const items = buildReviewItems([condition], []);
  const second = {
    ...items[0],
    key: 'Condition/condition-2',
    citations: [{ text: 'tension', beginOffset: 9, endOffset: 16 }],
  };
  expect(buildHighlightSegments('xxxxhypertension', [...items, second])).toEqual([
    { text: 'xxxx', keys: [] },
    { text: 'hyper', keys: ['Condition/condition-1'] },
    { text: 'tension', keys: ['Condition/condition-1', 'Condition/condition-2'] },
  ]);
});

describe('buildReviewItems', () => {
  test('filters unmarked resources and maps diagnoses and charges', () => {
    const charge: ChargeItem = {
      resourceType: 'ChargeItem',
      id: 'charge-1',
      status: 'planned',
      subject: { reference: 'Patient/patient-1' },
      code: { coding: [{ system: 'http://www.ama-assn.org/go/cpt', code: '99214' }] },
      extension: [{ url: BILLING_ACUITY_SOURCE_EXTENSION_URL, valueString: 'billing-acuity' }],
    };
    const unmarked = { ...condition, id: 'condition-2', extension: [] };
    expect(buildReviewItems([condition, unmarked], [charge]).map((item) => item.kind)).toEqual([
      'diagnosis',
      'charge',
    ]);
  });
});
