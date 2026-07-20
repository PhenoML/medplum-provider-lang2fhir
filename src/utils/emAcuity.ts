// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

// Office/outpatient E/M visit acuity heuristic. Approximates 2021 AMA MDM: the number of
// diagnoses (problems) addressed plus whether prescription drug management is involved (a
// moderate-risk element) drives the expected visit level, which is compared against the
// billed code to flag possible under/overcoding. Prescription drug management is derived
// from the patient's active MedicationRequest resources (see utils/medications.ts) rather
// than parsed from the note. This explains the billed code rather than overriding it.

export const PRESCRIPTION_MANAGEMENT_LABEL = 'prescription drug management';

export type EmVerdict = 'match' | 'undercoding' | 'overcoding';

export interface EmAcuity {
  billed: string;
  expected: string;
  problemCount: number;
  riskLabel?: string;
  verdict: EmVerdict;
  message: string;
}

// New-patient office visits 99202-99205, established-patient 99211-99215.
const NEW_PATIENT_EM = /^9920[2-5]$/;
const ESTABLISHED_EM = /^9921[1-5]$/;

export function isEmCode(code: string): boolean {
  return NEW_PATIENT_EM.test(code) || ESTABLISHED_EM.test(code);
}

// First matching tier wins; mirrors the demo em-level-expectation tiers.
function expectedLevel(problemCount: number, hasRisk: boolean): number {
  if (problemCount >= 6 && hasRisk) {
    return 5;
  }
  if (problemCount >= 3 && hasRisk) {
    return 4;
  }
  if (problemCount >= 2) {
    return 3;
  }
  return 2;
}

export function computeEmAcuity(params: {
  billedCode: string;
  problemCount: number;
  hasPrescriptionManagement: boolean;
}): EmAcuity | undefined {
  const { billedCode, problemCount, hasPrescriptionManagement } = params;
  const isNewPatient = NEW_PATIENT_EM.test(billedCode);
  if (!isNewPatient && !ESTABLISHED_EM.test(billedCode)) {
    return undefined;
  }

  const level = expectedLevel(problemCount, hasPrescriptionManagement);
  const expected = `${isNewPatient ? '9920' : '9921'}${level}`;
  const billedLevel = Number(billedCode.slice(-1));

  const riskSuffix = hasPrescriptionManagement ? ` + ${PRESCRIPTION_MANAGEMENT_LABEL}` : '';
  const detail = `${problemCount} diagnos${problemCount === 1 ? 'is' : 'es'}${riskSuffix}`;

  let verdict: EmVerdict;
  let message: string;
  if (level === billedLevel) {
    verdict = 'match';
    message = `Billed ${billedCode} matches documented complexity (${detail}).`;
  } else if (level > billedLevel) {
    verdict = 'undercoding';
    message = `Documentation supports ${expected} (${detail}); billed ${billedCode} — possible undercoding.`;
  } else {
    verdict = 'overcoding';
    message = `Billed ${billedCode} but documentation supports ${expected} (${detail}) — possible overcoding.`;
  }

  return {
    billed: billedCode,
    expected,
    problemCount,
    ...(hasPrescriptionManagement ? { riskLabel: PRESCRIPTION_MANAGEMENT_LABEL } : {}),
    verdict,
    message,
  };
}
