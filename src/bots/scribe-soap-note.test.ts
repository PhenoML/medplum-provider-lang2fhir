// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { BotEvent, MedplumClient } from '@medplum/core';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Bundle, Patient } from '@medplum/fhirtypes';
import type { ScribeSoapNoteInput, handler as HandlerType } from './scribe-soap-note';

// Mock the PhenoML SDK: the bot uses lang2Fhir.createMulti, summary.templates.list/create, summary.create.
const { mockCreateMulti, mockList, mockCreateTemplate, mockCreateSummary } = vi.hoisted(() => ({
  mockCreateMulti: vi.fn(),
  mockList: vi.fn(),
  mockCreateTemplate: vi.fn(),
  mockCreateSummary: vi.fn(),
}));
vi.mock('phenoml', () => ({
  phenomlClient: class {
    lang2Fhir = { createMulti: mockCreateMulti };
    summary = {
      create: mockCreateSummary,
      templates: { list: mockList, create: mockCreateTemplate },
    };
  },
}));

// The bot caches the resolved template id at module scope; re-import per test for a fresh cache.
async function loadHandler(): Promise<typeof HandlerType> {
  vi.resetModules();
  return (await import('./scribe-soap-note')).handler;
}

const PATIENT: Patient = { resourceType: 'Patient', id: 'p1', name: [{ text: 'Jordan Rivera' }] };

function makeEvent(input: Partial<ScribeSoapNoteInput> = {}, includeBaseUrl = true): BotEvent<ScribeSoapNoteInput> {
  return {
    input: { transcript: 'patient reports anxiety and low mood', patient: PATIENT, encounter: { reference: 'Encounter/e1' }, ...input },
    secrets: {
      PHENOML_CLIENT_ID: { name: 'PHENOML_CLIENT_ID', valueString: 'id' },
      PHENOML_CLIENT_SECRET: { name: 'PHENOML_CLIENT_SECRET', valueString: 'secret' },
      ...(includeBaseUrl ? { PHENOML_BASE_URL: { name: 'PHENOML_BASE_URL', valueString: 'https://tenant.app.pheno.ml' } } : {}),
    },
  } as unknown as BotEvent<ScribeSoapNoteInput>;
}

function makeMedplum(): { medplum: MedplumClient; executeBatch: ReturnType<typeof vi.fn> } {
  const executeBatch = vi.fn().mockResolvedValue({
    resourceType: 'Bundle',
    type: 'transaction-response',
    entry: [
      { response: { status: '201', location: 'Condition/c1/_history/1' }, resource: { resourceType: 'Condition', id: 'c1', subject: { reference: 'Patient/p1' } } },
      { response: { status: '201', location: 'Observation/o1/_history/1' }, resource: { resourceType: 'Observation', id: 'o1', subject: { reference: 'Patient/p1' } } },
    ],
  });
  return { medplum: { executeBatch } as unknown as MedplumClient, executeBatch };
}

function extractionBundle(): { bundle: { resourceType: string; type: string; entry: unknown[] } } {
  return {
    bundle: {
      resourceType: 'Bundle',
      type: 'transaction',
      entry: [
        { fullUrl: 'urn:uuid:pat-1', resource: { resourceType: 'Patient', name: [{ text: 'Generated' }] }, request: { method: 'POST', url: 'Patient' } },
        { fullUrl: 'urn:uuid:cond-1', resource: { resourceType: 'Condition', code: { text: 'Generalized anxiety disorder' }, subject: { reference: 'urn:uuid:pat-1' } }, request: { method: 'POST', url: 'Condition' } },
        { fullUrl: 'urn:uuid:obs-1', resource: { resourceType: 'Observation', status: 'final', code: { text: 'PHQ-9 total score' } }, request: { method: 'POST', url: 'Observation' } },
      ],
    },
  };
}

describe('scribe-soap-note handler', () => {
  beforeEach(() => {
    mockCreateMulti.mockReset();
    mockList.mockReset();
    mockCreateTemplate.mockReset();
    mockCreateSummary.mockReset();
  });

  test('throws when transcript is empty', async () => {
    const handler = await loadHandler();
    await expect(handler(makeMedplum().medplum, makeEvent({ transcript: '  ' }))).rejects.toThrow(/No transcript/);
  });

  test('throws when patient has no id', async () => {
    const handler = await loadHandler();
    await expect(
      handler(makeMedplum().medplum, makeEvent({ patient: { resourceType: 'Patient' } }))
    ).rejects.toThrow(/patient/i);
  });

  test('throws when PhenoML credentials are missing', async () => {
    const handler = await loadHandler();
    const event = { input: { transcript: 'x', patient: PATIENT }, secrets: {} } as unknown as BotEvent<ScribeSoapNoteInput>;
    await expect(handler(makeMedplum().medplum, event)).rejects.toThrow(/PhenoML credentials/);
  });

  test('throws when the base url secret is missing (no default)', async () => {
    const handler = await loadHandler();
    await expect(handler(makeMedplum().medplum, makeEvent({}, false))).rejects.toThrow(/base url required/i);
  });

  test('extracts resources, persists them re-linked to the chart, and returns the SOAP note', async () => {
    mockCreateMulti.mockResolvedValue(extractionBundle());
    mockList.mockResolvedValue({ templates: [] });
    mockCreateTemplate.mockResolvedValue({ template_id: 'tpl-soap-1' });
    mockCreateSummary.mockResolvedValue({ success: true, summary: 'SUBJECTIVE: ...\nPLAN: ...', warnings: [] });
    const { medplum, executeBatch } = makeMedplum();
    const handler = await loadHandler();

    const result = await handler(medplum, makeEvent());

    // lang2fhir called with the raw transcript text (not base64) + medplum provider.
    expect(mockCreateMulti).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'patient reports anxiety and low mood', version: 'R4', provider: 'medplum' }),
      expect.objectContaining({ maxRetries: 0 })
    );

    // Extracted resources persisted, re-linked to the existing patient/encounter; generated Patient dropped.
    const transaction = executeBatch.mock.calls[0][0] as Bundle;
    const persistedTypes = (transaction.entry ?? []).map((e) => (e.resource as { resourceType?: string })?.resourceType);
    expect(persistedTypes).toEqual(['Condition', 'Observation']);
    const condition = transaction.entry?.[0].resource as { subject?: { reference?: string }; encounter?: { reference?: string } };
    expect(condition.subject?.reference).toBe('Patient/p1'); // rewritten from urn:uuid:pat-1
    expect(condition.encounter?.reference).toBe('Encounter/e1');
    const observation = transaction.entry?.[1].resource as { subject?: { reference?: string } };
    expect(observation.subject?.reference).toBe('Patient/p1'); // stamped (was missing)

    // Template created (absent) and summary generated in narrative mode against it.
    expect(mockCreateTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'soap-note-behavioral-health', mode: 'narrative', example_summary: expect.stringContaining('SUBJECTIVE') })
    );
    const [summaryReq] = mockCreateSummary.mock.calls[0];
    expect(summaryReq).toEqual(expect.objectContaining({ mode: 'narrative', template_id: 'tpl-soap-1' }));
    const summaryBundle = summaryReq.fhir_resources as Bundle;
    expect((summaryBundle.entry?.[0].resource as Patient).resourceType).toBe('Patient');

    expect(result.note).toBe('SUBJECTIVE: ...\nPLAN: ...');
    expect(result.createdResources).toEqual(['Condition/c1', 'Observation/o1']);
  });

  test('reuses the template on repeat calls (find-or-create once)', async () => {
    mockCreateMulti.mockResolvedValue(extractionBundle());
    mockList.mockResolvedValue({ templates: [] });
    mockCreateTemplate.mockResolvedValue({ template_id: 'tpl-soap-1' });
    mockCreateSummary.mockResolvedValue({ success: true, summary: 'note' });
    const { medplum } = makeMedplum();
    const handler = await loadHandler();

    await handler(medplum, makeEvent());
    await handler(medplum, makeEvent());

    expect(mockList).toHaveBeenCalledTimes(1);
    expect(mockCreateTemplate).toHaveBeenCalledTimes(1);
    expect(mockCreateSummary).toHaveBeenCalledTimes(2);
    expect(mockCreateMulti).toHaveBeenCalledTimes(2);
  });

  test('uses an existing template without creating a new one', async () => {
    mockCreateMulti.mockResolvedValue(extractionBundle());
    mockList.mockResolvedValue({ templates: [{ id: 'tpl-existing', name: 'soap-note-behavioral-health' }] });
    mockCreateSummary.mockResolvedValue({ success: true, summary: 'note' });
    const { medplum } = makeMedplum();
    const handler = await loadHandler();

    await handler(medplum, makeEvent());

    expect(mockCreateTemplate).not.toHaveBeenCalled();
    expect(mockCreateSummary.mock.calls[0][0]).toEqual(expect.objectContaining({ template_id: 'tpl-existing' }));
  });
});
