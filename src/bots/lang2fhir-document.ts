// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { BotEvent, MedplumClient } from '@medplum/core';
import { DocumentReference, Questionnaire, QuestionnaireResponse } from '@medplum/fhirtypes';
import { Buffer } from 'buffer';
import { PhenoMLClient, phenoml } from 'phenoml';

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

interface DocBotInput {
  docref: DocumentReference;
  resourceType: 'Questionnaire' | 'QuestionnaireResponse';
}

// Maps content types to SDK file types
const FILE_TYPE_MAP: Record<string, phenoml.lang2Fhir.DocumentRequest.FileType> = {
  'application/pdf': 'application/pdf',
  'image/png': 'image/png',
  'image/jpeg': 'image/jpeg',
  'image/jpg': 'image/jpg',
};

export async function handler(
  medplum: MedplumClient,
  event: BotEvent<DocBotInput>
): Promise<Questionnaire | QuestionnaireResponse> {
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

    const targetResourceType = inputResourceType.toLowerCase() as phenoml.lang2Fhir.DocumentRequest.Resource;

    // Download the file content from the pre-signed URL
    const blob = await medplum.download(inputDocRef.content?.[0].attachment?.url);
    const arrayBuffer = await blob.arrayBuffer();
    const content = Buffer.from(arrayBuffer).toString('base64');

    const contentType = inputDocRef.content?.[0].attachment?.contentType || 'application/pdf';
    const fileType = FILE_TYPE_MAP[contentType] || 'application/pdf';

    const email = event.secrets["PHENOML_EMAIL"].valueString as string;
    const password = event.secrets["PHENOML_PASSWORD"].valueString as string;

    // Initialize PhenoML client with automatic auth handling
    const phenomlClient = new PhenoMLClient({
      username: email,
      password,
      baseUrl: 'http://localhost:8090'  // Local PhenoML server
    });

    // Call lang2fhir document endpoint using SDK
    const generatedResource = await phenomlClient.lang2Fhir.document({
      version: 'R4',
      resource: targetResourceType,
      content: content,
      fileType: fileType
    });

    return generatedResource as unknown as Questionnaire | QuestionnaireResponse;
  } catch (error) {
    throw new Error(`Bot execution failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
