// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { BotEvent, MedplumClient } from '@medplum/core';
import type {
  CarePlan,
  Condition,
  MedicationRequest,
  Observation,
  Patient,
  PlanDefinition,
  Procedure,
  Questionnaire,
  QuestionnaireResponse,
  ResearchStudy,
} from '@medplum/fhirtypes';
import { phenomlClient } from 'phenoml';
import type { phenoml } from 'phenoml';

/**
 * A Medplum Bot that converts natural language text into a FHIR resource using the PhenoML lang2fhir API.
 *
 * The bot will:
 * 1. Send the text to the lang2fhir API (via the PhenoML TypeScript SDK)
 * 2. Create a FHIR resource of the type specified in the input
 * 3. Add the patient reference to the resource (if the resource is patient-dependent)
 *
 * Required bot secrets: (You need to have an active PhenoML subscription to use this bot)
 * - PHENOML_CLIENT_ID: Your PhenoML API client id
 * - PHENOML_CLIENT_SECRET: Your PhenoML API client secret
 */

interface CreateBotInput {
  text: string;
  resourceType:
    | 'QuestionnaireResponse'
    | 'Observation'
    | 'Procedure'
    | 'Condition'
    | 'MedicationRequest'
    | 'CarePlan'
    | 'PlanDefinition'
    | 'Questionnaire'
    | 'ResearchStudy';
  patient?: Patient;
}

type AllowedResourceTypes =
  | QuestionnaireResponse
  | Observation
  | Procedure
  | Condition
  | MedicationRequest
  | CarePlan
  | PlanDefinition
  | Questionnaire
  | ResearchStudy;

const PATIENT_INDEPENDENT_RESOURCES = ['PlanDefinition', 'Questionnaire', 'ResearchStudy'] as const;

// Maps input resource types to the SDK's lang2fhir profile identifiers.
// 'auto' is used for types without a dedicated US Core profile in the SDK.
const RESOURCE_PROFILE_MAP: Record<string, phenoml.lang2Fhir.CreateRequest.Resource> = {
  questionnaireresponse: 'questionnaireresponse',
  observation: 'simple-observation',
  procedure: 'procedure',
  condition: 'condition-encounter-diagnosis',
  medicationrequest: 'medicationrequest',
  careplan: 'careplan',
  plandefinition: 'auto',
  questionnaire: 'questionnaire',
  researchstudy: 'auto',
};

export async function handler(medplum: MedplumClient, event: BotEvent<CreateBotInput>): Promise<AllowedResourceTypes> {
  try {
    const { text: inputText, resourceType: inputResourceType, patient } = event.input;

    if (!inputText) {
      throw new Error('No text input provided to bot');
    }
    if (!inputResourceType) {
      throw new Error('No target resource type provided');
    }

    // Validate patient context for patient-dependent resources
    const requiresPatient = !PATIENT_INDEPENDENT_RESOURCES.includes(inputResourceType as any);
    if (requiresPatient && !patient) {
      throw new Error(`Patient context is required for resource type: ${inputResourceType}`);
    }

    const targetResourceProfile = RESOURCE_PROFILE_MAP[inputResourceType.toLowerCase()];
    if (!targetResourceProfile) {
      throw new Error(`Unsupported resource type: ${inputResourceType}`);
    }

    const clientId = event.secrets['PHENOML_CLIENT_ID']?.valueString;
    const clientSecret = event.secrets['PHENOML_CLIENT_SECRET']?.valueString;
    if (!clientId || !clientSecret) {
      throw new Error('PhenoML credentials (PHENOML_CLIENT_ID and PHENOML_CLIENT_SECRET) are required');
    }

    const baseUrl = event.secrets['PHENOML_BASE_URL']?.valueString;
    if (!baseUrl) {
      throw new Error('PHENOML_BASE_URL secret is required (e.g. https://phenohealth.app.pheno.ml)');
    }

    // The SDK handles OAuth client-credentials auth automatically.
    const client = new phenomlClient({ clientId, clientSecret, baseUrl });

    const generatedResource = await client.lang2Fhir.create({
      version: 'R4',
      resource: targetResourceProfile,
      text: inputText,
    });

    // Only add patient reference for patient-dependent resources
    if (requiresPatient && patient) {
      addPatientReference(generatedResource, patient);
    }

    return generatedResource as unknown as AllowedResourceTypes;
  } catch (error) {
    throw new Error(`Bot execution failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function addPatientReference(resource: any, patient: Patient): void {
  if (
    !['QuestionnaireResponse', 'Observation', 'Procedure', 'Condition', 'MedicationRequest', 'CarePlan'].includes(
      resource.resourceType
    )
  ) {
    throw new Error(`Unsupported resource type for patient reference: ${resource.resourceType}`);
  }

  resource.subject = {
    reference: `Patient/${patient.id}`,
    display: patient.name?.[0]?.text || `Patient/${patient.id}`,
  };
}
