import { BotEvent, MedplumClient } from '@medplum/core';
import { DocumentReference, Resource, Questionnaire, QuestionnaireResponse } from '@medplum/fhirtypes';
import { Buffer } from 'buffer';

/**
 * A Medplum Bot that processes documents using the lang2fhir API.
 * 
 * The bot will:
 * 1. Download the document from the provided URL
 * 2. Send the document to the lang2fhir API
 * 3. Create a FHIR resource of the type specified in the input
 * 
 * Required bot secrets: (You need to have an active PhenoML subscription to use this bot)
 * - PHENOML_EMAIL: Your PhenoML API email
 * - PHENOML_PASSWORD: Your PhenoML API password
 */

interface DocumentRequest {
  version: string;
  resource: string;
  content: string;
  fileType: string;
}

interface DocBotInput {
  docref: DocumentReference;
  resourceType: 'Questionnaire' | 'QuestionnaireResponse';
}

const PHENOML_API_URL = "https://experiment.app.pheno.ml";


export async function handler(
  medplum: MedplumClient, 
  event: BotEvent<DocBotInput>
): Promise<Resource> {
  try {

    const inputDocRef = event.input.docref;
    const inputResourceType = event.input.resourceType;
    
    if (!inputDocRef) {
      throw new Error('No media input provided to bot');
    }
    if (!inputResourceType) {
      throw new Error('No target resource type provided');
    }

    if (!['Questionnaire', 'QuestionnaireResponse'].includes(inputResourceType)) {
      throw new Error(`Unsupported resource type: ${inputResourceType}`);
    }
    
    if (!inputDocRef.content?.[0].attachment?.url) {
      throw new Error('DocumentReference resource must have content.url');
    }

    const targetResourceType = inputResourceType.toLowerCase();

    // Download the file content from the pre-signed URL
    const blob = await medplum.download(inputDocRef.content?.[0].attachment?.url);
    const arrayBuffer = await blob.arrayBuffer();
    const content = Buffer.from(arrayBuffer).toString('base64');

    const email = event.secrets["PHENOML_EMAIL"].valueString as string;
    const password = event.secrets["PHENOML_PASSWORD"].valueString as string;

    // Create base64 encoded credentials for Basic Auth
    const credentials = Buffer.from(`${email}:${password}`).toString('base64');
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
    
    if (!authResponse.ok) {
      throw new Error(`Authentication failed: ${authResponse.status} ${authResponse.statusText}`);
    }

    const { token: bearerToken } = await authResponse.json() as { token: string };
    if (!bearerToken) {
      throw new Error('No token received from auth response');
    }
    
    // Prepare document request
    const documentRequest: DocumentRequest = {
      version: 'R4', // FHIR R4
      resource: targetResourceType,
      content: content,
      fileType: inputDocRef.content?.[0].attachment?.contentType || 'application/pdf'
    };

    // Call lang2fhir/document endpoint
    const documentResponse = await fetch(PHENOML_API_URL + '/lang2fhir/document', {
      method: "POST",
      body: JSON.stringify(documentRequest), 
      headers: { 
        'Authorization': `Bearer ${bearerToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
    }).catch(error => {
      throw new Error(`Failed to connect to Lang2FHIR Document API: ${error.message}`);
    });

    if (!documentResponse.ok) {
      const errorText = await documentResponse.text().catch(() => 'No error details available');
      throw new Error(`Document processing failed: ${documentResponse.status} ${documentResponse.statusText} - ${errorText}`);
    }

    const generatedResource = await documentResponse.json().catch(error => {
      throw new Error(`Failed to parse document response: ${error.message}`);
    });

    return generatedResource as Questionnaire | QuestionnaireResponse; 
  } catch (error) {
    throw new Error(`Bot execution failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

