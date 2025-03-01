import { BotEvent, MedplumClient } from '@medplum/core';
import { QuestionnaireResponse, Observation, Procedure, Condition, Patient, MedicationRequest, CarePlan } from '@medplum/fhirtypes';
import { Buffer } from 'buffer';

/**
 * A Medplum Bot that processes documents using the lang2fhir API.
 * 
 * Example input:
 * {
 *   "text": "Advise patient to avoid heavy lifting and replace bandages daily",
 *   "resourceType": "CarePlan"
 * }
 * 
 * The bot will:
 * 1. Send the text to the lang2fhir API
 * 2. Create a FHIR resource of the type specified in the input
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
  resourceType: 'QuestionnaireResponse' | 'Observation' | 'Procedure' | 'Condition' | 'MedicationRequest' | 'CarePlan' ;
  patient: Patient;
}

type AllowedResourceTypes = QuestionnaireResponse | Observation | Procedure | Condition | MedicationRequest | CarePlan ;


const PHENOML_API_URL = "https://experiment.pheno.ml";

function addPatientReference(resource: any, patient: Patient): void {
  switch (resource.resourceType) {
    case 'QuestionnaireResponse':
    case 'Observation':
    case 'Procedure':
    case 'Condition':
    case 'MedicationRequest':
    case 'CarePlan':
      resource.subject = {
        reference: `Patient/${patient.id}`,
        display: patient.name?.[0]?.text || `Patient/${patient.id}`
      };
      break;
    case 'Task':
      resource.for = {
        reference: `Patient/${patient.id}`,
        display: patient.name?.[0]?.text || `Patient/${patient.id}`
      };
      break;
    default:
      throw new Error(`Unsupported resource type: ${resource.resourceType}`);
  }
}

export async function handler(
  medplum: MedplumClient, 
  event: BotEvent<CreateBotInput>
): Promise<AllowedResourceTypes> {
  try {
    console.log('Starting bot execution with event:', JSON.stringify(event, null, 2));

    const inputText = event.input.text;
    const inputResourceType = event.input.resourceType;

    //TODO: need to handle the resource type since we are actually using a specific profile
    
    if (!inputText) {
      throw new Error('No text input provided to bot');
    }
    if (!inputResourceType) {
      throw new Error('No target resource type provided');
    }

    // TODO: need to update this to handle the actual resource types that can be created
    if (!['Questionnaire', 'QuestionnaireResponse', 'Observation', 'Procedure', 'Condition', 'MedicationRequest', 'CarePlan'].includes(inputResourceType)) {
      throw new Error(`Unsupported resource type: ${inputResourceType}`);
    }

    console.log('Processing text:', JSON.stringify(inputText, null, 2));
    
    const targetResourceType = inputResourceType.toLowerCase();

    // Transform to specific profiles for observation and condition, otherwise use the resource type as profile.  
    let targetResourceProfile: string;
    switch (targetResourceType) {
      case 'observation':
        targetResourceProfile = 'simple-observation';
        break;
      case 'condition':
        targetResourceProfile = 'condition-encounter-diagnosis';
        break;
      default:
        // For all other resource types, use the resource type directly as the US Core profile is the same naming as the resource type
        targetResourceProfile = targetResourceType;
    }

    const email = event.secrets["PHENOML_EMAIL"].valueString as string;
    const password = event.secrets["PHENOML_PASSWORD"].valueString as string;

    // Create base64 encoded credentials for Basic Auth
    const credentials = Buffer.from(`${email}:${password}`).toString('base64');

    console.log('Authentication with PhenoML API...');
    // Get auth token using Basic Auth
    const authResponse = await fetch(PHENOML_API_URL + '/auth/token', {
      method: 'POST',
      headers: { 
        'Accept': 'application/json',
        'Authorization': `Basic ${credentials}`
      },
    }).catch(error => {
      throw new Error(`Failed to connect to PhenoML API: ${error.message}`);
    }); 
    
    console.log('Auth response status:', authResponse.status);
    if (!authResponse.ok) {
      const errorText = await authResponse.text().catch(() => 'No error details available');
      throw new Error(`Authentication failed: ${authResponse.status} ${authResponse.statusText} - ${errorText}`);
    }

    const authData = await authResponse.json().catch(error => {
      throw new Error(`Failed to parse authentication response: ${error.message}`);
    }) as { token: string };
    
    const bearerToken = authData.token as string;
    if (!bearerToken) {
      throw new Error('No token received from auth response');
    }

    console.log('Successfully authenticated with PhenoML API');
    
    // Prepare document request
    const createRequest: CreateRequest = {
      version: 'R4', // FHIR R4
      resource: targetResourceProfile, // Use the profile name as the resource
      text: inputText
    };

    // Call lang2fhir/document endpoint
    const createResponse = await fetch(PHENOML_API_URL + '/lang2fhir/create', {
      method: "POST",
      body: JSON.stringify(createRequest), 
      headers: { 
        'Authorization': `Bearer ${bearerToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
    }).catch(error => {
      throw new Error(`Failed to connect to PhenoML document API: ${error.message}`);
    });

    console.log('Create API response status:', createResponse.status);
    if (!createResponse.ok) {
      const errorText = await createResponse.text().catch(() => 'No error details available');
      throw new Error(`Document processing failed: ${createResponse.status} ${createResponse.statusText} - ${errorText}`);
    }

    const generatedResource = await createResponse.json().catch(error => {
      throw new Error(`Failed to parse create response: ${error.message}`);
    });

    console.log('Successfully processed document. Response:', JSON.stringify(generatedResource, null, 2));

    if (
      !generatedResource || 
      typeof generatedResource !== 'object' || 
      !('resourceType' in generatedResource)
    ) {
      throw new Error('Invalid resource returned from API');
    }

    // Add the patient reference based on resource type
    addPatientReference(generatedResource, event.input.patient);

    return generatedResource as AllowedResourceTypes;
  } catch (error) {
    throw new Error(`Bot execution failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

