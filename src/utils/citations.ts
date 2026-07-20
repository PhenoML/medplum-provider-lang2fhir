// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { getExtensionValue } from '@medplum/core';
import type { ChargeItem, Condition, Extension } from '@medplum/fhirtypes';
import { computeEmAcuity, isEmCode } from './emAcuity';
import type { EmAcuity } from './emAcuity';

// Keep these in sync with src/bots/billing-acuity.ts. Bots cannot import from
// src/utils because tsconfig-bots.json limits their rootDir to src/bots.
export const BILLING_ACUITY_SOURCE_EXTENSION_URL =
  'https://example.org/fhir/StructureDefinition/billing-acuity-source';
export const BILLING_CITATION_EXTENSION_URL = 'https://example.org/fhir/StructureDefinition/billing-citation';
export const BILLING_ACUITY_SOURCE = 'billing-acuity';

export interface NoteCitation {
  text: string;
  beginOffset: number;
  endOffset: number;
}

export interface ReviewCodeItem {
  key: string;
  kind: 'diagnosis' | 'charge';
  code: string;
  system: string;
  display?: string;
  rationale?: string;
  acuity?: EmAcuity;
  citations: NoteCitation[];
  resource: Condition | ChargeItem;
}

export interface HighlightSegment {
  text: string;
  keys: string[];
}

export function getCitations(resource: Condition | ChargeItem): NoteCitation[] {
  return (resource.extension ?? [])
    .filter((extension) => extension.url === BILLING_CITATION_EXTENSION_URL)
    .map(readCitation)
    .filter((citation): citation is NoteCitation => citation !== undefined);
}

function readCitation(extension: Extension): NoteCitation | undefined {
  const text = extension.extension?.find((child) => child.url === 'text')?.valueString;
  const beginOffset = extension.extension?.find((child) => child.url === 'beginOffset')?.valueInteger;
  const endOffset = extension.extension?.find((child) => child.url === 'endOffset')?.valueInteger;
  if (!text || beginOffset === undefined || endOffset === undefined) {
    return undefined;
  }
  return { text, beginOffset, endOffset };
}

export function isBotGenerated(resource: Condition | ChargeItem): boolean {
  return getExtensionValue(resource, BILLING_ACUITY_SOURCE_EXTENSION_URL) === BILLING_ACUITY_SOURCE;
}

export function buildReviewItems(
  conditions: Condition[],
  chargeItems: ChargeItem[],
  riskContext?: { hasPrescriptionManagement: boolean }
): ReviewCodeItem[] {
  const items = [...conditions, ...chargeItems].flatMap((resource): ReviewCodeItem[] => {
    if (!resource.id || !isBotGenerated(resource)) {
      return [];
    }
    const coding = resource.code?.coding?.[0];
    if (!coding?.code || !coding.system) {
      return [];
    }
    const kind = resource.resourceType === 'Condition' ? 'diagnosis' : 'charge';
    return [
      {
        key: `${resource.resourceType}/${resource.id}`,
        kind,
        code: coding.code,
        system: coding.system,
        ...(coding.display ? { display: coding.display } : {}),
        ...(resource.note?.[0]?.text ? { rationale: resource.note[0].text } : {}),
        citations: getCitations(resource),
        resource,
      },
    ];
  });

  // With the patient's prescription-management context available, attach the diagnosis-count
  // acuity rationale to each E/M charge. The count is the diagnoses shown in the panel, so
  // dropping one recomputes it live.
  if (riskContext === undefined) {
    return items;
  }
  const problemCount = items.filter((item) => item.kind === 'diagnosis').length;
  return items.map((item) => {
    if (item.kind !== 'charge' || !isEmCode(item.code)) {
      return item;
    }
    const acuity = computeEmAcuity({
      billedCode: item.code,
      problemCount,
      hasPrescriptionManagement: riskContext.hasPrescriptionManagement,
    });
    return acuity ? { ...item, acuity } : item;
  });
}

export function resolveCitationSpans(noteText: string, citations: NoteCitation[]): NoteCitation[] {
  return citations.flatMap((citation): NoteCitation[] => {
    if (
      citation.beginOffset >= 0 &&
      citation.endOffset > citation.beginOffset &&
      citation.endOffset <= noteText.length &&
      noteText.slice(citation.beginOffset, citation.endOffset) === citation.text
    ) {
      return [citation];
    }
    const beginOffset = noteText.indexOf(citation.text);
    if (beginOffset < 0) {
      return [];
    }
    return [{ ...citation, beginOffset, endOffset: beginOffset + citation.text.length }];
  });
}

export function buildHighlightSegments(noteText: string, items: ReviewCodeItem[]): HighlightSegment[] {
  if (!noteText) {
    return [];
  }

  const spans = items.flatMap((item) =>
    resolveCitationSpans(noteText, item.citations).map((citation) => ({
      beginOffset: citation.beginOffset,
      endOffset: citation.endOffset,
      key: item.key,
    }))
  );
  const boundaries = Array.from(
    new Set([0, noteText.length, ...spans.flatMap((span) => [span.beginOffset, span.endOffset])])
  ).sort((a, b) => a - b);

  return boundaries.slice(0, -1).flatMap((beginOffset, index): HighlightSegment[] => {
    const endOffset = boundaries[index + 1];
    if (endOffset <= beginOffset) {
      return [];
    }
    const keys = Array.from(
      new Set(
        spans
          .filter((span) => span.beginOffset < endOffset && span.endOffset > beginOffset)
          .map((span) => span.key)
      )
    );
    return [{ text: noteText.slice(beginOffset, endOffset), keys }];
  });
}
