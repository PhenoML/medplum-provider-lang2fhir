// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import type { WithId } from '@medplum/core';
import { createReference } from '@medplum/core';
import type { Encounter, Patient, Questionnaire, QuestionnaireResponse } from '@medplum/fhirtypes';
import { MockClient } from '@medplum/mock';
import { MedplumProvider } from '@medplum/react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { GAD7_QUESTIONNAIRE_URL, PHQ9_QUESTIONNAIRE_URL } from '../../utils/screening';
import { ScribePanel } from './ScribePanel';

// The scribe transcription hook loads a browser Whisper model — stub it so tests don't fetch a model.
vi.mock('@huggingface/transformers', () => ({
  env: {},
  pipeline: vi.fn().mockResolvedValue(vi.fn()),
}));

const ORDINAL = 'http://hl7.org/fhir/StructureDefinition/ordinalValue';

function screeningQuestionnaire(url: string, title: string, linkId: string): Questionnaire {
  return {
    resourceType: 'Questionnaire',
    status: 'active',
    url,
    title,
    item: [
      {
        linkId,
        text: 'Sample question',
        type: 'choice',
        answerOption: [
          { valueCoding: { system: 'http://loinc.org', code: 'LA6568-5', display: 'Not at all' }, extension: [{ url: ORDINAL, valueDecimal: 0 }] },
          { valueCoding: { system: 'http://loinc.org', code: 'LA6571-9', display: 'Nearly every day' }, extension: [{ url: ORDINAL, valueDecimal: 3 }] },
        ],
      },
    ],
  };
}

const mockEncounter: WithId<Encounter> = {
  resourceType: 'Encounter',
  id: 'encounter-123',
  status: 'in-progress',
  class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB' },
  subject: { reference: 'Patient/patient-123' },
};

const mockPatient: WithId<Patient> = {
  resourceType: 'Patient',
  id: 'patient-123',
  name: [{ text: 'Jane Doe' }],
};

describe('ScribePanel', () => {
  let medplum: MockClient;

  beforeEach(async () => {
    medplum = new MockClient();
    vi.clearAllMocks();
    await medplum.createResource(screeningQuestionnaire(GAD7_QUESTIONNAIRE_URL, 'GAD-7', 'gad7-q1'));
    await medplum.createResource(screeningQuestionnaire(PHQ9_QUESTIONNAIRE_URL, 'PHQ-9', 'phq9-q1'));
    await medplum.createResource({ resourceType: 'Bot', name: 'scribe-fill' });
  });

  const setup = (): ReturnType<typeof render> =>
    render(
      <MemoryRouter>
        <MedplumProvider medplum={medplum}>
          <MantineProvider>
            <Notifications />
            <ScribePanel encounter={mockEncounter} patient={mockPatient} />
          </MantineProvider>
        </MedplumProvider>
      </MemoryRouter>
    );

  test('pastes a transcript, generates pre-filled forms, and saves a QuestionnaireResponse linked to the encounter', async () => {
    const user = userEvent.setup();

    // The bot returns a pre-filled response for whichever questionnaire it is given.
    vi.spyOn(medplum, 'executeBot').mockImplementation(async (_id, input: any) => {
      const linkId = input.questionnaire.item[0].linkId;
      return {
        resourceType: 'QuestionnaireResponse',
        status: 'in-progress',
        questionnaire: input.questionnaire.url,
        encounter: input.encounter,
        item: [{ linkId, text: 'Sample question', answer: [{ valueCoding: { code: 'LA6571-9', display: 'Nearly every day' } }] }],
      } as QuestionnaireResponse;
    });
    const createSpy = vi.spyOn(medplum, 'createResource');

    await act(async () => {
      setup();
    });

    const textarea = screen.getByPlaceholderText(/paste a visit transcript/i);
    await user.type(textarea, 'Patient reports feeling anxious nearly every day.');

    await user.click(screen.getByRole('button', { name: /generate screening questionnaires/i }));

    // Both screening questionnaires render for review, each with its own Save button.
    const saveButtons = await screen.findAllByRole('button', { name: /save to encounter/i });
    expect(saveButtons).toHaveLength(2);
    expect(medplum.executeBot).toHaveBeenCalledTimes(2);

    // Save the first questionnaire's response.
    await user.click(saveButtons[0]);

    await waitFor(() => {
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          resourceType: 'QuestionnaireResponse',
          status: 'completed',
          encounter: createReference(mockEncounter),
          subject: createReference(mockPatient),
        })
      );
    });
  });

  test('generate is disabled until a transcript is entered', async () => {
    await act(async () => {
      setup();
    });
    expect(screen.getByRole('button', { name: /generate screening questionnaires/i })).toBeDisabled();
  });
});
