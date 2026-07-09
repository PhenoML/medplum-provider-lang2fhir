// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { Bundle, BundleEntry, Encounter, Patient, Reference } from '@medplum/fhirtypes';
import { phenomlClient } from 'phenoml';

/**
 * A Medplum Bot that turns a clinical visit transcript into a SOAP note using PhenoML, in two steps:
 *
 *   1. lang2fhir (`createMulti`) — extract the transcript's clinical concepts into a FHIR
 *      transaction Bundle (Conditions / Observations / MedicationRequests / Procedures / ...).
 *      `createMulti` is the text analog of `documentMulti` (which expects a PDF/image); the
 *      transcript is plain text, so we send it directly as `text`.
 *   2. Persist those resources to the patient's chart (executeBatch), re-linked to the existing
 *      Patient/Encounter so they appear in the Timeline right away.
 *   3. fhir2summary (`summary.create`, mode `narrative`) — render the saved resources into a SOAP
 *      note using a reusable narrative template (find-or-create by name, then reuse via template_id).
 *
 * The SOAP note itself is NOT persisted here — the UI shows it for clinician review/edit and creates
 * the DocumentReference on Save (mirrors the referral-intake / scribe review-before-persist pattern).
 *
 * Required bot secrets: (You need to have an active PhenoML subscription to use this bot)
 * - PHENOML_CLIENT_ID: Your PhenoML API client id
 * - PHENOML_CLIENT_SECRET: Your PhenoML API client secret
 * - PHENOML_BASE_URL: Your PhenoML environment base URL (e.g. https://phenohealth.app.pheno.ml).
 *   Credentials are tied to a specific environment, so this is required (no default) — same contract
 *   as referral-intake.ts.
 */

export interface ScribeSoapNoteInput {
  transcript: string;
  patient: Patient;
  encounter?: Reference<Encounter>;
}

export interface ScribeSoapNoteOutput {
  /** The generated SOAP note narrative (unsaved; the UI persists it as a DocumentReference). */
  note: string;
  /** Unresolved template placeholders / issues from fhir2summary, if any. */
  warnings?: string[];
  /** References (e.g. "Condition/123") of the extracted resources persisted to the chart. */
  createdResources: string[];
}

// Reusable narrative template registered with PhenoML once and reused via template_id thereafter.
const TEMPLATE_NAME = 'soap-note-behavioral-health';

// The template seed: a concrete, fully-worded example SOAP note (NOT a placeholder scaffold).
// PhenoML derives the reusable {{Resource.path}} template from this example.
const SOAP_EXAMPLE = `SUBJECTIVE:
Jordan Rivera is a 34-year-old patient seen for follow-up of anxiety and low mood, reporting on the past two weeks. The patient reports feeling nervous and on edge nearly every day and an inability to control worrying. They describe little interest or pleasure in activities and a depressed, hopeless mood more than half the days, with disrupted sleep, fatigue, poor appetite, and difficulty concentrating. The patient denies any thoughts of self-harm or of being better off dead.

OBJECTIVE:
GAD-7 total score 18, consistent with severe anxiety. PHQ-9 total score 19, consistent with moderately severe depression. No psychomotor slowing or agitation observed on exam.

ASSESSMENT:
1. Generalized anxiety disorder, severe.
2. Major depressive disorder, recurrent episode, moderate.
Symptoms are impairing daily functioning; suicide risk assessed as low with no active ideation.

PLAN:
1. Initiate sertraline 50 mg once daily.
2. Refer to cognitive behavioral therapy.
3. Follow up in two weeks to reassess GAD-7 and PHQ-9 scores and medication tolerability.`;

const TEMPLATE_TARGET_RESOURCES = [
  'Patient',
  'Condition',
  'Observation',
  'MedicationRequest',
  'Procedure',
  'QuestionnaireResponse',
];

// Bound PhenoML calls so a slow/unreachable endpoint fails clearly, well within the 120s Lambda
// timeout. maxRetries: 0 disables the SDK's default retries, which could otherwise stack past budget.
const PHENOML_TIMEOUT_SECONDS = 100;

// Warm-session cache of the resolved template id, so repeat calls skip the templates.list() lookup.
// Cold starts reset this; the find-or-create below rebuilds it.
let cachedTemplateId: string | undefined;

// Most clinical resources link to the patient via `subject`; a few use `patient`.
const PATIENT_FIELD_BY_TYPE: Record<string, 'subject' | 'patient'> = {
  AllergyIntolerance: 'patient',
  Immunization: 'patient',
};

// Resource types that carry an `encounter` reference we can safely stamp.
const ENCOUNTER_SUPPORTED_TYPES = new Set([
  'Condition',
  'Observation',
  'Procedure',
  'MedicationRequest',
  'ServiceRequest',
  'DiagnosticReport',
  'ClinicalImpression',
]);

type AnyResource = Record<string, unknown> & { resourceType?: string; id?: string };

// Links an extracted resource to the existing chart: sets the patient reference (subject/patient)
// when absent, and the encounter reference when the type supports one and an encounter was provided.
function linkResource(resource: AnyResource, patientRef: Reference<Patient>, encounterRef?: Reference<Encounter>): void {
  const type = resource.resourceType;
  if (!type) {
    return;
  }
  const field = PATIENT_FIELD_BY_TYPE[type] ?? 'subject';
  if (!resource[field]) {
    resource[field] = { reference: patientRef.reference, display: patientRef.display };
  }
  if (encounterRef?.reference && ENCOUNTER_SUPPORTED_TYPES.has(type) && !resource.encounter) {
    resource.encounter = { reference: encounterRef.reference };
  }
}

// Normalizes the createMulti transaction Bundle so it attaches to the existing Patient/Encounter:
// drops any model-generated Patient/Encounter entries, rewrites references to them onto the real
// chart resources, and stamps a patient (and encounter) link onto every remaining clinical resource.
// Returns a transaction Bundle ready for executeBatch.
function buildPersistTransaction(
  entries: BundleEntry[],
  patientRef: Reference<Patient>,
  encounterRef?: Reference<Encounter>
): Bundle {
  // Map the fullUrls of generated Patient/Encounter entries to the real chart references so any
  // intra-bundle references (urn:uuid) get rewritten before the entries are dropped.
  const referenceRewrites = new Map<string, string>();
  for (const entry of entries) {
    const resourceType = (entry.resource as AnyResource | undefined)?.resourceType;
    if (entry.fullUrl && resourceType === 'Patient' && patientRef.reference) {
      referenceRewrites.set(entry.fullUrl, patientRef.reference);
    }
    if (entry.fullUrl && resourceType === 'Encounter' && encounterRef?.reference) {
      referenceRewrites.set(entry.fullUrl, encounterRef.reference);
    }
  }

  let kept = entries.filter((entry) => {
    const resourceType = (entry.resource as AnyResource | undefined)?.resourceType;
    return resourceType !== 'Patient' && resourceType !== 'Encounter';
  });

  // Rewrite references to the dropped Patient/Encounter across the kept entries. fullUrls are unique
  // urn:uuid strings, so raw substring replacement is safe and preserves other inter-resource links.
  if (referenceRewrites.size > 0) {
    let json = JSON.stringify(kept);
    for (const [fromUrl, toReference] of referenceRewrites) {
      json = json.split(fromUrl).join(toReference);
    }
    kept = JSON.parse(json) as BundleEntry[];
  }

  return {
    resourceType: 'Bundle',
    type: 'transaction',
    entry: kept.map((entry): BundleEntry => {
      const resource = entry.resource as AnyResource;
      linkResource(resource, patientRef, encounterRef);
      return {
        fullUrl: entry.fullUrl,
        resource: entry.resource,
        request: entry.request ?? { method: 'POST', url: resource.resourceType ?? '' },
      };
    }),
  };
}

// Resolves the SOAP template id, creating the template from the example note only when it does not
// already exist. Caches the id for the warm session.
async function resolveTemplateId(client: InstanceType<typeof phenomlClient>): Promise<string> {
  if (cachedTemplateId) {
    return cachedTemplateId;
  }
  const { templates } = await client.summary.templates.list();
  const existing = templates?.find((template) => template.name === TEMPLATE_NAME)?.id;
  if (existing) {
    cachedTemplateId = existing;
    return existing;
  }
  const created = await client.summary.templates.create({
    name: TEMPLATE_NAME,
    mode: 'narrative',
    description:
      'Concise clinical SOAP note (Subjective / Objective / Assessment / Plan) for a behavioral-health visit.',
    target_resources: TEMPLATE_TARGET_RESOURCES,
    example_summary: SOAP_EXAMPLE,
  });
  const templateId = created.template_id ?? created.template?.id;
  if (!templateId) {
    throw new Error('PhenoML did not return a template id for the SOAP note template');
  }
  cachedTemplateId = templateId;
  return templateId;
}

export async function handler(
  medplum: MedplumClient,
  event: BotEvent<ScribeSoapNoteInput>
): Promise<ScribeSoapNoteOutput> {
  try {
    const { transcript, patient, encounter } = event.input;

    if (!transcript?.trim()) {
      throw new Error('No transcript provided to bot');
    }
    if (!patient?.id) {
      throw new Error('A patient (with id) is required');
    }

    const clientId = event.secrets['PHENOML_CLIENT_ID']?.valueString;
    const clientSecret = event.secrets['PHENOML_CLIENT_SECRET']?.valueString;
    if (!clientId || !clientSecret) {
      throw new Error('PhenoML credentials (PHENOML_CLIENT_ID and PHENOML_CLIENT_SECRET) are required');
    }
    // Base URL is tied to your PhenoML environment/tenant; required (no default) like referral-intake.
    const baseUrl = event.secrets['PHENOML_BASE_URL']?.valueString;
    if (!baseUrl) {
      throw new Error('PhenoML base url required');
    }

    // The SDK handles OAuth client-credentials auth automatically.
    const client = new phenomlClient({ clientId, clientSecret, baseUrl });

    const patientRef: Reference<Patient> = {
      reference: `Patient/${patient.id}`,
      display: patient.name?.[0]?.text ?? `Patient/${patient.id}`,
    };

    // 1. lang2fhir: transcript (plain text) -> transaction Bundle of clinical resources.
    const extraction = await client.lang2Fhir
      .createMulti(
        { text: transcript, version: 'R4', provider: 'medplum' },
        { timeoutInSeconds: PHENOML_TIMEOUT_SECONDS, maxRetries: 0 }
      )
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`lang2fhir create-multi failed (baseUrl=${baseUrl}): ${message}`);
      });

    const extractedEntries = (extraction.bundle?.entry ?? []) as BundleEntry[];

    // 2. Re-link to the existing chart and persist the extracted resources.
    const createdResources: string[] = [];
    let savedResources: AnyResource[] = [];
    if (extractedEntries.length > 0) {
      const transaction = buildPersistTransaction(extractedEntries, patientRef, encounter);
      if (transaction.entry && transaction.entry.length > 0) {
        const batchResult = await medplum.executeBatch(transaction);
        for (const entry of batchResult.entry ?? []) {
          const location = entry.response?.location;
          if (location) {
            createdResources.push(location.split('/').slice(0, 2).join('/'));
          }
          if (entry.resource) {
            savedResources.push(entry.resource as AnyResource);
          }
        }
        // Fall back to the resources we sent if the batch response didn't echo them.
        if (savedResources.length === 0) {
          savedResources = transaction.entry.map((entry) => entry.resource as AnyResource);
        }
      }
    }

    // 3. fhir2summary: render the saved resources into a SOAP note via the narrative template.
    const collectionBundle: Bundle = {
      resourceType: 'Bundle',
      type: 'collection',
      entry: [{ resource: patient }, ...savedResources.map((resource) => ({ resource: resource as never }))],
    };

    const templateId = await resolveTemplateId(client);
    const result = await client.summary.create(
      {
        mode: 'narrative',
        template_id: templateId,
        fhir_resources: collectionBundle as unknown as Record<string, unknown>,
      },
      { timeoutInSeconds: PHENOML_TIMEOUT_SECONDS, maxRetries: 0 }
    );

    return {
      note: result.summary ?? '',
      warnings: result.warnings,
      createdResources,
    };
  } catch (error) {
    throw new Error(`Bot execution failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
