// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { BotEvent, MedplumClient } from '@medplum/core';
import { formatHumanName } from '@medplum/core';
import type { Bundle, Coverage, Patient } from '@medplum/fhirtypes';
import { phenomlClient } from 'phenoml';

/**
 * A Medplum Bot that drafts a payer-rule-aware prior-authorization narrative using PhenoML's
 * fhir2summary "narrative" mode.
 *
 * The bot is intentionally thin: it assembles the patient's whole clinical bundle (IPS-style) and
 * hands it to fhir2summary together with a payer-rule-aware template. All of the "prior-auth
 * intelligence" — selecting the relevant diagnosis, checking PHQ-9 severity, reasoning about failed
 * medication trials, and formatting the narrative against the payer's criteria — lives in
 * fhir2summary and the template's example summary, NOT in this bot. The bot does not evaluate
 * criteria and does not persist anything; the clinician reviews/edits the returned narrative in the
 * UI and the UI persists it as a DocumentReference (+ optional Communication) on save.
 *
 * The template is created lazily on first use (find-or-create by name), so no separate one-time
 * setup step or template-id secret is required.
 *
 * Required bot secrets: (You need an active PhenoML subscription to use this bot)
 * - PHENOML_CLIENT_ID: Your PhenoML API client id
 * - PHENOML_CLIENT_SECRET: Your PhenoML API client secret
 * - PHENOML_BASE_URL: Your PhenoML environment base URL (e.g. https://phenohealth.app.pheno.ml).
 *   Credentials are tied to a specific environment, so this must match where your credentials live.
 */

export interface PriorAuthDraftInput {
  /** The patient to draft a prior authorization for. */
  patientId: string;
  /**
   * The encounter the draft is associated with. Not used by the bot to build the bundle; the UI
   * uses it to set DocumentReference.context.encounter when persisting the reviewed narrative.
   */
  encounterId?: string;
}

export interface PriorAuthDraftOutput {
  /** Whether the narrative was generated successfully. */
  success: boolean;
  /** Status message. */
  message: string;
  /** The generated prior-authorization narrative for the clinician to edit. */
  narrative?: string;
  /** Unresolved placeholders or issues reported by fhir2summary (narrative mode only). */
  warnings?: string[];
  /** The template id used (created on first run). */
  templateId?: string;
}

// Stable template name used for idempotent find-or-create. Bumping the example summary below does
// not change the name, so update an existing template via the PhenoML API if you need to re-seed.
const TEMPLATE_NAME = 'prior-auth-rtms-cascade-bh';

// FHIR resource types the payer-rule template can draw on.
const TEMPLATE_TARGET_RESOURCES = [
  'Patient',
  'Coverage',
  'Organization',
  'Condition',
  'ServiceRequest',
  'Observation',
  'MedicationStatement',
  'MedicationRequest',
];

// Clinical resource types pulled into the patient bundle. Mirrors the IPS bot's list and adds the
// resources a prior auth needs: the planned procedure (ServiceRequest) and the payer (Coverage +
// its Organization, dereferenced below).
const CLINICAL_RESOURCE_TYPES = [
  'AllergyIntolerance',
  'Condition',
  'MedicationRequest',
  'MedicationStatement',
  'Immunization',
  'Procedure',
  'Observation',
  'ServiceRequest',
  'Coverage',
] as const;

// Bound PhenoML calls so a slow/unreachable endpoint fails with a clear error well within the bot's
// Lambda timeout (Bot.timeout is 120s in deploy-bots.ts). maxRetries: 0 disables the SDK's default
// retries, which can otherwise stack up past the budget.
const CALL_TIMEOUT_SECONDS = 100;

// A concrete, fully-worded example prior-authorization narrative. PhenoML's template create endpoint
// generates a reusable narrative template (with {{resource.field}} placeholders) from this example,
// so it is written as a filled-in example for a *hypothetical* member — not as Maya Chen and not as a
// placeholder scaffold. The manufactured payer ("Cascade Behavioral Health Plan") and its policy
// (BH-TMS-2026) criteria are woven into the prose so generated narratives are payer-rule-aware.
const EXAMPLE_SUMMARY = `PRIOR AUTHORIZATION REQUEST — Cascade Behavioral Health Plan
Policy BH-TMS-2026: Repetitive Transcranial Magnetic Stimulation (rTMS) for Treatment-Resistant Major Depressive Disorder

Member: Jordan Rivera (DOB 1988-06-14), Member ID CBH-100238, Cascade Behavioral Health Plan.
Date of request: 2026-02-10.

Requested service: Repetitive transcranial magnetic stimulation (rTMS), initial treatment course, CPT 90867.

Clinical justification against Cascade Behavioral Health Plan policy BH-TMS-2026:
1. Qualifying diagnosis: The member carries a confirmed diagnosis of major depressive disorder, recurrent, moderate (ICD-10 F33.1), meeting the policy requirement for major depressive disorder (F32.x or F33.x). CRITERION MET.
2. Symptom severity: The most recent PHQ-9 score is 19 (recorded 2026-02-01), consistent with moderately severe depression and satisfying the policy threshold of PHQ-9 greater than or equal to 15 documented within the prior 60 days. A concurrent GAD-7 score of 14 documents comorbid anxiety. CRITERION MET.
3. Failed pharmacotherapy: The member completed an adequate trial of sertraline 100 mg daily for 8 weeks with inadequate response, meeting the policy requirement of at least one adequate antidepressant trial (at least 4 weeks at a therapeutic dose) in the current episode. CRITERION MET.
4. TMS candidacy: The member has no ferromagnetic implants and no history of seizure disorder, and there are no contraindications to TMS. CRITERION MET.
5. Monitoring plan: The treating clinician will administer the PHQ-9 at baseline and at least every two weeks throughout the rTMS course to document treatment response, satisfying the policy's outcome-monitoring requirement. CRITERION MET.

Determination summary: Based on the documentation above, this request meets the criteria of Cascade Behavioral Health Plan policy BH-TMS-2026, and prior authorization for an initial course of rTMS is recommended for approval.`;

export async function handler(
  medplum: MedplumClient,
  event: BotEvent<PriorAuthDraftInput>
): Promise<PriorAuthDraftOutput> {
  const { patientId } = event.input;
  if (!patientId) {
    throw new Error('patientId is required');
  }

  const clientId = event.secrets['PHENOML_CLIENT_ID']?.valueString;
  const clientSecret = event.secrets['PHENOML_CLIENT_SECRET']?.valueString;
  if (!clientId || !clientSecret) {
    throw new Error('PhenoML credentials (PHENOML_CLIENT_ID and PHENOML_CLIENT_SECRET) are required');
  }

  // Credentials are tied to a specific PhenoML environment; require the base URL explicitly rather
  // than defaulting, matching the referral-intake bot.
  const baseUrl = event.secrets['PHENOML_BASE_URL']?.valueString;
  if (!baseUrl) {
    throw new Error('PHENOML_BASE_URL secret is required (e.g. https://phenohealth.app.pheno.ml)');
  }

  const client = new phenomlClient({ clientId, clientSecret, baseUrl });
  const bundle = await buildPatientBundle(medplum, patientId);

  try {
    const templateId = await resolveTemplateId(client);
    const result = await client.summary.create(
      {
        mode: 'narrative',
        template_id: templateId,
        fhir_resources: bundle as unknown as Record<string, unknown>,
      },
      { timeoutInSeconds: CALL_TIMEOUT_SECONDS, maxRetries: 0 }
    );

    return {
      success: result.success ?? false,
      message: result.message ?? 'Prior authorization narrative generated',
      narrative: result.summary,
      warnings: result.warnings,
      templateId,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Prior auth draft generation failed (baseUrl=${baseUrl}): ${message}`);
  }
}

/**
 * Idempotently resolves the prior-auth template id: looks up the template by name and creates it if
 * it does not exist yet. This keeps template management zero-config for the demo.
 * @param client - An authenticated PhenoML client.
 * @returns The id of the prior-auth narrative template.
 */
async function resolveTemplateId(client: phenomlClient): Promise<string> {
  const requestOptions = { timeoutInSeconds: CALL_TIMEOUT_SECONDS, maxRetries: 0 };

  const list = await client.summary.templates.list(requestOptions);
  const existing = list.templates?.find((template) => template.name === TEMPLATE_NAME);
  if (existing?.id) {
    return existing.id;
  }

  const created = await client.summary.templates.create(
    {
      name: TEMPLATE_NAME,
      description:
        'Prior authorization request narrative for rTMS under Cascade Behavioral Health Plan policy BH-TMS-2026.',
      example_summary: EXAMPLE_SUMMARY,
      target_resources: TEMPLATE_TARGET_RESOURCES,
      mode: 'narrative',
    },
    requestOptions
  );

  if (!created.template_id) {
    throw new Error(created.message ?? 'Failed to create prior-auth narrative template');
  }
  return created.template_id;
}

/**
 * Ensures every HumanName carries a `text` (full display name), computing it from given/family when
 * absent. The generated fhir2summary template references `{{Patient.name[0].text}}`, which most FHIR
 * patients leave empty (they store given/family instead) — producing an "Unresolved placeholder"
 * warning. Filling it in from the structured name parts lets the placeholder resolve. Operates on a
 * copy; the stored Patient is never mutated.
 * @param patient - The patient read from Medplum.
 * @returns A copy of the patient with `name[].text` populated where it was missing.
 */
function normalizePatientName(patient: Patient): Patient {
  if (!patient.name?.length) {
    return patient;
  }
  return {
    ...patient,
    name: patient.name.map((name) => (name.text ? name : { ...name, text: formatHumanName(name) || undefined })),
  };
}

/**
 * Builds a FHIR collection Bundle containing the patient and their clinical resources, plus the
 * payer Organization(s) referenced by any Coverage. No filtering or resource-selection logic —
 * fhir2summary and the template decide what is relevant.
 * @param medplum - The Medplum client instance.
 * @param patientId - The patient to build the bundle for.
 * @returns A FHIR collection Bundle of the patient's clinical data and payer organizations.
 */
async function buildPatientBundle(medplum: MedplumClient, patientId: string): Promise<Bundle> {
  const patient = await medplum.readResource('Patient', patientId);
  if (!patient) {
    throw new Error(`Patient not found: ${patientId}`);
  }

  const bundle: Bundle = {
    resourceType: 'Bundle',
    type: 'collection',
    entry: [{ resource: normalizePatientName(patient) }],
  };

  const payorReferences = new Set<string>();

  for (const resourceType of CLINICAL_RESOURCE_TYPES) {
    try {
      const resources = await medplum.searchResources(resourceType, {
        patient: `Patient/${patientId}`,
        _count: '100',
      });

      for (const resource of resources) {
        bundle.entry?.push({ resource });
        if (resource.resourceType === 'Coverage') {
          for (const payor of (resource as Coverage).payor ?? []) {
            if (payor.reference) {
              payorReferences.add(payor.reference);
            }
          }
        }
      }
    } catch {
      // Some resource types may not exist or use different search params; skip them.
    }
  }

  // Dereference payer Organizations so the narrative can name the payer and its policy.
  for (const reference of payorReferences) {
    if (!reference.startsWith('Organization/')) {
      continue;
    }
    try {
      const organization = await medplum.readReference({ reference });
      bundle.entry?.push({ resource: organization });
    } catch {
      // Skip payers that can't be resolved (e.g. self-pay coverage points at a Patient).
    }
  }

  return bundle;
}
