// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { BotEvent, MedplumClient } from '@medplum/core';
import { phenomlClient } from 'phenoml';

/**
 * A Medplum Bot that searches a medical code system using PhenoML's Construe full-text code search.
 *
 * Intended for autocomplete / typeahead UIs (e.g. picking a CPT code when adding a charge item).
 * Construe `searchText` does fast substring matching on code ids and typo-tolerant matching on
 * descriptions over built-in code systems (CPT, ICD-10-CM, LOINC, RXNORM, SNOMED_CT_US_LITE, ...).
 *
 * Required bot secrets: (You need an active PhenoML subscription to use this bot)
 * - PHENOML_CLIENT_ID: Your PhenoML API client id
 * - PHENOML_CLIENT_SECRET: Your PhenoML API client secret
 * - PHENOML_BASE_URL: Your PhenoML environment base URL (e.g. https://phenohealth.app.pheno.ml).
 *
 * Note: Usage of CPT is subject to AMA requirements; see PhenoML Terms of Service.
 */

export interface CodeSearchInput {
  /** The user's search text (code fragment or keywords). */
  query: string;
  /** Built-in code system name. Defaults to 'CPT'. */
  system?: string;
  /** Maximum number of results (Construe caps text search at 100). Defaults to 20. */
  limit?: number;
}

export interface CodeSearchResult {
  code: string;
  description: string;
}

export interface CodeSearchOutput {
  success: boolean;
  message: string;
  /** The resolved code system name/version that was searched. */
  system?: string;
  /** Matching codes (empty when the query is blank). */
  results: CodeSearchResult[];
  /** Total number of matches reported by Construe (may exceed results length). */
  found?: number;
}

const DEFAULT_SYSTEM = 'CPT';
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
// Code search is meant to feel like typeahead; keep the call snappy and never let it stack up
// against the bot's Lambda timeout.
const CALL_TIMEOUT_SECONDS = 30;

export async function handler(
  medplum: MedplumClient,
  event: BotEvent<CodeSearchInput>
): Promise<CodeSearchOutput> {
  const system = event.input.system?.trim() || DEFAULT_SYSTEM;
  const query = event.input.query?.trim() ?? '';
  const limit = Math.min(Math.max(event.input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

  // Nothing to search — return early without calling PhenoML.
  if (query.length === 0) {
    return { success: true, message: 'Empty query', system, results: [] };
  }

  const clientId = event.secrets['PHENOML_CLIENT_ID']?.valueString;
  const clientSecret = event.secrets['PHENOML_CLIENT_SECRET']?.valueString;
  if (!clientId || !clientSecret) {
    throw new Error('PhenoML credentials (PHENOML_CLIENT_ID and PHENOML_CLIENT_SECRET) are required');
  }

  const baseUrl = event.secrets['PHENOML_BASE_URL']?.valueString;
  if (!baseUrl) {
    throw new Error('PHENOML_BASE_URL secret is required (e.g. https://phenohealth.app.pheno.ml)');
  }

  const client = new phenomlClient({ clientId, clientSecret, baseUrl });

  try {
    const response = await client.construe.codes.searchText(
      system,
      { q: query, limit },
      { timeoutInSeconds: CALL_TIMEOUT_SECONDS, maxRetries: 0 }
    );

    return {
      success: true,
      message: `Found ${response.found ?? response.results.length} result(s)`,
      system: response.system?.name ?? system,
      results: response.results.map((result) => ({ code: result.code, description: result.description })),
      found: response.found,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Code search failed (system=${system}, baseUrl=${baseUrl}): ${message}`);
  }
}
