import { BotEvent, MedplumClient } from '@medplum/core';
import { QuestionnaireResponse, Observation, Procedure, Condition, Patient, MedicationRequest, CarePlan, PlanDefinition, Questionnaire } from '@medplum/fhirtypes';
import { Buffer } from 'buffer';

/**
 * A Medplum Bot that processes documents using the lang2fhir API.
 * 
 * Example inputs:
 * Patient-dependent:
 * {
 *   "text": "Advise patient to avoid heavy lifting and replace bandages daily",
 *   "resourceType": "CarePlan",
 *   "patient": { ... }
 * }
 * 
 * Patient-independent:
 * {
 *   "text": "Assess patient's pain levels using a scale of 1-10",
 *   "resourceType": "Questionnaire"
 * }
 * 
 * The bot will:
 * 1. Send the text to the lang2fhir API
 * 2. Create a FHIR resource of the type specified in the input
 * 3. Add the patient reference to the resource
 * 
 * Required bot secrets: (You need to have an active PhenoML subscription to use this bot)
 * - PHENOML_EMAIL: Your PhenoML API email
 * - PHENOML_PASSWORD: Your PhenoML API password
 */

interface CreateRequest {
  text: string;
  version: string;
  resource: string;
}

interface CreateBotInput {
  text: string;
  resourceType: 'QuestionnaireResponse' | 'Observation' | 'Procedure' | 'Condition' | 'MedicationRequest' | 'CarePlan' | 'PlanDefinition' | 'Questionnaire';
  patient?: Patient;
}

type AllowedResourceTypes = QuestionnaireResponse | Observation | Procedure | Condition | MedicationRequest | CarePlan | PlanDefinition | Questionnaire;

const PATIENT_INDEPENDENT_RESOURCES = ['PlanDefinition', 'Questionnaire'] as const;
const PHENOML_API_URL = "https://experiment.pheno.ml";

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
    if (!['Questionnaire', 'QuestionnaireResponse', 'Observation', 'Procedure', 'Condition', 'MedicationRequest', 'CarePlan', 'PlanDefinition'].includes(inputResourceType)) {
      throw new Error(`Unsupported resource type: ${inputResourceType}`);
    }

    const targetResourceType = inputResourceType.toLowerCase();

    // Transform to specific profiles
    let targetResourceProfile: string;
    switch (targetResourceType) {
      case 'observation':
        targetResourceProfile = 'simple-observation';
        break;
      case 'condition':
        targetResourceProfile = 'condition-encounter-diagnosis';
        break;
      default:
        targetResourceProfile = targetResourceType;
    }

    const email = event.secrets["PHENOML_EMAIL"].valueString as string;
    const password = event.secrets["PHENOML_PASSWORD"].valueString as string;

    // Auth handling remains the same
    const credentials = Buffer.from(`${email}:${password}`).toString('base64');
    const authResponse = await fetch(PHENOML_API_URL + '/auth/token', {
      method: 'POST',
      headers: { 
        'Accept': 'application/json',
        'Authorization': `Basic ${credentials}`
      },
    }).catch(error => {
      throw new Error(`Failed to connect to PhenoML API: ${error.message}`);
    }); 
    
    if (!authResponse.ok) {
      throw new Error(`Authentication failed: ${authResponse.status} ${authResponse.statusText}`);
    }

    const { token: bearerToken } = await authResponse.json() as { token: string };
    if (!bearerToken) {
      throw new Error('No token received from auth response');
    }

    const createRequest: CreateRequest = {
      version: 'R4',
      resource: targetResourceProfile,
      text: inputText
    };

    const createResponse = await fetch(PHENOML_API_URL + '/lang2fhir/create', {
      method: "POST",
      body: JSON.stringify(createRequest), 
      headers: { 
        'Authorization': `Bearer ${bearerToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
    });

    if (!createResponse.ok) {
      throw new Error(`Create failed: ${createResponse.status} ${createResponse.statusText}`);
    }

    const generatedResource = await createResponse.json();
    
    // Only add patient reference for patient-dependent resources
    if (requiresPatient && patient) {
      addPatientReference(generatedResource, patient);
    }

    return generatedResource as AllowedResourceTypes;
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