// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { MedplumClient, WithId } from '@medplum/core';
import { CPT } from '@medplum/core';
import type {
  ChargeItem,
  ChargeItemDefinition,
  ClinicalImpression,
  Condition,
  DocumentReference,
  Encounter,
  Patient,
} from '@medplum/fhirtypes';
import { Buffer } from 'buffer';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { computeEmLevel, findRiskHits, handler, isEmCode, pickMostRecentEncounter } from './billing-acuity';

const phenomlMocks = vi.hoisted(() => ({
  constructor: vi.fn(),
  extract: vi.fn(),
}));

vi.mock('phenoml', () => ({
  phenomlClient: vi.fn(function phenomlClient(options) {
    phenomlMocks.constructor(options);
    return { construe: { codes: { extract: phenomlMocks.extract } } };
  }),
}));

const patient: WithId<Patient> = {
  resourceType: 'Patient',
  id: 'patient-123',
};

const recentEncounter: WithId<Encounter> = {
  resourceType: 'Encounter',
  id: 'encounter-new',
  status: 'finished',
  class: { code: 'AMB' },
  subject: { reference: 'Patient/patient-123' },
  period: { start: '2026-07-08T14:00:00.000Z' },
  diagnosis: [
    { condition: { reference: 'Condition/condition-1' } },
    { condition: { reference: 'Condition/condition-2' } },
  ],
};

const oldEncounter: WithId<Encounter> = {
  resourceType: 'Encounter',
  id: 'encounter-old',
  status: 'finished',
  class: { code: 'AMB' },
  subject: { reference: 'Patient/patient-123' },
  meta: { lastUpdated: '2026-07-01T14:00:00.000Z' },
};

const conditionOne: WithId<Condition> = {
  resourceType: 'Condition',
  id: 'condition-1',
  subject: { reference: 'Patient/patient-123' },
  code: {
    coding: [{ system: 'http://hl7.org/fhir/sid/icd-10-cm', code: 'F32.1', display: 'Depression' }],
  },
};

const conditionTwo: WithId<Condition> = {
  resourceType: 'Condition',
  id: 'condition-2',
  subject: { reference: 'Patient/patient-123' },
  code: {
    coding: [{ system: 'http://hl7.org/fhir/sid/icd-10-cm', code: 'F41.1', display: 'Anxiety' }],
  },
};

interface MockMedplumData {
  encounters?: WithId<Encounter>[];
  docRefs?: WithId<DocumentReference>[];
  clinicalImpressions?: WithId<ClinicalImpression>[];
  conditions?: Record<string, WithId<Condition>>;
  chargeItems?: WithId<ChargeItem>[];
  definitions?: WithId<ChargeItemDefinition>[];
  downloads?: Record<string, string>;
}

function createMockMedplum(data: MockMedplumData = {}): MedplumClient & { created: WithId<ChargeItem>[] } {
  const created: WithId<ChargeItem>[] = [];
  const conditions = data.conditions ?? {
    'condition-1': conditionOne,
    'condition-2': conditionTwo,
  };

  const medplum = {
    created,
    readResource: vi.fn(async (resourceType: string, id: string) => {
      if (resourceType === 'Patient' && id === patient.id) {
        return patient;
      }
      throw new Error(`${resourceType}/${id} not found`);
    }),
    searchResources: vi.fn(async (resourceType: string) => {
      switch (resourceType) {
        case 'Encounter':
          return data.encounters ?? [oldEncounter, recentEncounter];
        case 'DocumentReference':
          return data.docRefs ?? [textDocRef('Medication management performed today.')];
        case 'ClinicalImpression':
          return data.clinicalImpressions ?? [chartNote('Patient has medication management for anxiety.')];
        case 'ChargeItem':
          return data.chargeItems ?? [];
        case 'ChargeItemDefinition':
          return data.definitions ?? [];
        default:
          return [];
      }
    }),
    readReference: vi.fn(async (reference: { reference?: string }) => {
      const id = reference.reference?.split('/')[1];
      if (id && conditions[id]) {
        return conditions[id];
      }
      throw new Error(`${reference.reference ?? 'unknown reference'} not found`);
    }),
    download: vi.fn(async (url: string) => ({
      text: async () => data.downloads?.[url] ?? '',
    })),
    createResource: vi.fn(async (resource: ChargeItem) => {
      const saved = { ...resource, id: `charge-${created.length + 1}` } as WithId<ChargeItem>;
      created.push(saved);
      return saved;
    }),
  };

  return medplum as unknown as MedplumClient & { created: WithId<ChargeItem>[] };
}

function botEvent(input: Record<string, unknown> = { patientId: patient.id }, secrets = defaultSecrets()): any {
  return { input, secrets };
}

function defaultSecrets(): Record<string, { valueString: string }> {
  return {
    PHENOML_CLIENT_ID: { valueString: 'client-id' },
    PHENOML_CLIENT_SECRET: { valueString: 'client-secret' },
    PHENOML_BASE_URL: { valueString: 'https://example.pheno.ml' },
  };
}

function textDocRef(text: string): WithId<DocumentReference> {
  return {
    resourceType: 'DocumentReference',
    id: 'doc-text',
    status: 'current',
    content: [
      {
        attachment: {
          contentType: 'text/plain',
          data: Buffer.from(text, 'utf8').toString('base64'),
        },
      },
    ],
  };
}

function pdfDocRef(): WithId<DocumentReference> {
  return {
    resourceType: 'DocumentReference',
    id: 'doc-pdf',
    status: 'current',
    content: [{ attachment: { contentType: 'application/pdf', url: 'Binary/pdf' } }],
  };
}

function chartNote(text: string): WithId<ClinicalImpression> {
  return {
    resourceType: 'ClinicalImpression',
    id: 'chart-note',
    status: 'completed',
    subject: { reference: 'Patient/patient-123' },
    note: [{ text }],
  };
}

function existingChargeItem(code: string): WithId<ChargeItem> {
  return {
    resourceType: 'ChargeItem',
    id: `existing-${code}`,
    status: 'planned',
    subject: { reference: 'Patient/patient-123' },
    context: { reference: 'Encounter/encounter-new' },
    code: { coding: [{ system: CPT, code }] },
  };
}

function mockConstrueSuccess(): void {
  phenomlMocks.extract.mockImplementation(async (request: any) => {
    if (request.system?.name === 'CPT') {
      return {
        system: request.system,
        codes: [
          { code: '99215', description: 'Model suggested E/M', valid: true, reason: 'Suggested by model' },
          { code: '90834', description: 'Psychotherapy', valid: true, reason: 'Psychotherapy documented' },
        ],
      };
    }
    return {
      system: request.system,
      codes: [{ code: 'F90.0', description: 'ADHD', valid: true, reason: 'Addressed today' }],
    };
  });
}

describe('billing acuity helpers', () => {
  test('computes E/M level boundaries', () => {
    expect(computeEmLevel(['A'], [])).toBe('99212');
    expect(computeEmLevel(['A', 'B'], [])).toBe('99213');
    expect(computeEmLevel(['A', 'B', 'C'], [])).toBe('99213');
    expect(computeEmLevel(['A', 'B', 'C'], ['medication management'])).toBe('99214');
    expect(computeEmLevel(['A', 'B', 'C', 'D', 'E', 'F'], [])).toBe('99213');
    expect(computeEmLevel(['A', 'B', 'C', 'D', 'E', 'F'], ['medication management'])).toBe('99215');
  });

  test('finds risk phrases case-insensitively', () => {
    expect(findRiskHits('Plan includes Medication Management and a medication adjustment.')).toEqual([
      'medication management',
      'medication adjustment',
    ]);
  });

  test('checks E/M CPT code range', () => {
    expect(isEmCode('99202')).toBe(true);
    expect(isEmCode('99215')).toBe(true);
    expect(isEmCode('99201')).toBe(false);
    expect(isEmCode('abc')).toBe(false);
  });

  test('picks the most recent encounter by period start with lastUpdated fallback', () => {
    expect(
      pickMostRecentEncounter([
        { ...oldEncounter, meta: { lastUpdated: '2026-07-09T10:00:00.000Z' } },
        { ...recentEncounter, period: { start: '2026-07-10T10:00:00.000Z' } },
      ])?.id
    ).toBe('encounter-new');
    expect(
      pickMostRecentEncounter([
        { ...oldEncounter, meta: { lastUpdated: '2026-07-11T10:00:00.000Z' } },
        { ...recentEncounter, period: undefined, meta: undefined },
      ])?.id
    ).toBe('encounter-old');
    expect(pickMostRecentEncounter([])).toBeUndefined();
  });
});

describe('billing acuity handler', () => {
  beforeEach(() => {
    phenomlMocks.constructor.mockClear();
    phenomlMocks.extract.mockReset();
    mockConstrueSuccess();
  });

  test('throws when PhenoML secrets are missing', async () => {
    const medplum = createMockMedplum();
    await expect(handler(medplum, botEvent({ patientId: patient.id }, {}))).rejects.toThrow('PhenoML credentials');
  });

  test('throws when no encounter exists for the patient', async () => {
    const medplum = createMockMedplum({ encounters: [] });
    await expect(handler(medplum, botEvent())).rejects.toThrow('No encounter found');
  });

  test('throws when the encounter has no text input', async () => {
    const medplum = createMockMedplum({ docRefs: [], clinicalImpressions: [] });
    await expect(handler(medplum, botEvent())).rejects.toThrow('No text found');
  });

  test('creates heuristic E/M and procedure ChargeItems on the most recent encounter', async () => {
    const medplum = createMockMedplum({
      definitions: [
        {
          resourceType: 'ChargeItemDefinition',
          id: 'def-other',
          status: 'active',
          url: 'http://example.com/ChargeItemDefinition/other',
          code: { coding: [{ system: CPT, code: '90837' }] },
        },
        {
          resourceType: 'ChargeItemDefinition',
          id: 'def-90834',
          status: 'active',
          url: 'http://example.com/ChargeItemDefinition/90834',
          code: { coding: [{ system: CPT, code: '90834' }] },
        },
      ],
    });

    const result = await handler(medplum, botEvent());

    expect(phenomlMocks.constructor).toHaveBeenCalledWith({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      baseUrl: 'https://example.pheno.ml',
    });
    expect(result.encounterId).toBe('encounter-new');
    expect(result.emCode).toBe('99214');
    expect(result.modelSuggestedEmCode).toBe('99215');
    expect(result.createdChargeItems.map((item) => item.code)).toEqual(['99214', '90834']);
    expect(result.createdChargeItems.map((item) => item.code)).not.toContain('99215');

    expect(medplum.created).toHaveLength(2);
    for (const chargeItem of medplum.created) {
      expect(chargeItem.context?.reference).toBe('Encounter/encounter-new');
      expect(chargeItem.code?.coding?.[0]?.system).toBe(CPT);
      expect(chargeItem.occurrenceDateTime).toBe('2026-07-08T14:00:00.000Z');
    }
    expect(medplum.created[0].definitionCanonical).toBeUndefined();
    expect(medplum.created[1].definitionCanonical).toEqual(['http://example.com/ChargeItemDefinition/90834']);
    expect(medplum.searchResources).toHaveBeenCalledWith('ChargeItemDefinition', 'status=active&_count=100');
  });

  test('skips duplicate CPT codes', async () => {
    const medplum = createMockMedplum({ chargeItems: [existingChargeItem('99214')] });

    const result = await handler(medplum, botEvent());

    expect(result.skippedDuplicates).toEqual(['99214']);
    expect(result.createdChargeItems.map((item) => item.code)).toEqual(['90834']);
    expect(medplum.created).toHaveLength(1);
  });

  test('skips the E/M candidate when a different-level E/M code already exists', async () => {
    const medplum = createMockMedplum({ chargeItems: [existingChargeItem('99213')] });

    const result = await handler(medplum, botEvent());

    expect(result.emCode).toBe('99214');
    expect(result.skippedDuplicates).toContain('99214');
    expect(result.createdChargeItems.map((item) => item.code)).toEqual(['90834']);
    expect(result.createdChargeItems.every((item) => !isEmCode(item.code))).toBe(true);
    expect(medplum.created).toHaveLength(1);
  });

  test('continues when one construe system fails and counts skipped PDF attachments', async () => {
    phenomlMocks.extract.mockImplementation(async (request: any) => {
      if (request.system?.name === 'CPT') {
        throw new Error('CPT unavailable');
      }
      return {
        system: request.system,
        codes: [{ code: 'F90.0', description: 'ADHD', valid: true, reason: 'Addressed today' }],
      };
    });
    const medplum = createMockMedplum({ docRefs: [textDocRef('Medication management today.'), pdfDocRef()] });

    const result = await handler(medplum, botEvent());

    expect(result.skippedAttachments).toBe(1);
    expect(result.warnings.some((warning) => warning.includes('CPT extraction failed'))).toBe(true);
    expect(result.createdChargeItems.map((item) => item.code)).toEqual(['99214']);
  });

  test('throws when both construe calls fail and there are no encounter Conditions', async () => {
    phenomlMocks.extract.mockRejectedValue(new Error('service unavailable'));
    const medplum = createMockMedplum({
      encounters: [{ ...recentEncounter, diagnosis: [] }],
      conditions: {},
    });

    await expect(handler(medplum, botEvent())).rejects.toThrow('PhenoML construe failed');
  });
});
