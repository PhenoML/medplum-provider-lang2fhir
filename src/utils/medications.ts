// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { MedplumClient } from '@medplum/core';
import { getReferenceString } from '@medplum/core';
import type { Patient } from '@medplum/fhirtypes';

/**
 * Whether the patient has any active prescription. Active MedicationRequest resources are the
 * structured signal for prescription drug management — a 2021 AMA MDM moderate-risk element
 * used by the E/M acuity heuristic (see utils/emAcuity.ts). Scoped to the patient because this
 * app does not link MedicationRequest resources to encounters.
 *
 * @param medplum - The Medplum client
 * @param patient - The patient whose active prescriptions to check
 * @returns True when the patient has at least one active MedicationRequest
 */
export async function hasActivePrescriptions(medplum: MedplumClient, patient: Patient): Promise<boolean> {
  const medications = await medplum.searchResources(
    'MedicationRequest',
    `subject=${getReferenceString(patient)}&status=active&_count=1`,
    { cache: 'no-cache' }
  );
  return medications.length > 0;
}
