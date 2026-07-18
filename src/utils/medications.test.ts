// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { MedicationRequest, Patient } from '@medplum/fhirtypes';
import { MockClient } from '@medplum/mock';
import { beforeEach, expect, test, vi } from 'vitest';
import { hasActivePrescriptions } from './medications';

const patient: Patient = { resourceType: 'Patient', id: 'patient-1' };

let medplum: MockClient;

beforeEach(() => {
  medplum = new MockClient();
});

test('queries active prescriptions scoped to the patient and returns true when found', async () => {
  const searchSpy = vi
    .spyOn(medplum, 'searchResources')
    .mockResolvedValue([{ resourceType: 'MedicationRequest', id: 'mr-1' } as MedicationRequest] as never);

  await expect(hasActivePrescriptions(medplum, patient)).resolves.toBe(true);
  expect(searchSpy).toHaveBeenCalledWith('MedicationRequest', 'subject=Patient/patient-1&status=active&_count=1', {
    cache: 'no-cache',
  });
});

test('returns false when the patient has no active prescription', async () => {
  vi.spyOn(medplum, 'searchResources').mockResolvedValue([] as never);
  await expect(hasActivePrescriptions(medplum, patient)).resolves.toBe(false);
});
