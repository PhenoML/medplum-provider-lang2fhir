// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { MedplumClient, WithId } from '@medplum/core';
import { CPT } from '@medplum/core';
import type { ChargeItem, ClinicalImpression, Condition, DocumentReference, Encounter, Patient, Resource } from '@medplum/fhirtypes';
import { Buffer } from 'buffer';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { handler, isEmCode } from './billing-acuity';

const phenomlMocks = vi.hoisted(() => ({ constructor: vi.fn(), extract: vi.fn() }));

vi.mock('phenoml', () => ({
  phenomlClient: vi.fn(function phenomlClient(options) {
    phenomlMocks.constructor(options);
    return { construe: { codes: { extract: phenomlMocks.extract } } };
  }),
}));

const patient: WithId<Patient> = { resourceType: 'Patient', id: 'patient-123' };
const encounter: WithId<Encounter> = {
  resourceType: 'Encounter',
  id: 'encounter-123',
  status: 'finished',
  class: { code: 'AMB' },
  subject: { reference: 'Patient/patient-123' },
  period: { start: '2026-07-08T14:00:00.000Z' },
  diagnosis: [{ condition: { reference: 'Condition/condition-existing' }, rank: 1 }],
};
const existingCondition: WithId<Condition> = {
  resourceType: 'Condition',
  id: 'condition-existing',
  subject: { reference: 'Patient/patient-123' },
  code: { coding: [{ system: 'http://hl7.org/fhir/sid/icd-10-cm', code: 'F32.1' }] },
};

interface MockData {
  docRefs?: WithId<DocumentReference>[];
  clinicalImpressions?: WithId<ClinicalImpression>[];
  chargeItems?: WithId<ChargeItem>[];
  encounter?: WithId<Encounter>;
}

function createMockMedplum(data: MockData = {}): MedplumClient & { created: Resource[]; updated: Resource[] } {
  const created: Resource[] = [];
  const updated: Resource[] = [];
  const currentEncounter = data.encounter ?? encounter;
  const medplum = {
    created,
    updated,
    readResource: vi.fn(async (resourceType: string, id: string) => {
      if (resourceType === 'Encounter' && id === currentEncounter.id) {
        return currentEncounter;
      }
      throw new Error(`${resourceType}/${id} not found`);
    }),
    readReference: vi.fn(async (reference: { reference?: string }) => {
      if (reference.reference === 'Patient/patient-123') {
        return patient;
      }
      if (reference.reference === 'Condition/condition-existing') {
        return existingCondition;
      }
      throw new Error(`${reference.reference} not found`);
    }),
    searchResources: vi.fn(async (resourceType: string) => {
      if (resourceType === 'ClinicalImpression') {
        return data.clinicalImpressions ?? [chartNote('Patient has ADHD and received psychotherapy today.')];
      }
      if (resourceType === 'DocumentReference') {
        return data.docRefs ?? [textDocRef('Additional context.')];
      }
      if (resourceType === 'ChargeItem') {
        return data.chargeItems ?? [];
      }
      if (resourceType === 'ChargeItemDefinition') {
        return [];
      }
      return [];
    }),
    createResource: vi.fn(async (resource: Resource) => {
      const id = resource.resourceType === 'Condition' ? `condition-${created.length + 1}` : `charge-${created.length + 1}`;
      const saved = { ...resource, id };
      created.push(saved);
      return saved;
    }),
    updateResource: vi.fn(async (resource: Resource) => {
      updated.push(resource);
      return resource;
    }),
    download: vi.fn(),
  };
  return medplum as unknown as MedplumClient & { created: Resource[]; updated: Resource[] };
}

function chartNote(text: string): WithId<ClinicalImpression> {
  return {
    resourceType: 'ClinicalImpression',
    id: 'clinical-1',
    status: 'in-progress',
    subject: { reference: 'Patient/patient-123' },
    encounter: { reference: 'Encounter/encounter-123' },
    note: [{ text }],
  };
}

function textDocRef(text: string): WithId<DocumentReference> {
  return {
    resourceType: 'DocumentReference',
    id: 'doc-1',
    status: 'current',
    content: [{ attachment: { contentType: 'text/plain', data: Buffer.from(text).toString('base64') } }],
  };
}

function existingCharge(code: string): WithId<ChargeItem> {
  return {
    resourceType: 'ChargeItem',
    id: `charge-${code}`,
    status: 'planned',
    subject: { reference: 'Patient/patient-123' },
    context: { reference: 'Encounter/encounter-123' },
    code: { coding: [{ system: CPT, code }] },
  };
}

function event(input: Record<string, unknown> = { encounterId: encounter.id }, secrets = defaultSecrets()): any {
  return { input, secrets };
}

function defaultSecrets(): Record<string, { valueString: string }> {
  return {
    PHENOML_CLIENT_ID: { valueString: 'client-id' },
    PHENOML_CLIENT_SECRET: { valueString: 'client-secret' },
    PHENOML_BASE_URL: { valueString: 'https://example.pheno.ml' },
  };
}

function mockSuccess(): void {
  phenomlMocks.extract.mockImplementation(async (request: any) => {
    if (request.system.name === 'CPT') {
      return {
        codes: [
          { code: '99214', description: 'Office visit', valid: true, reason: 'Documented E/M service' },
          { code: '90834', description: 'Psychotherapy', valid: true, reason: 'Procedure documented' },
        ],
      };
    }
    return {
      codes: [
        {
          code: ' f90.0 ',
          description: 'ADHD',
          valid: true,
          reason: 'Active diagnosis',
          citations: [{ text: 'ADHD', begin_offset: 12, end_offset: 16 }],
        },
      ],
    };
  });
}

describe('billing acuity bot', () => {
  beforeEach(() => {
    phenomlMocks.constructor.mockClear();
    phenomlMocks.extract.mockReset();
    mockSuccess();
  });

  test('keeps the E/M range guard', () => {
    expect(isEmCode('99202')).toBe(true);
    expect(isEmCode('99215')).toBe(true);
    expect(isEmCode('99201')).toBe(false);
  });

  test('requires credentials and encounterId', async () => {
    await expect(handler(createMockMedplum(), event({ encounterId: encounter.id }, {}))).rejects.toThrow(
      'PhenoML credentials'
    );
    await expect(handler(createMockMedplum(), event({}))).rejects.toThrow('encounterId is required');
  });

  test('creates a cited Condition, appends one ranked diagnosis update, and creates all CPT codes', async () => {
    const medplum = createMockMedplum();
    const result = await handler(medplum, event());

    expect(result.createdConditions).toEqual([{ id: 'condition-1', code: 'F90.0', display: 'ADHD', citationCount: 1 }]);
    expect(result.createdChargeItems.map((item) => item.code)).toEqual(['99214', '90834']);
    const condition = medplum.created.find((resource) => resource.resourceType === 'Condition') as Condition;
    expect(condition.code?.coding?.[0]).toMatchObject({
      system: 'http://hl7.org/fhir/sid/icd-10-cm',
      code: 'F90.0',
    });
    expect(condition.note?.[0]?.text).toBe('Active diagnosis');
    expect(condition.extension).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          url: 'https://example.org/fhir/StructureDefinition/billing-acuity-source',
          valueString: 'billing-acuity',
        }),
        expect.objectContaining({
          url: 'https://example.org/fhir/StructureDefinition/billing-citation',
          extension: expect.arrayContaining([expect.objectContaining({ url: 'text', valueString: 'ADHD' })]),
        }),
      ])
    );
    expect(medplum.updateResource).toHaveBeenCalledTimes(1);
    expect(medplum.updated[0]).toMatchObject({
      resourceType: 'Encounter',
      diagnosis: [
        { condition: { reference: 'Condition/condition-existing' }, rank: 1 },
        { condition: { reference: 'Condition/condition-1' }, rank: 2 },
      ],
    });
    const requests = phenomlMocks.extract.mock.calls.map((call) => call[0]);
    expect(requests[0].text).toBe('Patient has ADHD and received psychotherapy today.\n\nAdditional context.');
    expect(requests.find((request) => request.system.name === 'CPT').config.chunking_method).toBe('none');
    expect(requests.find((request) => request.system.name === 'ICD-10-CM').config.include_citations).toBe(true);
  });

  test('deduplicates diagnoses and exact charges and permits only one E/M code', async () => {
    phenomlMocks.extract.mockImplementation(async (request: any) =>
      request.system.name === 'CPT'
        ? { codes: [{ code: '99214', valid: true }, { code: '90834', valid: true }] }
        : { codes: [{ code: 'F32.1', valid: true }] }
    );
    const medplum = createMockMedplum({ chargeItems: [existingCharge('99213'), existingCharge('90834')] });
    const result = await handler(medplum, event());

    expect(result.skippedDuplicateDiagnoses).toEqual(['F32.1']);
    expect(result.skippedDuplicateCharges).toEqual(['99214', '90834']);
    expect(result.createdConditions).toEqual([]);
    expect(result.createdChargeItems).toEqual([]);
    expect(medplum.updateResource).not.toHaveBeenCalled();
  });

  test('continues on one extraction failure and throws when both fail', async () => {
    phenomlMocks.extract.mockImplementation(async (request: any) => {
      if (request.system.name === 'CPT') {
        throw new Error('CPT unavailable');
      }
      return { codes: [{ code: 'I10', description: 'Hypertension', valid: true }] };
    });
    const partial = await handler(createMockMedplum(), event());
    expect(partial.createdConditions[0].code).toBe('I10');
    expect(partial.warnings[0]).toContain('CPT extraction failed');

    phenomlMocks.extract.mockRejectedValue(new Error('unavailable'));
    await expect(handler(createMockMedplum(), event())).rejects.toThrow('PhenoML construe failed');
  });
});
