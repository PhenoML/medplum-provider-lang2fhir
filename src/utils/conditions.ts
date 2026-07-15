// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { MedplumClient } from '@medplum/core';
import { getReferenceString } from '@medplum/core';
import type { Condition, Encounter, EncounterDiagnosis } from '@medplum/fhirtypes';

export async function fetchEncounterConditions(
  medplum: MedplumClient,
  encounter: Encounter
): Promise<Condition[]> {
  const diagnosisReferences =
    encounter.diagnosis
      ?.map((diagnosis) => diagnosis.condition?.reference)
      .filter((reference): reference is string => Boolean(reference)) ?? [];
  const conditions = (await Promise.all(
    diagnosisReferences.map((reference) => medplum.readReference({ reference }))
  )) as Condition[];
  const ranks = new Map<string, number>();
  encounter.diagnosis?.forEach((diagnosis, index) => {
    const reference = diagnosis.condition?.reference;
    if (reference) {
      ranks.set(reference, diagnosis.rank ?? index + 1);
    }
  });

  return conditions
    .filter((condition) => {
      const reference = getReferenceString(condition);
      return Boolean(reference && diagnosisReferences.includes(reference));
    })
    .sort((a, b) => getConditionRank(a, ranks) - getConditionRank(b, ranks));
}

function getConditionRank(condition: Condition, ranks: Map<string, number>): number {
  const reference = getReferenceString(condition);
  return reference ? (ranks.get(reference) ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
}

export async function removeEncounterDiagnosis(
  medplum: MedplumClient,
  encounter: Encounter,
  condition: Condition
): Promise<EncounterDiagnosis[]> {
  if (condition.id) {
    await medplum.deleteResource('Condition', condition.id);
  }
  return (encounter.diagnosis ?? [])
    .filter((diagnosis) => diagnosis.condition?.reference !== getReferenceString(condition))
    .map((diagnosis, index) => ({ ...diagnosis, rank: index + 1 }));
}
