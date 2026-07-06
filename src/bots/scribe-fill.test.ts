// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { Questionnaire } from '@medplum/fhirtypes';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { ScribeFillInput } from './scribe-fill';
import { handler } from './scribe-fill';

// Mock the PhenoML SDK: the bot uses lang2Fhir.uploadProfile and lang2Fhir.create.
const { mockCreate, mockUploadProfile } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockUploadProfile: vi.fn(),
}));
vi.mock('phenoml', () => ({
  phenomlClient: class {
    lang2Fhir = { create: mockCreate, uploadProfile: mockUploadProfile };
  },
}));

const ORDINAL = 'http://hl7.org/fhir/StructureDefinition/ordinalValue';

// Each variant produces a distinct content-derived profile id, so upload dedupe (a module-level Set)
// does not couple tests to each other.
function makeQuestionnaire(variant: string): Questionnaire {
  return {
    resourceType: 'Questionnaire',
    status: 'active',
    url: `https://www.medplum.com/questionnaire/gad-7-${variant}`,
    title: `GAD-7 ${variant}`,
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
}

function makeEvent(input: ScribeFillInput): BotEvent<ScribeFillInput> {
  return {
    input,
    secrets: {
      PHENOML_CLIENT_ID: { name: 'PHENOML_CLIENT_ID', valueString: 'id' },
      PHENOML_CLIENT_SECRET: { name: 'PHENOML_CLIENT_SECRET', valueString: 'secret' },
    },
  } as unknown as BotEvent<ScribeFillInput>;
}

function makeMedplum(existingProfile = false): { medplum: MedplumClient; searchOne: ReturnType<typeof vi.fn>; createResource: ReturnType<typeof vi.fn> } {
  const searchOne = vi.fn().mockResolvedValue(existingProfile ? { resourceType: 'StructureDefinition', id: 'x' } : undefined);
  const createResource = vi.fn().mockImplementation(async (r: unknown) => r);
  return { medplum: { searchOne, createResource } as unknown as MedplumClient, searchOne, createResource };
}

describe('scribe-fill handler', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockUploadProfile.mockReset().mockResolvedValue({ id: 'ok' });
  });

  test('throws when PhenoML credentials are missing', async () => {
    const event = { input: { transcript: 'x', questionnaire: makeQuestionnaire('a') }, secrets: {} } as unknown as BotEvent<ScribeFillInput>;
    await expect(handler(makeMedplum().medplum, event)).rejects.toThrow(/PhenoML credentials/);
  });

  test('throws when transcript is empty', async () => {
    await expect(handler(makeMedplum().medplum, makeEvent({ transcript: '  ', questionnaire: makeQuestionnaire('b') }))).rejects.toThrow(/transcript/i);
  });

  test('builds a profile, saves it to Medplum, uploads it, and conforms create output to it', async () => {
    mockCreate.mockResolvedValue({
      resourceType: 'QuestionnaireResponse',
      status: 'in-progress',
      item: [{ linkId: 'gad7-q1', answer: [{ valueCoding: { code: 'LA6569-3' } }] }],
    });
    const { medplum, searchOne, createResource } = makeMedplum(false);

    const result = await handler(
      medplum,
      makeEvent({ transcript: 'nervous several days', questionnaire: makeQuestionnaire('c'), encounter: { reference: 'Encounter/e1' } })
    );

    // Profile looked up by content-derived url, and created on the fly since it did not exist.
    expect(searchOne).toHaveBeenCalledWith('StructureDefinition', expect.objectContaining({ url: expect.stringContaining('/qr-gad-7-c-') }));
    expect(createResource).toHaveBeenCalledWith(expect.objectContaining({ resourceType: 'StructureDefinition', type: 'QuestionnaireResponse' }));

    // Profile uploaded to PhenoML with a base64 body and the IG name.
    expect(mockUploadProfile).toHaveBeenCalledWith(
      expect.objectContaining({ implementation_guide: 'medplum_questionnaires', profile: expect.any(String) })
    );

    // create() targets the custom profile id and carries the question key + transcript.
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ version: 'R4', resource: expect.stringMatching(/^qr-gad-7-c-/), text: expect.stringContaining('[gad7-q1]') })
    );

    // Post-validation enriches the matched code to the full answerOption coding and stamps fields.
    expect(result.resourceType).toBe('QuestionnaireResponse');
    expect(result.encounter).toEqual({ reference: 'Encounter/e1' });
    expect(result.item?.[0].answer?.[0].valueCoding).toEqual({
      system: 'http://loinc.org',
      code: 'LA6569-3',
      display: 'Several days',
    });
  });

  test('does not re-create the profile in Medplum when it already matches', async () => {
    mockCreate.mockResolvedValue({ resourceType: 'QuestionnaireResponse', status: 'in-progress', item: [] });
    const { medplum, createResource } = makeMedplum(true);

    await handler(medplum, makeEvent({ transcript: 'text', questionnaire: makeQuestionnaire('d') }));

    expect(createResource).not.toHaveBeenCalled();
  });

  test('tolerates a PhenoML "profile already exists" error', async () => {
    mockUploadProfile.mockRejectedValue(new Error('A custom profile with the same id has already been uploaded'));
    mockCreate.mockResolvedValue({ resourceType: 'QuestionnaireResponse', status: 'in-progress', item: [] });

    const result = await handler(makeMedplum(false).medplum, makeEvent({ transcript: 'text', questionnaire: makeQuestionnaire('e') }));
    expect(result.resourceType).toBe('QuestionnaireResponse');
    expect(mockCreate).toHaveBeenCalled();
  });

  test('falls back to the generic profile when create against the custom profile fails', async () => {
    mockCreate
      .mockRejectedValueOnce(new Error('custom profiles require the develop or launch tier'))
      .mockResolvedValueOnce({ resourceType: 'QuestionnaireResponse', status: 'in-progress', item: [] });

    const result = await handler(makeMedplum(false).medplum, makeEvent({ transcript: 'text', questionnaire: makeQuestionnaire('f') }));

    expect(result.resourceType).toBe('QuestionnaireResponse');
    expect(mockCreate).toHaveBeenNthCalledWith(2, expect.objectContaining({ resource: 'questionnaireresponse' }));
  });
});
