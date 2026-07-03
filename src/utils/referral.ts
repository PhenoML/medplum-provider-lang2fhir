// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { getExtensionValue } from '@medplum/core';
import type { Attachment, Communication } from '@medplum/fhirtypes';

/**
 * Shared constants + helpers for the referral-intake workflow.
 *
 * NOTE: the referral-intake bot (src/bots/referral-intake.ts) cannot import from src/utils
 * (its tsconfig rootDir is src/bots), so it defines matching constants inline. Keep them in sync.
 */

/** Durable workflow status tracked on the inbound fax Communication. */
export const REFERRAL_STATUS_EXTENSION_URL =
  'https://example.org/fhir/StructureDefinition/referral-processing-status';

/** Links extracted resources (and the DocumentReference) back to their source document. */
export const SOURCE_DOCUMENT_EXTENSION_URL = 'https://example.org/fhir/StructureDefinition/source-document';

/** The extracted Bundle is stashed as a Binary and referenced from a Communication payload with this type. */
export const EXTRACTED_BUNDLE_CONTENT_TYPE = 'application/fhir+json';
export const EXTRACTED_BUNDLE_TITLE = 'Extracted FHIR Bundle';

export type ReferralStatus = 'processing' | 'ready-for-review' | 'signed' | 'error';

/** Reads the durable referral workflow status from a Communication, if any. */
export function getReferralStatus(communication: Communication | undefined): ReferralStatus | undefined {
  if (!communication) {
    return undefined;
  }
  return getExtensionValue(communication, REFERRAL_STATUS_EXTENSION_URL) as ReferralStatus | undefined;
}

/** Returns true for inbound fax Communications (matches FaxDetailPanel's inbound heuristic). */
export function isInboundFax(communication: Communication): boolean {
  const code = communication.category?.[0]?.coding?.[0]?.code;
  return code === 'inbound' || !code;
}

/** Finds the original document attachment (the PDF), i.e. not our stashed JSON bundle. */
export function findSourceAttachment(communication: Communication): Attachment | undefined {
  return communication.payload?.find(
    (p) => p.contentAttachment?.url && p.contentAttachment.contentType !== EXTRACTED_BUNDLE_CONTENT_TYPE
  )?.contentAttachment;
}

/** Finds the stashed extracted-Bundle attachment (JSON Binary), if the bot has produced one. */
export function findExtractedBundleAttachment(communication: Communication): Attachment | undefined {
  return communication.payload?.find(
    (p) => p.contentAttachment?.contentType === EXTRACTED_BUNDLE_CONTENT_TYPE
  )?.contentAttachment;
}

/** Returns a copy of the Communication with the referral status extension set to `status`. */
export function withReferralStatus(communication: Communication, status: ReferralStatus): Communication {
  const extension = (communication.extension ?? []).filter((e) => e.url !== REFERRAL_STATUS_EXTENSION_URL);
  extension.push({ url: REFERRAL_STATUS_EXTENSION_URL, valueCode: status });
  return { ...communication, extension };
}
