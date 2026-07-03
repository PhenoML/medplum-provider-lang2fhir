// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { Attachment, Communication, DocumentReference, Extension } from '@medplum/fhirtypes';
import { Buffer } from 'buffer';
import { phenomlClient } from 'phenoml';

/**
 * A Medplum Bot that processes a behavioral-health referral document using the PhenoML
 * lang2fhir multi-resource document API.
 *
 * Two invocation modes:
 *
 * 1. Fax mode — input `{ communicationId }`.
 *    The bot downloads the PDF from the inbound fax Communication's payload, sets a durable
 *    "processing" status on the Communication, calls document/multi, and stashes the extracted
 *    transaction Bundle back onto the Communication as an additional payload (a JSON Binary),
 *    then sets status to "ready-for-review". It does NOT persist (executeBatch) the extracted
 *    resources — persistence happens at reviewer sign-off. This makes processing non-blocking
 *    and durable across navigation: the UI fires the bot and polls the Communication for status.
 *
 * 2. Upload mode — input `{ docref }`.
 *    Backwards-compatible with the manual /upload/referral flow: downloads the DocumentReference
 *    attachment and returns the extracted transaction Bundle to the caller.
 *
 * Required bot secrets: (You need to have an active PhenoML subscription to use this bot)
 * - PHENOML_CLIENT_ID: Your PhenoML API client id
 * - PHENOML_CLIENT_SECRET: Your PhenoML API client secret
 * Optional bot secret:
 * - PHENOML_BASE_URL: Your PhenoML environment base URL (e.g. https://phenohealth.app.pheno.ml).
 *   Defaults to https://experiment.app.pheno.ml. Credentials are tied to a specific environment,
 *   so set this if yours are not for the default host.
 */

interface ReferralBotInput {
  /** Fax mode: id of the inbound fax Communication to process. */
  communicationId?: string;
  /** Upload mode: a DocumentReference whose attachment should be processed. */
  docref?: DocumentReference;
}

// Durable workflow status tracked on the Communication (keep in sync with src/utils/referral.ts).
const REFERRAL_STATUS_EXTENSION_URL = 'https://example.org/fhir/StructureDefinition/referral-processing-status';
// The stashed extracted Bundle is added as an extra payload with this content type.
const EXTRACTED_BUNDLE_CONTENT_TYPE = 'application/fhir+json';
const EXTRACTED_BUNDLE_TITLE = 'Extracted FHIR Bundle';

type ReferralStatus = 'processing' | 'ready-for-review' | 'signed' | 'error';

function withReferralStatus(communication: Communication, status: ReferralStatus): Communication {
  const extension: Extension[] = (communication.extension ?? []).filter(
    (e) => e.url !== REFERRAL_STATUS_EXTENSION_URL
  );
  extension.push({ url: REFERRAL_STATUS_EXTENSION_URL, valueCode: status });
  return { ...communication, extension };
}

async function downloadBase64(medplum: MedplumClient, url: string): Promise<string> {
  const blob = await medplum.download(url);
  const arrayBuffer = await blob.arrayBuffer();
  return Buffer.from(arrayBuffer).toString('base64');
}

// Bound the lang2fhir call so a slow/unreachable PhenoML endpoint fails with a clear error well
// within the bot's Lambda timeout, instead of the bot being hard-killed mid-request (which leaves
// the fax stuck in 'processing' forever). maxRetries: 0 disables the SDK's default 2 retries, which
// can otherwise stack up past the Lambda budget. Keep this comfortably under the Bot.timeout set in
// deploy-bots.ts so the catch has time to record the failure.
const LANG2FHIR_TIMEOUT_SECONDS = 100;

async function extractBundle(
  content: string,
  clientId: string,
  clientSecret: string,
  baseUrl: string
): Promise<object> {
  // The SDK handles OAuth client-credentials auth automatically.
  // The API auto-detects the file type from the content's magic bytes.
  const client = new phenomlClient({ clientId, clientSecret, baseUrl });

  // The document-multi endpoint returns a FHIR transaction Bundle of multiple resource types.
  // Passing provider: 'medplum' aligns the generated Bundle with Medplum-specific FHIR profiles.
  const response = await client.lang2Fhir
    .documentMulti(
      { version: 'R4', content, provider: 'medplum' },
      { timeoutInSeconds: LANG2FHIR_TIMEOUT_SECONDS, maxRetries: 0 }
    )
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `lang2fhir document-multi failed (baseUrl=${baseUrl}, timeout=${LANG2FHIR_TIMEOUT_SECONDS}s): ${message}`
      );
    });

  if (!response?.bundle) {
    throw new Error(`lang2fhir document-multi returned no bundle: ${response?.message ?? 'unknown error'}`);
  }
  return response.bundle;
}

export async function handler(medplum: MedplumClient, event: BotEvent<ReferralBotInput>): Promise<object> {
  const clientId = event.secrets['PHENOML_CLIENT_ID']?.valueString;
  const clientSecret = event.secrets['PHENOML_CLIENT_SECRET']?.valueString;
  if (!clientId || !clientSecret) {
    throw new Error('PhenoML credentials (PHENOML_CLIENT_ID and PHENOML_CLIENT_SECRET) are required');
  }
  // Base URL is tied to your PhenoML environment/tenant; supplied via the required
  // PHENOML_BASE_URL secret (e.g. https://phenohealth.app.pheno.ml).
  const baseUrl = event.secrets['PHENOML_BASE_URL']?.valueString;
  if (!baseUrl) {
    throw new Error('PhenoML base url required');
  }

  const { communicationId, docref } = event.input;

  // ---- Upload mode: return the Bundle to the caller (unchanged behavior). ----
  if (!communicationId) {
    if (!docref?.content?.[0]?.attachment?.url) {
      throw new Error('DocumentReference resource must have content.url');
    }
    const content = await downloadBase64(medplum, docref.content[0].attachment.url);
    return extractBundle(content, clientId, clientSecret, baseUrl);
  }

  // ---- Fax mode: process the inbound fax Communication and stash the result. ----
  let communication = await medplum.readResource('Communication', communicationId);
  try {
    // Locate the original document payload (anything that isn't our stashed JSON bundle).
    const sourceAttachment = communication.payload?.find(
      (p) => p.contentAttachment?.url && p.contentAttachment.contentType !== EXTRACTED_BUNDLE_CONTENT_TYPE
    )?.contentAttachment;
    if (!sourceAttachment?.url) {
      throw new Error('Fax Communication has no document attachment to process');
    }

    // Mark processing (durable) so the UI shows a persistent "Processing…" state.
    communication = await medplum.updateResource(withReferralStatus(communication, 'processing'));

    const content = await downloadBase64(medplum, sourceAttachment.url);
    const bundle = await extractBundle(content, clientId, clientSecret, baseUrl);

    // Stash the extracted Bundle inline (base64) on a new payload entry. Inlining (rather than
    // referencing a separate Binary) lets the review UI read it directly, avoiding a cross-origin
    // Binary download that fails with "Failed to fetch" in the browser.
    const stashedPayload: Attachment = {
      contentType: EXTRACTED_BUNDLE_CONTENT_TYPE,
      data: Buffer.from(JSON.stringify(bundle)).toString('base64'),
      title: EXTRACTED_BUNDLE_TITLE,
    };

    // Re-read to avoid clobbering concurrent edits, then append the payload and flip status.
    const fresh = await medplum.readResource('Communication', communicationId);
    const withoutOldBundle = (fresh.payload ?? []).filter(
      (p) => p.contentAttachment?.contentType !== EXTRACTED_BUNDLE_CONTENT_TYPE
    );
    await medplum.updateResource(
      withReferralStatus(
        { ...fresh, payload: [...withoutOldBundle, { contentAttachment: stashedPayload }] },
        'ready-for-review'
      )
    );

    return bundle;
  } catch (error) {
    // Record the failure durably so the UI can surface it instead of spinning forever.
    const message = error instanceof Error ? error.message : String(error);
    const fresh = await medplum.readResource('Communication', communicationId);
    await medplum.updateResource({
      ...withReferralStatus(fresh, 'error'),
      note: [...(fresh.note ?? []), { text: `Referral processing failed: ${message}` }],
    });
    throw new Error(`Bot execution failed: ${message}`);
  }
}
