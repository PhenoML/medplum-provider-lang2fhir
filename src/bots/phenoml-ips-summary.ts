// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { Bundle } from '@medplum/fhirtypes';
import { phenomlClient } from 'phenoml';

/**
 * A Medplum Bot that generates an International Patient Summary (IPS) using PhenoML.
 *
 * The IPS is a standardized patient summary per ISO 27269/HL7 FHIR IPS IG that includes:
 * - Patient demographics
 * - Allergies and intolerances
 * - Medications
 * - Problems/Conditions
 * - Immunizations
 * - Procedures
 * - Vital signs
 *
 * This bot can either:
 * 1. Accept a patientId and fetch the patient's data from Medplum
 * 2. Accept a pre-built FHIR Bundle with patient and related resources
 *
 * Required bot secrets: (You need to have an active PhenoML subscription to use this bot)
 * - PHENOML_CLIENT_ID: Your PhenoML API client id
 * - PHENOML_CLIENT_SECRET: Your PhenoML API client secret
 */

export interface IpsSummaryBotInput {
  /** The patient ID to generate IPS for (will fetch data from Medplum) */
  patientId?: string;
  /** Pre-built FHIR Bundle with patient and related resources */
  bundle?: Bundle;
}

export interface IpsSummaryBotOutput {
  /** Whether the IPS generation was successful */
  success: boolean;
  /** Status message */
  message: string;
  /** The generated IPS narrative summary */
  summary?: string;
  /** Any warnings from the generation process */
  warnings?: string[];
}

const PHENOML_BASE_URL = 'https://experiment.app.pheno.ml';

// Resource types to include in the IPS Bundle
const IPS_RESOURCE_TYPES = [
  'AllergyIntolerance',
  'Condition',
  'MedicationRequest',
  'MedicationStatement',
  'Immunization',
  'Procedure',
  'Observation',
] as const;

export async function handler(
  medplum: MedplumClient,
  event: BotEvent<IpsSummaryBotInput>
): Promise<IpsSummaryBotOutput> {
  try {
    const { patientId, bundle: inputBundle } = event.input;

    // Validate input - need either patientId or bundle
    if (!patientId && !inputBundle) {
      throw new Error('Either patientId or bundle is required');
    }

    const clientId = event.secrets['PHENOML_CLIENT_ID']?.valueString;
    const clientSecret = event.secrets['PHENOML_CLIENT_SECRET']?.valueString;

    if (!clientId || !clientSecret) {
      throw new Error('PhenoML credentials (PHENOML_CLIENT_ID and PHENOML_CLIENT_SECRET) are required');
    }

    // Build or use the provided bundle
    let fhirBundle: Bundle;
    if (inputBundle) {
      fhirBundle = inputBundle;
    } else if (patientId) {
      fhirBundle = await buildPatientBundle(medplum, patientId);
    } else {
      throw new Error('Either patientId or bundle is required');
    }

    // The SDK handles OAuth client-credentials auth automatically.
    const client = new phenomlClient({ clientId, clientSecret, baseUrl: PHENOML_BASE_URL });

    // Generate IPS summary
    const result = await client.summary.create({
      mode: 'ips',
      fhir_resources: fhirBundle as unknown as Record<string, unknown>,
    });

    return {
      success: result.success ?? false,
      message: result.message ?? 'IPS generated',
      summary: result.summary,
      warnings: result.warnings,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`IPS summary generation failed: ${errorMessage}`);
  }
}

/**
 * Builds a FHIR Bundle containing the patient and related IPS resources.
 * @param medplum - The Medplum client instance
 * @param patientId - The patient ID to fetch resources for
 * @returns A FHIR Bundle containing the patient and related resources
 */
async function buildPatientBundle(medplum: MedplumClient, patientId: string): Promise<Bundle> {
  // Fetch the patient
  const patient = await medplum.readResource('Patient', patientId);
  if (!patient) {
    throw new Error(`Patient not found: ${patientId}`);
  }

  // Initialize bundle with patient
  const bundle: Bundle = {
    resourceType: 'Bundle',
    type: 'collection',
    entry: [{ resource: patient }],
  };

  // Fetch related resources for each IPS resource type
  for (const resourceType of IPS_RESOURCE_TYPES) {
    try {
      const resources = await medplum.searchResources(resourceType, {
        patient: `Patient/${patientId}`,
        _count: '100',
      });

      for (const resource of resources) {
        bundle.entry?.push({ resource });
      }
    } catch {
      // Some resource types may not exist or use different search params; skip them.
    }
  }

  return bundle;
}
