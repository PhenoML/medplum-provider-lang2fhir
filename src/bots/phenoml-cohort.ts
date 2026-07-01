// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { Group, ResourceType } from '@medplum/fhirtypes';
import { phenomlClient } from 'phenoml';

/**
 * A Medplum Bot that creates patient cohorts based on natural language descriptions
 * using the PhenoML cohort API (via the PhenoML TypeScript SDK).
 *
 * Example input:
 * {
 *   "text": "over 40 with hyperlipidemia"
 * }
 *
 * The bot will:
 * 1. Send the text to the PhenoML API to get FHIR queries
 * 2. Execute these queries against your Medplum server
 * 3. Create a FHIR Group resource containing the matching patients
 *
 * Required bot secrets:
 * - PHENOML_CLIENT_ID: Your PhenoML API client id
 * - PHENOML_CLIENT_SECRET: Your PhenoML API client secret
 */

interface CohortBotInput {
  text: string;
}

const PHENOML_BASE_URL = 'https://experiment.app.pheno.ml';

export async function handler(medplum: MedplumClient, event: BotEvent<CohortBotInput>): Promise<Group> {
  const clientId = event.secrets['PHENOML_CLIENT_ID']?.valueString;
  const clientSecret = event.secrets['PHENOML_CLIENT_SECRET']?.valueString;
  if (!clientId || !clientSecret) {
    throw new Error('PhenoML credentials (PHENOML_CLIENT_ID and PHENOML_CLIENT_SECRET) are required');
  }

  // The SDK handles OAuth client-credentials auth automatically.
  const client = new phenomlClient({ clientId, clientSecret, baseUrl: PHENOML_BASE_URL });

  const cohortResponse = await client.cohort.analyze({ text: event.input.text });

  // Validate response structure
  if (!cohortResponse.success) {
    throw new Error(`PhenoML API returned failure: ${cohortResponse.message || 'Unknown error'}`);
  }
  if (!cohortResponse.queries || !Array.isArray(cohortResponse.queries)) {
    throw new Error(`Invalid response from PhenoML API: missing or invalid queries array`);
  }

  console.log(`Successfully received ${cohortResponse.queries.length} queries from PhenoML API`);

  return createCohortGroup(medplum, cohortResponse as CohortOutput, event.input.text);
}

// Creates a FHIR Group resource containing the cohort patients.
async function createCohortGroup(
  medplum: MedplumClient,
  cohortOutput: CohortOutput,
  originalSearchText: string
): Promise<Group> {
  console.log(`Received cohort output: ${JSON.stringify(cohortOutput, null, 2)}`);
  console.log(`Original search text: "${originalSearchText}"`);

  let currentPatientIds: string[] = [];
  const extensions = [];

  for (const query of cohortOutput.queries) {
    console.log(`Processing query: ${JSON.stringify(query, null, 2)}`);
    const patientIds = await executeQuery(medplum, query);

    if (currentPatientIds.length === 0) {
      currentPatientIds = patientIds;
    } else {
      currentPatientIds = performSetOperation(query.exclude, currentPatientIds, patientIds);
    }

    // If you want to add extensions to the group resource for traceability purposes, you can do so here.
    const extensionElements = [
      { url: 'query', valueString: query.search_params },
      { url: 'exclude', valueBoolean: query.exclude },
    ];

    if (query.concept) {
      extensionElements.push({ url: 'concept', valueString: query.concept });
    }

    extensions.push({
      url: 'criteria',
      extension: extensionElements,
    });
  }

  const uniquePatientIdsSet = new Set<string>(currentPatientIds);
  const uniquePatientIds = Array.from(uniquePatientIdsSet);

  const uniqueMembers = uniquePatientIds.map((id) => ({
    entity: { reference: `Patient/${id}` },
  }));

  // Set the identifier for the group to be the original search text
  const groupName = originalSearchText?.trim() || 'Cohort Group';
  const identifierValue = groupName.replace(/\s+/g, '-');
  const identifier = { value: identifierValue };

  console.log(`Creating group with name: "${groupName}"`);
  console.log(`Group identifier: "${identifierValue}"`);

  // Create the group resource with extensions for traceability purposes if desired.
  const createdGroup = await medplum.createResource({
    resourceType: 'Group',
    name: groupName,
    active: false,
    type: 'person',
    actual: true,
    extension: [
      {
        url: 'https://your-organization.com/fhir/StructureDefinition/cohort-query',
        extension: extensions,
      },
    ],
    identifier: [identifier],
    member: uniqueMembers,
  });

  return createdGroup;
}

// Executes a single FHIR query with pagination and extracts patient IDs.
async function executeQuery(medplum: MedplumClient, queryConfig: Query): Promise<string[]> {
  const { resource_type, search_params } = queryConfig;

  // Validate that resource type is provided
  if (!resource_type) {
    throw new Error(`No resource type specified in query: ${JSON.stringify(queryConfig)}`);
  }

  // Validate that it's a valid ResourceType
  if (typeof resource_type !== 'string') {
    throw new Error(`Invalid resource type (not a string): ${JSON.stringify(resource_type)}`);
  }

  // Additional validation for empty/whitespace resource type
  if (resource_type.trim() === '') {
    throw new Error(`Empty resource type specified in query: ${JSON.stringify(queryConfig)}`);
  }

  console.log(`Executing query for resource type: "${resource_type}", search_params: "${search_params}"`);
  console.log(`Query config object:`, JSON.stringify(queryConfig, null, 2));

  const patientIds: string[] = [];

  try {
    console.log(`Searching for ${resource_type} with params: "${search_params}"`);

    // Use searchResources like other parts of the codebase
    const resources = await medplum.searchResources(resource_type, search_params || '');

    console.log(`Found ${resources.length} ${resource_type} resources`);

    const extractedIds = extractPatientIds(resources);
    patientIds.push(...extractedIds.map((data) => data.patientId));
  } catch (error: any) {
    console.error(`Error in searchResources for ${resource_type}:`, error);
    throw new Error(`Failed to execute search for ${resource_type}: ${error.message}`);
  }

  return patientIds;
}

// Extracts patient IDs from FHIR resources.
function extractPatientIds(resources: any[]): { patientId: string }[] {
  return resources
    .map((resource) => {
      const patientId =
        resource.resourceType === 'Patient' ? resource.id : resource.subject?.reference?.split('/')[1];

      return {
        patientId: patientId || '',
      };
    })
    .filter((data) => data.patientId !== '');
}

// Performs set operations on patient ID arrays.
function performSetOperation(exclude: boolean, setA: string[], setB: string[]): string[] {
  return setA.filter((id) => (exclude ? !setB.includes(id) : setB.includes(id)));
}

interface Query {
  resource_type: ResourceType;
  search_params: string; // FHIR search parameters (e.g., "gender=female&birthdate=lt2000")
  exclude: boolean; // If true, exclude patients from the cohort
  concept: string; // The concept this query represents
}

interface CohortOutput {
  success: boolean;
  message: string;
  queries: Query[]; // Array of FHIR queries to execute
}
