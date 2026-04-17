// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { BotEvent, MedplumClient } from '@medplum/core';
import { QuestionnaireResponse, Observation, Procedure, Condition, Patient, MedicationRequest, CarePlan, PlanDefinition, Questionnaire, ResearchStudy } from '@medplum/fhirtypes';
import { PhenoMLClient, phenoml } from 'phenoml';

/**
 * A Medplum Bot that processes documents using the lang2fhir API.
 *
 * The bot will:
 * 1. Send the text to the lang2fhir API
 * 2. Create a FHIR resource of the type specified in the input
 * 3. Add the patient reference to the resource (if the resource is patient-dependent)
 *
 * Required bot secrets: (You need to have an active PhenoML subscription to use this bot)
 * - PHENOML_EMAIL: Your PhenoML API email
 * - PHENOML_PASSWORD: Your PhenoML API password
 */

interface CreateBotInput {
  text: string;
  resourceType: 'QuestionnaireResponse' | 'Observation' | 'Procedure' | 'Condition' | 'MedicationRequest' | 'CarePlan' | 'PlanDefinition' | 'Questionnaire' | 'ResearchStudy';
  patient?: Patient;
}

type AllowedResourceTypes = QuestionnaireResponse | Observation | Procedure | Condition | MedicationRequest | CarePlan | PlanDefinition | Questionnaire | ResearchStudy;

const PATIENT_INDEPENDENT_RESOURCES = ['PlanDefinition', 'Questionnaire', 'ResearchStudy'] as const;

// Maps input resource types to SDK resource profile types
// Uses 'auto' for types not explicitly supported by the SDK's type system
const RESOURCE_PROFILE_MAP: Record<string, phenoml.lang2Fhir.CreateRequest.Resource> = {
  'questionnaireresponse': 'questionnaireresponse',
  'observation': 'simple-observation',
  'procedure': 'procedure',
  'condition': 'condition-encounter-diagnosis',
  'medicationrequest': 'medicationrequest',
  'careplan': 'careplan',
  'plandefinition': 'auto',
  'questionnaire': 'questionnaire',
  'researchstudy': 'auto',
};

export async function handler(
  medplum: MedplumClient,
  event: BotEvent<CreateBotInput>
): Promise<AllowedResourceTypes> {
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

    // Limited set of resource types
    if (!['Questionnaire', 'QuestionnaireResponse', 'Observation', 'Procedure', 'Condition', 'MedicationRequest', 'CarePlan', 'PlanDefinition', 'ResearchStudy'].includes(inputResourceType)) {
      throw new Error(`Unsupported resource type: ${inputResourceType}`);
    }

    const targetResourceProfile = RESOURCE_PROFILE_MAP[inputResourceType.toLowerCase()];
    if (!targetResourceProfile) {
      throw new Error(`No profile mapping found for resource type: ${inputResourceType}`);
    }

    const email = event.secrets["PHENOML_EMAIL"].valueString as string;
    const password = event.secrets["PHENOML_PASSWORD"].valueString as string;

    // Initialize PhenoML client with automatic auth handling
    const phenomlClient = new PhenoMLClient({
      username: email,
      password,
      baseUrl: 'http://localhost:8090'  // Local PhenoML server
    });

    // Call lang2fhir create endpoint using SDK
    const generatedResource = await phenomlClient.lang2Fhir.create({
      version: 'R4',
      resource: targetResourceProfile,
      text: inputText
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
  if (!['QuestionnaireResponse', 'Observation', 'Procedure', 'Condition', 'MedicationRequest', 'CarePlan'].includes(resource.resourceType)) {
    throw new Error(`Unsupported resource type for patient reference: ${resource.resourceType}`);
  }

  resource.subject = {
    reference: `Patient/${patient.id}`,
    display: patient.name?.[0]?.text || `Patient/${patient.id}`
  };
}
