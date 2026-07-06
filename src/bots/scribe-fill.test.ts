// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { Questionnaire, QuestionnaireResponse } from '@medplum/fhirtypes';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { buildScribePrompt, handler, reconcileResponse } from './scribe-fill';

// Mock the PhenoML SDK so no network call is made; the bot only uses phenomlClient().lang2Fhir.create.
const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));
vi.mock('phenoml', () => ({
  phenomlClient: class {
    lang2Fhir = { create: mockCreate };
  },
}));

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
    {
      linkId: 'gad7-q2',
      text: 'Cannot stop worrying',
      type: 'choice',
      answerOption: [
        { valueCoding: { system: 'http://loinc.org', code: 'LA6568-5', display: 'Not at all' }, extension: [{ url: ORDINAL, valueDecimal: 0 }] },
        { valueCoding: { system: 'http://loinc.org', code: 'LA6571-9', display: 'Nearly every day' }, extension: [{ url: ORDINAL, valueDecimal: 3 }] },
      ],
    },
  ],
};

function makeEvent(input: unknown): BotEvent {
  return {
    input,
    secrets: {
      PHENOML_CLIENT_ID: { name: 'PHENOML_CLIENT_ID', valueString: 'id' },
      PHENOML_CLIENT_SECRET: { name: 'PHENOML_CLIENT_SECRET', valueString: 'secret' },
    },
  } as unknown as BotEvent;
}

const medplum = {} as unknown as MedplumClient;

describe('buildScribePrompt', () => {
  test('embeds linkIds, answer option codes, and the transcript', () => {
    const prompt = buildScribePrompt('patient reports feeling nervous several days', questionnaire);
    expect(prompt).toContain('gad7-q1');
    expect(prompt).toContain('LA6569-3');
    expect(prompt).toContain('(score 1)');
    expect(prompt).toContain('patient reports feeling nervous several days');
  });
});

describe('reconcileResponse', () => {
  test('maps raw answers (by code, display, or score) onto the questionnaire linkIds', () => {
    const raw: QuestionnaireResponse = {
      resourceType: 'QuestionnaireResponse',
      status: 'in-progress',
      item: [
        { linkId: 'gad7-q1', answer: [{ valueString: 'Several days' }] }, // matched by display
        { linkId: 'gad7-q2', answer: [{ valueCoding: { code: 'LA6571-9' } }] }, // matched by code
        { linkId: 'unknown-item', answer: [{ valueString: 'ignored' }] },
      ],
    };

    const result = reconcileResponse(raw, questionnaire, {
      patient: { resourceType: 'Patient', id: 'p1', name: [{ text: 'Jane Doe' }] },
      encounter: { reference: 'Encounter/e1' },
    });

    expect(result.questionnaire).toBe(questionnaire.url);
    expect(result.subject).toEqual({ reference: 'Patient/p1', display: 'Jane Doe' });
    expect(result.encounter).toEqual({ reference: 'Encounter/e1' });
    expect(result.item).toHaveLength(2); // only the two questionnaire items, unknown dropped
    expect(result.item?.[0]).toEqual({
      linkId: 'gad7-q1',
      text: 'Feeling nervous',
      answer: [{ valueCoding: { system: 'http://loinc.org', code: 'LA6569-3', display: 'Several days' } }],
    });
    expect(result.item?.[1].answer?.[0].valueCoding?.code).toBe('LA6571-9');
  });

  test('leaves items unanswered when no raw answer matches', () => {
    const result = reconcileResponse(undefined, questionnaire, {});
    expect(result.item).toHaveLength(2);
    expect(result.item?.[0].answer).toBeUndefined();
  });
});

describe('handler', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  test('throws when PhenoML credentials are missing', async () => {
    const event = { input: { transcript: 'x', questionnaire }, secrets: {} } as unknown as BotEvent;
    await expect(handler(medplum, event)).rejects.toThrow(/PhenoML credentials/);
  });

  test('throws when transcript is empty', async () => {
    await expect(handler(medplum, makeEvent({ transcript: '  ', questionnaire }))).rejects.toThrow(/transcript/i);
  });

  test('calls lang2fhir create and returns a reconciled response', async () => {
    mockCreate.mockResolvedValue({
      resourceType: 'QuestionnaireResponse',
      status: 'in-progress',
      item: [{ linkId: 'gad7-q1', answer: [{ valueCoding: { code: 'LA6569-3' } }] }],
    });

    const result = await handler(
      medplum,
      makeEvent({ transcript: 'nervous several days', questionnaire, encounter: { reference: 'Encounter/e1' } })
    );

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ version: 'R4', resource: 'questionnaireresponse', text: expect.stringContaining('gad7-q1') })
    );
    expect(result.resourceType).toBe('QuestionnaireResponse');
    expect(result.encounter).toEqual({ reference: 'Encounter/e1' });
    expect(result.item?.[0].answer?.[0].valueCoding?.code).toBe('LA6569-3');
  });
});
