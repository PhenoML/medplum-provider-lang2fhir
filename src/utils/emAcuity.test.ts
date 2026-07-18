// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from 'vitest';
import { computeEmAcuity, isEmCode } from './emAcuity';

describe('isEmCode', () => {
  test('accepts new and established office E/M codes', () => {
    expect(['99202', '99205', '99211', '99215'].every(isEmCode)).toBe(true);
  });

  test('rejects codes outside the office E/M ladders', () => {
    expect(isEmCode('20610')).toBe(false);
    expect(isEmCode('99999')).toBe(false);
    expect(isEmCode('99213x')).toBe(false);
  });
});

describe('computeEmAcuity', () => {
  test('returns undefined for non-E/M codes', () => {
    expect(computeEmAcuity({ billedCode: '20610', problemCount: 3, hasPrescriptionManagement: true })).toBeUndefined();
  });

  test('flags undercoding when documented complexity exceeds the billed level', () => {
    const acuity = computeEmAcuity({ billedCode: '99213', problemCount: 3, hasPrescriptionManagement: true });
    expect(acuity).toMatchObject({
      expected: '99214',
      verdict: 'undercoding',
      riskLabel: 'prescription drug management',
    });
    expect(acuity?.message).toBe(
      'Documentation supports 99214 (3 diagnoses + prescription drug management); billed 99213 — possible undercoding.'
    );
  });

  test('matches when the billed level fits the diagnosis count', () => {
    const acuity = computeEmAcuity({ billedCode: '99213', problemCount: 2, hasPrescriptionManagement: false });
    expect(acuity).toMatchObject({ expected: '99213', verdict: 'match' });
    expect(acuity?.riskLabel).toBeUndefined();
    expect(acuity?.message).toBe('Billed 99213 matches documented complexity (2 diagnoses).');
  });

  test('flags overcoding with singular wording for a single diagnosis', () => {
    const acuity = computeEmAcuity({ billedCode: '99214', problemCount: 1, hasPrescriptionManagement: false });
    expect(acuity).toMatchObject({ expected: '99212', verdict: 'overcoding' });
    expect(acuity?.message).toBe('Billed 99214 but documentation supports 99212 (1 diagnosis) — possible overcoding.');
  });

  test('an active prescription is required to reach level 4', () => {
    expect(computeEmAcuity({ billedCode: '99214', problemCount: 4, hasPrescriptionManagement: false })).toMatchObject({
      expected: '99213',
      verdict: 'overcoding',
    });
    expect(computeEmAcuity({ billedCode: '99214', problemCount: 4, hasPrescriptionManagement: true })).toMatchObject({
      expected: '99214',
      verdict: 'match',
    });
  });

  test('maps the expected level onto the new-patient ladder', () => {
    expect(computeEmAcuity({ billedCode: '99203', problemCount: 1, hasPrescriptionManagement: false })).toMatchObject({
      expected: '99202',
      verdict: 'overcoding',
    });
  });
});
