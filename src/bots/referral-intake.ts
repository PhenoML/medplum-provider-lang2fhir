// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { Bundle, DocumentReference } from '@medplum/fhirtypes';
import { Buffer } from 'buffer';
import { phenomlClient } from 'phenoml';

/**
 * A Medplum Bot that processes a referral document using the PhenoML lang2fhir
 * multi-resource document API.
 *
 * The bot will:
 * 1. Download the referral document (PDF or image) from the provided URL
 * 2. Send the document to the lang2fhir document-multi API (via the PhenoML TypeScript SDK)
 * 3. Return the resulting FHIR transaction Bundle containing all extracted resources
 *    (Patient, Conditions, and other referral-derived resources)
 *
 * Unlike the single-resource lang2fhir-document bot, this bot does not take a target
 * resourceType: the API auto-detects and emits multiple resource types as one Bundle.
 *
 * Required bot secrets: (You need to have an active PhenoML subscription to use this bot)
 * - PHENOML_CLIENT_ID: Your PhenoML API client id
 * - PHENOML_CLIENT_SECRET: Your PhenoML API client secret
 */

interface ReferralBotInput {
  docref: DocumentReference;
}

const PHENOML_BASE_URL = 'https://experiment.app.pheno.ml';

export async function handler(medplum: MedplumClient, event: BotEvent<ReferralBotInput>): Promise<Bundle> {
  try {
    const inputDocRef = event.input.docref;

    if (!inputDocRef) {
      throw new Error('No document input provided to bot');
    }
    if (!inputDocRef.content?.[0].attachment?.url) {
      throw new Error('DocumentReference resource must have content.url');
    }

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

    // The document-multi endpoint returns a FHIR transaction Bundle of multiple resource types.
    // Passing provider: 'medplum' aligns the generated Bundle with Medplum-specific FHIR profiles.
    const response = await client.lang2Fhir.documentMulti({
      version: 'R4',
      content,
      provider: 'medplum',
    });

    if (!response?.bundle) {
      throw new Error(`lang2fhir document-multi returned no bundle: ${response?.message ?? 'unknown error'}`);
    }

    return response.bundle as unknown as Bundle;
  } catch (error) {
    throw new Error(`Bot execution failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
