// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { BotEvent, MedplumClient, WithId } from '@medplum/core';
import {
  CPT,
  HTTP_HL7_ORG,
  HTTP_TERMINOLOGY_HL7_ORG,
  addProfileToResource,
  createReference,
} from '@medplum/core';
import type {
  Attachment,
  ChargeItem,
  ChargeItemDefinition,
  CodeableConcept,
  Coding,
  Condition,
  Encounter,
  Extension,
  Patient,
  Reference,
} from '@medplum/fhirtypes';
import { Buffer } from 'buffer';
import type { phenoml } from 'phenoml';
import { phenomlClient } from 'phenoml';

/**
 * Reviews one encounter's chart text with PhenoML Construe and immediately
 * creates the extracted diagnoses and charges. CPT usage is subject to AMA
 * requirements; see the PhenoML Terms of Service.
 */

interface BillingAcuityInput {
  encounterId: string;
}

export interface BillingAcuityResult {
  encounter: string;
  encounterId: string;
  createdConditions: { id: string; code: string; display?: string; citationCount: number }[];
  createdChargeItems: { id: string; code: string; display?: string }[];
  skippedDuplicateDiagnoses: string[];
  skippedDuplicateCharges: string[];
  warnings: string[];
  skippedAttachments: number;
}

interface TextGatherResult {
  text: string;
  warnings: string[];
  skippedAttachments: number;
}

interface CodeCandidate {
  code: string;
  display?: string;
  rationale?: string;
}

type ExtractCodesResult = phenoml.construe.ExtractCodesResult;
type ExtractedCodeResult = phenoml.construe.ExtractedCodeResult;
type ExtractRequest = phenoml.construe.ExtractRequest;
type Citation = phenoml.construe.Citation;

const CONSTRUE_TIMEOUT_SECONDS = 50;
const ICD10_CM = `${HTTP_HL7_ORG}/fhir/sid/icd-10-cm`;
const SERVICE_BILLING_CODE_URL = `${HTTP_HL7_ORG}/fhir/uv/order-catalog/StructureDefinition/ServiceBillingCode`;
const BILLING_ACUITY_SOURCE_EXTENSION_URL =
  'https://example.org/fhir/StructureDefinition/billing-acuity-source';
const BILLING_CITATION_EXTENSION_URL = 'https://example.org/fhir/StructureDefinition/billing-citation';
const BILLING_ACUITY_SOURCE = 'billing-acuity';

const CPT_EXTRACTION_CONTEXT = [
  'Outpatient medical billing for this clinic visit.',
  'Identify the evaluation-and-management office/outpatient visit code (range 99202-99215) and any documented procedures, based on the history, examination, medical decision making, and work performed today.',
  'Include a procedure code only when the service is explicitly documented as performed in the note.',
].join(' ');

const ICD_EXTRACTION_CONTEXT = [
  'Outpatient medical billing for this clinic visit.',
  "Code every confirmed, active diagnosis from the assessment / clinical impression that was evaluated or managed at today's encounter.",
  'Do NOT code findings that are denied, negative, normal, or ruled out.',
  'Do NOT code chronic problem-list or past-history conditions that were not addressed today.',
].join(' ');

export function isEmCode(code: string | undefined): boolean {
  return Boolean(code && /^992(0[2-9]|1[0-5])$/.test(code.trim()));
}

export async function handler(
  medplum: MedplumClient,
  event: BotEvent<BillingAcuityInput>
): Promise<BillingAcuityResult> {
  const clientId = event.secrets['PHENOML_CLIENT_ID']?.valueString;
  const clientSecret = event.secrets['PHENOML_CLIENT_SECRET']?.valueString;
  const baseUrl = event.secrets['PHENOML_BASE_URL']?.valueString;
  if (!clientId || !clientSecret) {
    throw new Error('PhenoML credentials (PHENOML_CLIENT_ID and PHENOML_CLIENT_SECRET) are required');
  }
  if (!baseUrl) {
    throw new Error('PhenoML base url required');
  }

  const encounterId = event.input.encounterId;
  if (!encounterId) {
    throw new Error('encounterId is required');
  }

  const encounter = await medplum.readResource('Encounter', encounterId);
  if (!encounter.subject?.reference) {
    throw new Error(`Encounter/${encounterId} has no patient subject`);
  }
  const patient = await medplum.readReference(encounter.subject as Reference<Patient>);
  const encounterRef = `Encounter/${encounter.id}`;
  const textResult = await gatherEncounterText(medplum, encounterRef);
  const combinedText = textResult.text.trim();
  if (!combinedText) {
    throw new Error(`No text found for ${encounterRef}`);
  }

  const warnings = [...textResult.warnings];
  const client = new phenomlClient({ clientId, clientSecret, baseUrl });
  const [cptSettled, icdSettled] = await Promise.allSettled([
    extractConstrueCodes(client, buildCptRequest(combinedText), baseUrl, 'CPT'),
    extractConstrueCodes(client, buildIcdRequest(combinedText), baseUrl, 'ICD-10-CM'),
  ]);
  const cptResult = getSettledResult(cptSettled, warnings);
  const icdResult = getSettledResult(icdSettled, warnings);
  if (!cptResult && !icdResult) {
    throw new Error(`PhenoML construe failed: ${warnings.join('; ')}`);
  }

  const existingDiagnosisCodes = new Set(await collectEncounterConditionCodes(medplum, encounter, warnings));
  const createdConditions: BillingAcuityResult['createdConditions'] = [];
  const skippedDuplicateDiagnoses: string[] = [];
  const diagnosis = [...(encounter.diagnosis ?? [])];

  for (const extracted of uniqueExtractedCodes(icdResult, normalizeIcdCode)) {
    const code = normalizeIcdCode(extracted.code);
    if (existingDiagnosisCodes.has(code)) {
      skippedDuplicateDiagnoses.push(code);
      continue;
    }

    const condition = await createIcdCondition(medplum, patient, encounter, extracted);
    existingDiagnosisCodes.add(code);
    diagnosis.push({ condition: createReference(condition), rank: diagnosis.length + 1 });
    createdConditions.push({
      id: condition.id,
      code,
      ...(extracted.description ? { display: extracted.description } : {}),
      citationCount: extracted.citations?.length ?? 0,
    });
  }
  if (createdConditions.length > 0) {
    await medplum.updateResource({ ...encounter, diagnosis });
  }

  const existingChargeItems = await medplum.searchResources('ChargeItem', `context=${encounterRef}`);
  const existingCptCodes = getCptCodes(existingChargeItems);
  let hasEmCode = Array.from(existingCptCodes).some(isEmCode);
  const createdChargeItems: BillingAcuityResult['createdChargeItems'] = [];
  const skippedDuplicateCharges: string[] = [];

  for (const extracted of uniqueExtractedCodes(cptResult, (code) => code.trim())) {
    const candidate: CodeCandidate = {
      code: extracted.code.trim(),
      ...(extracted.description ? { display: extracted.description } : {}),
      ...(extracted.reason ? { rationale: extracted.reason } : {}),
    };
    if (existingCptCodes.has(candidate.code) || (isEmCode(candidate.code) && hasEmCode)) {
      skippedDuplicateCharges.push(candidate.code);
      continue;
    }

    const chargeItem = await createCptChargeItem(medplum, patient, encounter, candidate);
    existingCptCodes.add(candidate.code);
    hasEmCode ||= isEmCode(candidate.code);
    createdChargeItems.push({ id: chargeItem.id, code: candidate.code, ...(candidate.display ? { display: candidate.display } : {}) });
  }

  return {
    encounter: encounterRef,
    encounterId: encounter.id,
    createdConditions,
    createdChargeItems,
    skippedDuplicateDiagnoses,
    skippedDuplicateCharges,
    warnings,
    skippedAttachments: textResult.skippedAttachments,
  };
}

async function gatherEncounterText(medplum: MedplumClient, encounterRef: string): Promise<TextGatherResult> {
  const warnings: string[] = [];
  let skippedAttachments = 0;
  const textParts: string[] = [];

  const clinicalImpressions = await medplum.searchResources('ClinicalImpression', `encounter=${encounterRef}`);
  const chartNote = clinicalImpressions[0]?.note?.[0]?.text;
  if (chartNote?.trim()) {
    textParts.push(chartNote);
  }

  const docRefs = await medplum.searchResources('DocumentReference', `encounter=${encounterRef}&status=current`);
  for (const docRef of docRefs) {
    for (const content of docRef.content ?? []) {
      const attachment = content.attachment;
      if (!isTextAttachment(attachment)) {
        skippedAttachments += 1;
        continue;
      }
      try {
        const text = await readTextAttachment(medplum, attachment);
        if (text.trim()) {
          textParts.push(text);
        }
      } catch (err) {
        warnings.push(
          `Failed to read text attachment from DocumentReference/${docRef.id ?? 'unknown'}: ${errorMessage(err)}`
        );
      }
    }
  }

  return { text: textParts.join('\n\n'), warnings, skippedAttachments };
}

function isTextAttachment(attachment: Attachment | undefined): attachment is Attachment {
  return Boolean(attachment?.contentType?.startsWith('text/'));
}

async function readTextAttachment(medplum: MedplumClient, attachment: Attachment): Promise<string> {
  if (attachment.data) {
    return Buffer.from(attachment.data, 'base64').toString('utf8');
  }
  if (attachment.url) {
    const blob = await medplum.download(attachment.url);
    return blob.text();
  }
  return '';
}

async function collectEncounterConditionCodes(
  medplum: MedplumClient,
  encounter: Encounter,
  warnings: string[]
): Promise<string[]> {
  const codes: string[] = [];
  for (const diagnosis of encounter.diagnosis ?? []) {
    const conditionRef = diagnosis.condition as Reference<Condition> | undefined;
    if (!conditionRef?.reference || conditionRef.reference.startsWith('#')) {
      continue;
    }
    try {
      const condition = await medplum.readReference(conditionRef);
      codes.push(...getIcd10CmCodes(condition));
    } catch (err) {
      warnings.push(`Failed to read ${conditionRef.reference}: ${errorMessage(err)}`);
    }
  }
  return Array.from(new Set(codes));
}

function getIcd10CmCodes(condition: Condition): string[] {
  return (
    condition.code?.coding
      ?.filter((coding) => coding.system === ICD10_CM && coding.code)
      .map((coding) => normalizeIcdCode(coding.code as string)) ?? []
  );
}

async function extractConstrueCodes(
  client: phenomlClient,
  request: ExtractRequest,
  baseUrl: string,
  label: string
): Promise<ExtractCodesResult> {
  try {
    return await client.construe.codes.extract(request, {
      timeoutInSeconds: CONSTRUE_TIMEOUT_SECONDS,
      maxRetries: 0,
    });
  } catch (err) {
    throw new Error(
      `${label} extraction failed (baseUrl=${baseUrl}, timeout=${CONSTRUE_TIMEOUT_SECONDS}s): ${errorMessage(err)}`
    );
  }
}

function buildCptRequest(text: string): ExtractRequest {
  return {
    text,
    system: { name: 'CPT', version: '2025' },
    config: {
      chunking_method: 'none',
      validation_method: 'simple',
      max_codes_per_chunk: 15,
      include_rationale: true,
      extraction_context: CPT_EXTRACTION_CONTEXT,
    },
  };
}

function buildIcdRequest(text: string): ExtractRequest {
  return {
    text,
    system: { name: 'ICD-10-CM', version: '2025' },
    config: {
      chunking_method: 'clinical_ner_extract',
      validation_method: 'simple',
      max_codes_per_chunk: 1,
      include_rationale: true,
      include_citations: true,
      extraction_context: ICD_EXTRACTION_CONTEXT,
    },
  };
}

function getSettledResult(
  settled: PromiseSettledResult<ExtractCodesResult>,
  warnings: string[]
): ExtractCodesResult | undefined {
  if (settled.status === 'fulfilled') {
    return settled.value;
  }
  warnings.push(errorMessage(settled.reason));
  return undefined;
}

function validExtractedCodes(result: ExtractCodesResult | undefined): ExtractedCodeResult[] {
  return result?.codes?.filter((code) => code.valid && Boolean(code.code?.trim())) ?? [];
}

function uniqueExtractedCodes(
  result: ExtractCodesResult | undefined,
  normalize: (code: string) => string
): ExtractedCodeResult[] {
  const codes = new Map<string, ExtractedCodeResult>();
  for (const extracted of validExtractedCodes(result)) {
    const code = normalize(extracted.code);
    if (code && !codes.has(code)) {
      codes.set(code, extracted);
    }
  }
  return Array.from(codes.values());
}

async function createIcdCondition(
  medplum: MedplumClient,
  patient: WithId<Patient>,
  encounter: WithId<Encounter>,
  extracted: ExtractedCodeResult
): Promise<WithId<Condition>> {
  const code = normalizeIcdCode(extracted.code);
  const condition = addProfileToResource<Condition>(
    {
      resourceType: 'Condition',
      category: [
        {
          coding: [
            {
              system: `${HTTP_TERMINOLOGY_HL7_ORG}/CodeSystem/condition-category`,
              code: 'problem-list-item',
              display: 'Problem List Item',
            },
          ],
          text: 'Problem List Item',
        },
      ],
      subject: createReference(patient),
      encounter: createReference(encounter),
      code: {
        coding: [{ system: ICD10_CM, code, ...(extracted.description ? { display: extracted.description } : {}) }],
        text: extracted.description ?? code,
      },
      clinicalStatus: {
        coding: [
          {
            system: `${HTTP_TERMINOLOGY_HL7_ORG}/CodeSystem/condition-clinical`,
            code: 'active',
            display: 'Active',
          },
        ],
      },
      extension: [billingSourceExtension(), ...(extracted.citations ?? []).map(citationExtension)],
      ...(extracted.reason ? { note: [{ text: extracted.reason }] } : {}),
    },
    `${HTTP_HL7_ORG}/fhir/us/core/StructureDefinition/us-core-condition-problems-health-concerns`
  );
  return medplum.createResource(condition);
}

function citationExtension(citation: Citation): Extension {
  return {
    url: BILLING_CITATION_EXTENSION_URL,
    extension: [
      { url: 'text', valueString: citation.text },
      { url: 'beginOffset', valueInteger: citation.begin_offset },
      { url: 'endOffset', valueInteger: citation.end_offset },
    ],
  };
}

function billingSourceExtension(): Extension {
  return { url: BILLING_ACUITY_SOURCE_EXTENSION_URL, valueString: BILLING_ACUITY_SOURCE };
}

function getCptCodes(chargeItems: ChargeItem[]): Set<string> {
  const codes = new Set<string>();
  for (const chargeItem of chargeItems) {
    for (const coding of chargeItem.code?.coding ?? []) {
      if (coding.system === CPT && coding.code) {
        codes.add(coding.code);
      }
    }
  }
  return codes;
}

async function createCptChargeItem(
  medplum: MedplumClient,
  patient: WithId<Patient>,
  encounter: WithId<Encounter>,
  candidate: CodeCandidate
): Promise<WithId<ChargeItem>> {
  const codeableConcept = buildCptConcept(candidate);
  const definitionUrl = await findChargeItemDefinitionUrl(medplum, candidate.code);
  return medplum.createResource({
    resourceType: 'ChargeItem',
    status: 'planned',
    subject: createReference(patient),
    context: createReference(encounter),
    occurrenceDateTime: encounter.period?.start ?? new Date().toISOString(),
    code: codeableConcept,
    quantity: { value: 1 },
    extension: [
      { url: SERVICE_BILLING_CODE_URL, valueCodeableConcept: codeableConcept },
      billingSourceExtension(),
    ],
    ...(candidate.rationale ? { note: [{ text: candidate.rationale }] } : {}),
    ...(definitionUrl ? { definitionCanonical: [definitionUrl] } : {}),
  });
}

function buildCptConcept(candidate: CodeCandidate): CodeableConcept {
  const coding: Coding = {
    system: CPT,
    code: candidate.code,
    ...(candidate.display ? { display: candidate.display } : {}),
  };
  return { coding: [coding], text: candidate.display ?? candidate.code };
}

async function findChargeItemDefinitionUrl(medplum: MedplumClient, code: string): Promise<string | undefined> {
  try {
    const definitions = await medplum.searchResources('ChargeItemDefinition', 'status=active&_count=100');
    return definitions.find((definition) => chargeItemDefinitionHasCode(definition, code))?.url;
  } catch {
    return undefined;
  }
}

function chargeItemDefinitionHasCode(definition: ChargeItemDefinition, code: string): boolean {
  return definition.code?.coding?.some((coding) => coding.system === CPT && coding.code === code) ?? false;
}

function normalizeIcdCode(code: string): string {
  return code.trim().toUpperCase();
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
