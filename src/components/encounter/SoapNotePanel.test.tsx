// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import type { WithId } from '@medplum/core';
import { createReference } from '@medplum/core';
import type { Encounter, Patient } from '@medplum/fhirtypes';
import { MockClient } from '@medplum/mock';
import { MedplumProvider } from '@medplum/react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { SoapNotePanel } from './SoapNotePanel';

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

describe('SoapNotePanel', () => {
  let medplum: MockClient;

  beforeEach(async () => {
    medplum = new MockClient();
    vi.clearAllMocks();
    await medplum.createResource({ resourceType: 'Bot', name: 'scribe-soap-note' });
  });

  const setup = (transcript: string): ReturnType<typeof render> =>
    render(
      <MemoryRouter>
        <MedplumProvider medplum={medplum}>
          <MantineProvider>
            <Notifications />
            <SoapNotePanel transcript={transcript} patient={mockPatient} encounter={mockEncounter} />
          </MantineProvider>
        </MedplumProvider>
      </MemoryRouter>
    );

  test('generate is disabled until a transcript is present', async () => {
    await act(async () => {
      setup('');
    });
    expect(screen.getByRole('button', { name: /generate note/i })).toBeDisabled();
  });

  test('generates a SOAP note, then saves a DocumentReference linked to the patient and encounter', async () => {
    const user = userEvent.setup();

    vi.spyOn(medplum, 'executeBot').mockResolvedValue({
      note: 'SUBJECTIVE: anxious.\nPLAN: sertraline 50 mg.',
      createdResources: ['Condition/c1', 'Observation/o1'],
    });
    const createSpy = vi.spyOn(medplum, 'createResource');

    await act(async () => {
      setup('Patient reports feeling anxious nearly every day.');
    });

    await user.click(screen.getByRole('button', { name: /generate note/i }));

    // The generated note appears in an editable textarea for review.
    expect(await screen.findByDisplayValue(/SUBJECTIVE:/)).toBeInTheDocument();
    expect(medplum.executeBot).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: /save to chart/i }));

    await waitFor(() => {
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          resourceType: 'DocumentReference',
          status: 'current',
          subject: createReference(mockPatient),
          context: { encounter: [createReference(mockEncounter)] },
          type: expect.objectContaining({ text: 'SOAP note' }),
        })
      );
    });
  });
});
