import { BotEvent, MedplumClient } from '@medplum/core';
import { ResourceType, Group } from '@medplum/fhirtypes';
import { Buffer } from 'buffer';


/**
 * A Medplum Bot that creates patient cohorts based on natural language descriptions 
 * using the PhenoML experimental cohort API.
 * 
 * Example input:
 * {
 *   "text": "over 40 with hyperlipidemia",
 *   "config": {
 *      "include_extract_results": false, // Optional, defaults to false. If true it will provide the details on the extracted codes for the queries.
 *      "include_rationale": true, // Optional, defaults to false. If true it will provide the AI rationale for the queries and code extraction if enabled.
 *      "exclude_deceased": true  // Optional, defaults to true
 *   }
 * }
 * 
 * The bot will:
 * 1. Send the text to the PhenoML API to get FHIR queries
 * 2. Execute these queries against your Medplum server
 * 3. Create a FHIR Group resource containing the matching patients
 * 
 * Required bot secrets:
 * - PHENOML_EMAIL: Your PhenoML API email
 * - PHENOML_PASSWORD: Your PhenoML API password
 */

interface CohortBotInput {
  text: string;
  config?: {
    include_extract_results?: boolean;
    include_rationale?: boolean;
    exclude_deceased?: boolean;
  };
}

const PHENOML_API_URL = "https://experiment.pheno.ml"

export async function handler(medplum: MedplumClient, event: BotEvent<CohortBotInput>): Promise<Group> {
  const email = event.secrets["PHENOML_EMAIL"].valueString as string;
  const password = event.secrets["PHENOML_PASSWORD"].valueString as string;
  const credentials = Buffer.from(`${email}:${password}`).toString('base64');

  const cohortResponse = await submitCohortRequest(event.input, credentials);

  const result = await createCohortGroup(medplum, cohortResponse);

  return result;
}

// Authenticates and submits request to PhenoML API.
async function submitCohortRequest(cohortRequestText: any, credentials:string): Promise<CohortOutput> {
  
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
  
  const cohortResponse = await fetch(PHENOML_API_URL + '/construe/cohort', {
    method: "POST",
    body: JSON.stringify(cohortRequestText), 
    headers: { Authorization: `Bearer ${bearerToken}`, "Content-Type": "application/json" },
  });

  if (!cohortResponse.ok) {
    throw new Error(`Failed to fetch cohort queries: ${cohortResponse.statusText}`);
  }

  const cohortResult = await cohortResponse.json();

  return cohortResult as CohortOutput;
}

// Creates a FHIR Group resource containing the cohort patients.
async function createCohortGroup(medplum: MedplumClient, cohortOutput: CohortOutput): Promise<Group> {
  let currentPatientIds: string[] = [];
  const extensions = [];

  for (const query of cohortOutput.queries) {
    const patientIds = await executeQuery(medplum, query);
    
    if (currentPatientIds.length === 0) {
      currentPatientIds = patientIds;
    } else {
      currentPatientIds = performSetOperation(query.exclude, currentPatientIds, patientIds);
    }

    // If you want to add extensions to the group resource for traceability purposes, you can do so here. 
    const extensionElements = [
      { url: "query", valueString: query.searchParams },
      { url: "exclude", valueBoolean: query.exclude },
    ]
    
    if (query.rationale) {
      extensionElements.push({ url: "rationale", valueString: query.rationale });
    }
    
    extensions.push({
      url: "criteria",
      extension: extensionElements,
    });
  }


  const uniquePatientIdsSet = new Set<string>(currentPatientIds);
  const uniquePatientIds = Array.from(uniquePatientIdsSet);

  const uniqueMembers = uniquePatientIds.map(id => ({
    entity: { reference: `Patient/${id}` }
  }));

  // Set the identifier for the group to be the cohort description
  const identifierValue = (cohortOutput.cohortDescription || 'Cohort Group').replace(/\s+/g, '-');
  const identifier = {value: identifierValue};

  // Create the group resource with extensions for traceability purposes if desired. 
  const createdGroup = await medplum.createResource({
    resourceType: "Group",
    name: cohortOutput.cohortDescription || "Cohort Group",
    active: false,
    type: "person",
    actual: true,
    extension: [
      {
        url: "https://your-organization.com/fhir/StructureDefinition/cohort-query",
        extension: extensions,
      },
    ],
    identifier: [identifier],
    member: uniqueMembers,
  });

  return createdGroup;
}

// Executes a single FHIR query with pagination and extracts patient IDs.
async function executeQuery(medplum: MedplumClient,queryConfig: Query): Promise<string[]> {
  const { resource, searchParams } = queryConfig;
  const patientIds: string[] = [];

  for await (const page of medplum.searchResourcePages(resource, searchParams)) {
    const extractedIds = extractPatientIds(page);
    patientIds.push(...extractedIds.map((data) => data.patientId));
  }
  return patientIds;
}

// Extracts patient IDs from FHIR resources.
function extractPatientIds(resources: any[]): { patientId: string }[] {
  return resources
    .map((resource) => {
      const patientId =
        resource.resourceType === "Patient"
          ? resource.id
          : resource.subject?.reference?.split("/")[1];

      return {
        patientId: patientId || "",
      };
    })
    .filter((data) => data.patientId !== "");
}

// Performs set operations on patient ID arrays.
function performSetOperation(exclude: boolean,setA: string[],setB: string[]): string[] {
  return setA.filter((id) => 
    exclude 
      ? !setB.includes(id)    
      : setB.includes(id)    
  );
}

interface Query {
  resource: ResourceType;
  searchParams: string; // FHIR search parameters (e.g., "gender=female&birthdate=lt2000")
  exclude: boolean; // If true, exclude patients from the cohort
  rationale: string; // AI Rationale for the query
}

interface CohortOutput {
  queries: Query[]; // Array of FHIR queries to execute
  sql: string; // SQL representation (for reference)
  cohortDescription: string;
}