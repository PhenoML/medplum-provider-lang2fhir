// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { BotEvent, MedplumClient, WithId } from '@medplum/core';
import { CPT, HTTP_HL7_ORG, createReference } from '@medplum/core';
import type {
  Attachment,
  ChargeItem,
  ChargeItemDefinition,
  CodeableConcept,
  Coding,
  Condition,
  Encounter,
  Patient,
  Reference,
} from '@medplum/fhirtypes';
import { Buffer } from 'buffer';
import type { phenoml } from 'phenoml';
import { phenomlClient } from 'phenoml';

/**
 * A Medplum Bot that checks the patient's most recent encounter for billing codes using
 * PhenoML construe. CPT usage is subject to AMA requirements; see PhenoML Terms of Service.
 */

interface BillingAcuityInput {
  patientId: string;
}

export interface BillingAcuityResult {
  encounter: string;
  encounterId: string;
  emCode: string;
  emRationale: { problemCount: number; problemCodes: string[]; riskHits: string[] };
  modelSuggestedEmCode?: string;
  createdChargeItems: { id: string; code: string; display?: string }[];
  skippedDuplicates: string[];
  extractedDiagnoses: { code: string; description?: string; rationale?: string }[];
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

const CONSTRUE_TIMEOUT_SECONDS = 50;
const ICD10_CM = `${HTTP_HL7_ORG}/fhir/sid/icd-10-cm`;
const SERVICE_BILLING_CODE_URL = `${HTTP_HL7_ORG}/fhir/uv/order-catalog/StructureDefinition/ServiceBillingCode`;
const RISK_PHRASES = ['prescription drug management', 'medication management', 'medication adjustment'];

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

const EM_DISPLAY: Record<string, string> = {
  '99212': 'Office/outpatient established patient visit, level 2',
  '99213': 'Office/outpatient established patient visit, level 3',
  '99214': 'Office/outpatient established patient visit, level 4',
  '99215': 'Office/outpatient established patient visit, level 5',
};

export function findRiskHits(text: string): string[] {
  const lower = text.toLowerCase();
  return RISK_PHRASES.filter((phrase) => lower.includes(phrase));
}

export function computeEmLevel(problemCodes: string[], riskHits: string[]): string {
  const problemCount = unique(problemCodes).length;
  const hasRisk = riskHits.length > 0;

  if (problemCount >= 6 && hasRisk) {
    return '99215';
  }
  if (problemCount >= 3 && hasRisk) {
    return '99214';
  }
  if (problemCount >= 2) {
    return '99213';
  }
  return '99212';
}

export function isEmCode(code: string | undefined): boolean {
  if (!code) {
    return false;
  }
  return /^992(0[2-9]|1[0-5])$/.test(code.trim());
}

export function pickMostRecentEncounter(encounters: Encounter[]): Encounter | undefined {
  if (encounters.length === 0) {
    return undefined;
  }

  let best = encounters[0];
  let bestTime = getEncounterSortTime(best);
  for (const encounter of encounters.slice(1)) {
    const time = getEncounterSortTime(encounter);
    if (time !== undefined && (bestTime === undefined || time > bestTime)) {
      best = encounter;
      bestTime = time;
    }
  }
  return best;
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

  const patientId = event.input.patientId;
  if (!patientId) {
    throw new Error('patientId is required');
  }

  const patient = await medplum.readResource('Patient', patientId);
  const encounters = await medplum.searchResources(
    'Encounter',
    `subject=Patient/${patientId}&_count=50&_sort=-_lastUpdated`
  );
  const selectedEncounter = pickMostRecentEncounter(encounters);
  if (!selectedEncounter?.id) {
    throw new Error(`No encounter found for Patient/${patientId}`);
  }

  const encounter = selectedEncounter as WithId<Encounter>;
  const encounterRef = `Encounter/${encounter.id}`;
  const textResult = await gatherEncounterText(medplum, encounterRef);
  const combinedText = textResult.text.trim();
  if (!combinedText) {
    throw new Error(`No text found for ${encounterRef}`);
  }

  const warnings = [...textResult.warnings];
  const conditionProblemCodes = await collectEncounterConditionCodes(medplum, encounter, warnings);
  const client = new phenomlClient({ clientId, clientSecret, baseUrl });

  const [cptSettled, icdSettled] = await Promise.allSettled([
    extractConstrueCodes(client, buildCptRequest(combinedText), baseUrl, 'CPT'),
    extractConstrueCodes(client, buildIcdRequest(combinedText), baseUrl, 'ICD-10-CM'),
  ]);

  const cptResult = getSettledResult(cptSettled, warnings);
  const icdResult = getSettledResult(icdSettled, warnings);

  if (!cptResult && !icdResult && conditionProblemCodes.length === 0) {
    throw new Error(`PhenoML construe failed and no encounter Conditions were available: ${warnings.join('; ')}`);
  }

  const validIcdCodes = validExtractedCodes(icdResult);
  const extractedDiagnoses = validIcdCodes.map((code) => ({
    code: normalizeProblemCode(code.code),
    description: code.description,
    rationale: code.reason,
  }));
  const problemCodes = unique([
    ...conditionProblemCodes,
    ...validIcdCodes.map((code) => normalizeProblemCode(code.code)),
  ]);
  const riskHits = findRiskHits(combinedText);
  const emCode = computeEmLevel(problemCodes, riskHits);
  const modelSuggestedEmCode = validExtractedCodes(cptResult).find((code) => isEmCode(code.code))?.code;
  const procedureCandidates = getProcedureCandidates(cptResult);

  const candidates: CodeCandidate[] = [
    {
      code: emCode,
      display: EM_DISPLAY[emCode],
      rationale: buildEmRationale(problemCodes, riskHits, modelSuggestedEmCode),
    },
    ...procedureCandidates,
  ];

  const existingChargeItems = await medplum.searchResources('ChargeItem', `context=${encounterRef}`);
  const existingCptCodes = getCptCodes(existingChargeItems);
  const hasExistingEmCode = Array.from(existingCptCodes).some(isEmCode);
  const skippedDuplicates: string[] = [];
  const createdChargeItems: { id: string; code: string; display?: string }[] = [];

  for (const candidate of candidates) {
    // An encounter carries only one office-visit E/M code, so skip the E/M candidate when
    // any E/M ChargeItem already exists (even at a different level), not just on an exact match.
    if (existingCptCodes.has(candidate.code) || (isEmCode(candidate.code) && hasExistingEmCode)) {
      skippedDuplicates.push(candidate.code);
      continue;
    }

    const chargeItem = await createCptChargeItem(medplum, patient, encounter, candidate);
    existingCptCodes.add(candidate.code);
    createdChargeItems.push({ id: chargeItem.id, code: candidate.code, display: candidate.display });
  }

  return {
    encounter: encounterRef,
    encounterId: encounter.id,
    emCode,
    emRationale: { problemCount: problemCodes.length, problemCodes, riskHits },
    modelSuggestedEmCode,
    createdChargeItems,
    skippedDuplicates,
    extractedDiagnoses,
    warnings,
    skippedAttachments: textResult.skippedAttachments,
  };
}

async function gatherEncounterText(medplum: MedplumClient, encounterRef: string): Promise<TextGatherResult> {
  const warnings: string[] = [];
  let skippedAttachments = 0;
  const textParts: string[] = [];

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

  const clinicalImpressions = await medplum.searchResources('ClinicalImpression', `encounter=${encounterRef}`);
  const chartNote = clinicalImpressions[0]?.note?.[0]?.text;
  if (chartNote?.trim()) {
    textParts.push(chartNote);
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

  return unique(codes);
}

function getIcd10CmCodes(condition: Condition): string[] {
  return (
    condition.code?.coding
      ?.filter((coding) => coding.system === ICD10_CM && coding.code)
      .map((coding) => normalizeProblemCode(coding.code as string)) ?? []
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
  return result?.codes?.filter(isValidExtractedCode) ?? [];
}

function isValidExtractedCode(code: ExtractedCodeResult): boolean {
  const valid = (code as { valid?: boolean }).valid;
  return valid !== false && Boolean(code.code?.trim());
}

function getProcedureCandidates(result: ExtractCodesResult | undefined): CodeCandidate[] {
  const candidates = new Map<string, CodeCandidate>();

  for (const code of validExtractedCodes(result)) {
    const normalizedCode = code.code.trim();
    if (isEmCode(normalizedCode) || candidates.has(normalizedCode)) {
      continue;
    }
    candidates.set(normalizedCode, {
      code: normalizedCode,
      display: code.description,
      rationale: code.reason,
    });
  }

  return Array.from(candidates.values());
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
  const chargeItem: ChargeItem = {
    resourceType: 'ChargeItem',
    status: 'planned',
    subject: createReference(patient),
    context: createReference(encounter),
    occurrenceDateTime: encounter.period?.start ?? new Date().toISOString(),
    code: codeableConcept,
    quantity: { value: 1 },
    extension: [{ url: SERVICE_BILLING_CODE_URL, valueCodeableConcept: codeableConcept }],
    ...(candidate.rationale ? { note: [{ text: candidate.rationale }] } : {}),
    ...(definitionUrl ? { definitionCanonical: [definitionUrl] } : {}),
  };

  return medplum.createResource(chargeItem);
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
    // ChargeItemDefinition has no `code` search parameter in FHIR R4, so filter client-side.
    const definitions = await medplum.searchResources('ChargeItemDefinition', 'status=active&_count=100');
    return definitions.find((definition) => chargeItemDefinitionHasCode(definition, code))?.url;
  } catch {
    return undefined;
  }
}

function chargeItemDefinitionHasCode(definition: ChargeItemDefinition, code: string): boolean {
  return definition.code?.coding?.some((coding) => coding.system === CPT && coding.code === code) ?? false;
}

function buildEmRationale(
  problemCodes: string[],
  riskHits: string[],
  modelSuggestedEmCode: string | undefined
): string {
  const parts = [
    `E/M heuristic selected from ${problemCodes.length} problem(s)`,
    `problems: ${problemCodes.join(', ') || 'none'}`,
    `risk hits: ${riskHits.join(', ') || 'none'}`,
  ];
  if (modelSuggestedEmCode) {
    parts.push(`model suggested E/M: ${modelSuggestedEmCode}`);
  }
  return parts.join('; ');
}

function getEncounterSortTime(encounter: Encounter): number | undefined {
  return parseTime(encounter.period?.start) ?? parseTime(encounter.meta?.lastUpdated);
}

function parseTime(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function normalizeProblemCode(code: string): string {
  return code.trim().toUpperCase();
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
