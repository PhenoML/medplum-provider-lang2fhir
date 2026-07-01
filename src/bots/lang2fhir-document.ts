// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { DocumentReference, Questionnaire, QuestionnaireResponse } from '@medplum/fhirtypes';
import { Buffer } from 'buffer';
import { phenomlClient } from 'phenoml';

/**
 * A Medplum Bot that processes documents using the PhenoML lang2fhir API.
 *
 * The bot will:
 * 1. Download the document from the provided URL
 * 2. Send the document to the lang2fhir API (via the PhenoML TypeScript SDK)
 * 3. Create a FHIR resource of the type specified in the input
 *
 * Required bot secrets: (You need to have an active PhenoML subscription to use this bot)
 * - PHENOML_CLIENT_ID: Your PhenoML API client id
 * - PHENOML_CLIENT_SECRET: Your PhenoML API client secret
 */

interface DocBotInput {
  docref: DocumentReference;
  resourceType: 'Questionnaire' | 'QuestionnaireResponse';
}

const PHENOML_BASE_URL = 'https://experiment.app.pheno.ml';

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

    const targetResourceType = inputResourceType.toLowerCase();

    // Download the file content from the pre-signed URL and base64-encode it.
    const blob = await medplum.download(inputDocRef.content?.[0].attachment?.url);
    const arrayBuffer = await blob.arrayBuffer();
    const content = Buffer.from(arrayBuffer).toString('base64');

    const clientId = event.secrets['PHENOML_CLIENT_ID']?.valueString;
    const clientSecret = event.secrets['PHENOML_CLIENT_SECRET']?.valueString;
    if (!clientId || !clientSecret) {
      throw new Error('PhenoML credentials (PHENOML_CLIENT_ID and PHENOML_CLIENT_SECRET) are required');
    }

    // The SDK handles OAuth client-credentials auth automatically.
    // The API auto-detects the file type from the content's magic bytes.
    const client = new phenomlClient({ clientId, clientSecret, baseUrl: PHENOML_BASE_URL });

    const generatedResource = await client.lang2Fhir.document({
      version: 'R4',
      resource: targetResourceType,
      content,
    });

    return generatedResource as unknown as Questionnaire | QuestionnaireResponse;
  } catch (error) {
    throw new Error(`Bot execution failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
