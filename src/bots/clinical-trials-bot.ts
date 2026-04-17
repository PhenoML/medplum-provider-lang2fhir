// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { BotEvent, MedplumClient } from '@medplum/core';
import { Patient, Condition, MedicationRequest, Task, Practitioner, Device } from '@medplum/fhirtypes';

/**
 * A Medplum Bot that analyzes patient data and searches for relevant clinical trials.
 * 
 * The bot will:
 * 1. Gather patient's medical conditions, medications, and demographics
 * 2. Search ClinicalTrials.gov API for relevant trials
 * 3. Use Gemini AI to analyze patient data + trial results and generate findings
 * 4. Create a Task assigned to the practitioner with AI-generated findings
 * 
 * Required bot secrets:
 * - GEMINI_API_KEY: Your Google Gemini API key
 */

interface ClinicalTrialsBotInput {
  patient: Patient;
  practitioner?: Practitioner;
  searchRadius?: number; // Optional: search radius in miles, defaults to 100
}

interface ClinicalTrialsBotOutput {
  task: Task;
  trialsFound: number;
}

interface ClinicalTrial {
  nctId: string;
  title: string;
  briefSummary: string;
  overallStatus: string;
  eligibilityCriteria?: string;
  interventions?: string[];
  locations?: string[];
  contactInfo?: string;
  url: string;
}

interface PatientSummary {
  age?: number;
  sex?: string;
  conditions: string[];
  medications: string[];
  city?: string;
  state?: string;
  zipCode?: string;
}

interface TrialRecommendation {
  nctId: string;
  recommendation: 'high' | 'medium' | 'low';
  reasoning: string;
  eligibilityAssessment: string;
  medicationConsiderations?: string;
  nextSteps?: string;
}

interface ClinicalAnalysis {
  patientSummary: string;
  trialRecommendations: TrialRecommendation[];
  overallAssessment: string;
  priorityActions: string[];
}

interface GeminiFunctionCall {
  name: string;
  args: any;
}

interface GeminiResponse {
  candidates?: {
    content?: {
      parts?: {
        functionCall?: GeminiFunctionCall;
      }[];
    };
  }[];
}

const CT_GOV_BASE = "https://clinicaltrials.gov/api/v2";
const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent";

/**
 * Make a request to the ClinicalTrials.gov API
 * @param url - The API endpoint URL
 * @param params - Query parameters for the request
 * @returns Promise resolving to the API response data
 */
async function makeCTGovRequest(url: string, params: Record<string, any> = {}): Promise<any> {
  try {
    const searchParams = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        searchParams.append(key, String(value));
      }
    });
    
    const fullUrl = `${url}?${searchParams.toString()}`;
    console.log(`Making request to: ${fullUrl}`);
    
    const response = await fetch(fullUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return await response.json();
  } catch (error) {
    console.error(`Error making request to ${url}:`, error);
    throw error;
  }
}

/**
 * Format a study into a structured clinical trial object
 * @param study - Raw study data from ClinicalTrials.gov API
 * @returns Formatted clinical trial object
 */
function formatStudy(study: any): ClinicalTrial {
  try {
    const protocol = study.protocolSection || {};
    const identification = protocol.identificationModule || {};
    const status = protocol.statusModule || {};
    const eligibility = protocol.eligibilityModule || {};
    const armsInterventions = protocol.armsInterventionsModule || {};
    const contactsLocations = protocol.contactsLocationsModule || {};

    const nctId = identification.nctId || 'Unknown';
    const title = identification.briefTitle || identification.officialTitle || 'No title available';
    const briefSummary = identification.briefSummary || 'No summary available';
    const overallStatus = status.overallStatus || 'Unknown';

    // Extract interventions
    const interventions = armsInterventions.interventions?.map((intervention: any) => 
      intervention.name || intervention.type
    ).filter(Boolean) || [];

    // Extract locations
    const locations = contactsLocations.locations?.map((location: any) => {
      const facility = location.facility || '';
      const city = location.city || '';
      const state = location.state || '';
      return [facility, city, state].filter(Boolean).join(', ');
    }).filter(Boolean) || [];

    // Extract contact info
    const contacts = contactsLocations.centralContacts || contactsLocations.overallOfficials || [];
    const contactInfo = contacts.map((contact: any) => {
      const name = contact.name || '';
      const email = contact.email || '';
      const phone = contact.phone || '';
      return [name, email, phone].filter(Boolean).join(' - ');
    }).filter(Boolean).join('; ');

    return {
      nctId,
      title,
      briefSummary: briefSummary.substring(0, 500) + (briefSummary.length > 500 ? '...' : ''),
      overallStatus,
      eligibilityCriteria: eligibility.eligibilityCriteria?.substring(0, 300),
      interventions,
      locations,
      contactInfo: contactInfo || undefined,
      url: `https://clinicaltrials.gov/study/${nctId}`,
    };
  } catch (error) {
    console.error('Error formatting study:', error);
    return {
      nctId: 'Error',
      title: 'Error formatting study',
      briefSummary: 'Unable to parse study data',
      overallStatus: 'Unknown',
      url: '',
    };
  }
}

/**
 * Calculate age from birth date
 * @param birthDate - Birth date string in YYYY-MM-DD format
 * @returns Age in years
 */
function calculateAge(birthDate: string): number {
  const birth = new Date(birthDate);
  const today = new Date();
  let age = today.getFullYear() - birth.getFullYear();
  const monthDiff = today.getMonth() - birth.getMonth();
  
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) {
    age--;
  }
  
  return age;
}

/**
 * Extract patient demographics and clinical information
 * @param medplum - Medplum client instance
 * @param patient - Patient resource
 * @returns Promise resolving to patient summary
 */
async function analyzePatient(medplum: MedplumClient, patient: Patient): Promise<PatientSummary> {
  const patientSummary: PatientSummary = {
    conditions: [],
    medications: [],
  };

  // Extract demographics
  if (patient.birthDate) {
    patientSummary.age = calculateAge(patient.birthDate);
  }

  if (patient.gender) {
    patientSummary.sex = patient.gender.toUpperCase();
  }

  // Extract location from patient address
  if (patient.address && patient.address.length > 0) {
    const address = patient.address[0]; // Use first address
    patientSummary.city = address.city;
    patientSummary.state = address.state;
    patientSummary.zipCode = address.postalCode;
  }

  // Get patient conditions
  try {
    const conditions = await medplum.searchResources('Condition', {
      patient: `Patient/${patient.id}`,
      'clinical-status': 'active',
      _sort: '-recorded-date',
      _count: '10',
    });

    patientSummary.conditions = conditions
      .map((condition: Condition) => {
        // Extract condition text from various possible fields
        return condition.code?.text || 
               condition.code?.coding?.[0]?.display ||
               condition.code?.coding?.[0]?.code ||
               'Unknown condition';
      })
      .filter(Boolean);
  } catch (error) {
    console.error('Error fetching patient conditions:', error);
  }

  // Get patient medications
  try {
    const medications = await medplum.searchResources('MedicationRequest', {
      patient: `Patient/${patient.id}`,
      status: 'active',
      _sort: '-authoredon',
      _count: '10',
    });

    patientSummary.medications = medications
      .map((med: MedicationRequest) => {
        return med.medicationCodeableConcept?.text ||
               med.medicationCodeableConcept?.coding?.[0]?.display ||
               med.medicationReference?.display ||
               'Unknown medication';
      })
      .filter(Boolean);
  } catch (error) {
    console.error('Error fetching patient medications:', error);
  }

  return patientSummary;
}

/**
 * Search for clinical trials based on patient information
 * @param patientSummary - Patient summary information for search criteria
 * @returns Promise resolving to array of matching clinical trials
 */
async function searchClinicalTrials(patientSummary: PatientSummary): Promise<ClinicalTrial[]> {
  const url = `${CT_GOV_BASE}/studies`;
  const baseParams: Record<string, any> = {
    'postFilter.overallStatus': 'RECRUITING',
    'fields': 'NCTId|BriefTitle|OfficialTitle|BriefSummary|OverallStatus|InterventionName|LocationFacility|LocationCity|LocationState|EligibilityCriteria',
    'pageSize': 20,
  };

  // Add condition-based search (primary search criteria)
  if (patientSummary.conditions.length > 0) {
    // Use the first/primary condition for search
    baseParams['query.cond'] = patientSummary.conditions[0];
  }

  // Try multiple search strategies in order of preference
  const searchStrategies = [];

  // Strategy 1: City + State (most specific)
  if (patientSummary.city && patientSummary.state) {
    searchStrategies.push({
      name: 'city+state',
      params: { ...baseParams, 'query.locn': `${patientSummary.city}, ${patientSummary.state}` }
    });
  }

  // Strategy 2: State only (broader geographic search)
  if (patientSummary.state) {
    searchStrategies.push({
      name: 'state',
      params: { ...baseParams, 'query.locn': patientSummary.state }
    });
  }

  // Strategy 3: Condition only (no location filter - let AI analyze geography)
  searchStrategies.push({
    name: 'condition-only',
    params: baseParams
  });

  // Try each strategy until we get results
  for (const strategy of searchStrategies) {
    try {
      console.log(`Trying search strategy: ${strategy.name}`);
      const data = await makeCTGovRequest(url, strategy.params);
      const studies = data.studies || [];
      
      if (studies.length > 0) {
        console.log(`Found ${studies.length} trials using ${strategy.name} strategy`);
        return studies.map(formatStudy);
      } else {
        console.log(`No results with ${strategy.name} strategy, trying next approach`);
      }
    } catch (error) {
      console.error(`Error with ${strategy.name} strategy:`, error);
      // Continue to next strategy
    }
  }

  console.log('No trials found with any search strategy');
  return [];
}

/**
 * Use Gemini AI to analyze patient data and clinical trials, generating clinical findings
 * @param patientSummary - Patient summary information
 * @param trials - Array of clinical trials found
 * @param apiKey - Gemini API key
 * @returns Promise resolving to AI-generated clinical findings
 */
async function generateClinicalFindings(
  patientSummary: PatientSummary,
  trials: ClinicalTrial[],
  apiKey: string
): Promise<string> {
  try {
    // Prepare the analysis prompt
    const patientInfo = `Patient: ${patientSummary.age ? `${patientSummary.age} years old` : 'Age unknown'}, ${patientSummary.sex || 'Gender unknown'}
Conditions: ${patientSummary.conditions.length > 0 ? patientSummary.conditions.join(', ') : 'No active conditions found'}
Current medications: ${patientSummary.medications.length > 0 ? patientSummary.medications.join(', ') : 'No active medications found'}`;

    // Simplify trial data to reduce payload size and processing time
    const simplifiedTrials = trials.map(trial => ({
      nctId: trial.nctId,
      title: trial.title,
      briefSummary: trial.briefSummary.substring(0, 200), // Truncate summary
      overallStatus: trial.overallStatus,
      eligibilityCriteria: trial.eligibilityCriteria?.substring(0, 200), // Truncate criteria
      url: trial.url
    }));

    const analysisPrompt = `You are a clinical research specialist. Analyze the patient and each clinical trial to provide structured recommendations.

PATIENT INFORMATION:
${patientInfo}

For each trial provided, you must analyze:
1. Patient eligibility based on age, sex, conditions, and current medications
2. Potential medication interactions or contraindications
3. Overall fit level (high/medium/low) with clear reasoning
4. Specific next steps if recommended

IMPORTANT: Only analyze the trials provided. Do not add or modify NCT IDs. Use the exact NCT ID from each trial.`;

    // Create function schema for structured output
    const functionDeclaration = {
      name: "analyze_clinical_trials",
      description: "Analyze clinical trials for patient eligibility and provide structured recommendations",
      parameters: {
        type: "object",
        properties: {
          patientSummary: {
            type: "string",
            description: "Brief summary of patient's clinical profile"
          },
          trialRecommendations: {
            type: "array",
            items: {
              type: "object",
              properties: {
                nctId: {
                  type: "string",
                  enum: simplifiedTrials.map(trial => trial.nctId),
                  description: "The exact NCT ID from the provided trials"
                },
                recommendation: {
                  type: "string",
                  enum: ["high", "medium", "low"],
                  description: "Recommendation level based on patient fit"
                },
                reasoning: {
                  type: "string",
                  description: "Clear reasoning for the recommendation level"
                },
                eligibilityAssessment: {
                  type: "string",
                  description: "Assessment of patient eligibility for this specific trial"
                },
                medicationConsiderations: {
                  type: "string",
                  description: "Analysis of medication interactions or considerations"
                },
                nextSteps: {
                  type: "string",
                  description: "Specific next steps if this trial is recommended"
                }
              },
              required: ["nctId", "recommendation", "reasoning", "eligibilityAssessment"]
            }
          },
          overallAssessment: {
            type: "string",
            description: "Overall assessment and clinical recommendations"
          },
          priorityActions: {
            type: "array",
            items: {
              type: "string"
            },
            description: "List of priority actions for the practitioner"
          }
        },
        required: ["patientSummary", "trialRecommendations", "overallAssessment", "priorityActions"]
      }
    };

    // Call Gemini API with function calling
    const response = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: `${analysisPrompt}

CLINICAL TRIALS TO ANALYZE:
${JSON.stringify(simplifiedTrials, null, 2)}`
              }
            ]
          }
        ],
        tools: [
          {
            functionDeclarations: [functionDeclaration]
          }
        ],
        toolConfig: {
          functionCallingConfig: {
            mode: "ANY"
          }
        }
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'No error details available');
      throw new Error(`Gemini API failed: ${response.status} ${response.statusText} - ${errorText}`);
    }

    const result = await response.json() as GeminiResponse;
    
    // Extract the function call result
    const functionCall = result.candidates?.[0]?.content?.parts?.[0]?.functionCall;
    
    if (functionCall?.name !== 'analyze_clinical_trials') {
      throw new Error('No function call result from Gemini');
    }
    
    const analysis: ClinicalAnalysis = functionCall.args;
    
    // Format the structured analysis into a readable communication
    return formatAnalysisForCommunication(analysis, trials);
    
  } catch (error) {
    console.error('Error generating Gemini analysis:', error);
    
    // Fallback to basic formatting if AI fails
    const patientInfo = `Patient: ${patientSummary.age ? `${patientSummary.age} years old` : 'Age unknown'}, ${patientSummary.sex || 'Gender unknown'}
Conditions: ${patientSummary.conditions.length > 0 ? patientSummary.conditions.join(', ') : 'No active conditions found'}
Current medications: ${patientSummary.medications.length > 0 ? patientSummary.medications.join(', ') : 'No active medications found'}`;

    let fallbackMessage = `Clinical Trials Analysis\n\n${patientInfo}\n\n`;
    
    if (trials.length === 0) {
      fallbackMessage += 'No recruiting clinical trials found matching the patient\'s profile.\n\n';
    } else {
      fallbackMessage += `Found ${trials.length} recruiting clinical trials:\n\n`;
      trials.forEach((trial, index) => {
        fallbackMessage += `${index + 1}. ${trial.title}\n`;
        fallbackMessage += `   NCT ID: ${trial.nctId}\n`;
        fallbackMessage += `   Status: ${trial.overallStatus}\n`;
        fallbackMessage += `   Summary: ${trial.briefSummary}\n`;
        fallbackMessage += `   More info: ${trial.url}\n\n`;
      });
    }
    
    fallbackMessage += 'Note: AI analysis failed, showing basic search results. Please review manually.\n';
    fallbackMessage += `Error: ${error instanceof Error ? error.message : String(error)}`;
    
    return fallbackMessage;
  }
}

/**
 * Format the structured AI analysis into a readable communication
 * @param analysis - Structured analysis from AI
 * @param originalTrials - Original trials to ensure URLs are included
 * @returns Formatted communication string
 */
function formatAnalysisForCommunication(analysis: ClinicalAnalysis, originalTrials: ClinicalTrial[]): string {
  // Create a map for quick URL lookup
  const trialUrlMap = new Map(originalTrials.map(trial => [trial.nctId, trial.url]));
  
  let communication = `Clinical Trials Analysis\n\n`;
  
  // Patient Summary
  communication += `PATIENT SUMMARY:\n${analysis.patientSummary}\n\n`;
  
  // Trial Recommendations
  communication += `TRIAL RECOMMENDATIONS:\n\n`;
  
  // Sort recommendations by priority (high -> medium -> low)
  const sortedRecommendations = analysis.trialRecommendations.sort((a, b) => {
    const priority = { high: 3, medium: 2, low: 1 };
    return priority[b.recommendation] - priority[a.recommendation];
  });
  
  sortedRecommendations.forEach((rec, index) => {
    const trialUrl = trialUrlMap.get(rec.nctId) || `https://clinicaltrials.gov/study/${rec.nctId}`;
    
    communication += `${index + 1}. ${rec.recommendation.toUpperCase()} PRIORITY\n`;
    communication += `   NCT ID: ${rec.nctId}\n`;
    communication += `   Trial URL: ${trialUrl}\n`;
    communication += `   Reasoning: ${rec.reasoning}\n`;
    communication += `   Eligibility: ${rec.eligibilityAssessment}\n`;
    
    if (rec.medicationConsiderations) {
      communication += `   Medication Considerations: ${rec.medicationConsiderations}\n`;
    }
    
    if (rec.nextSteps) {
      communication += `   Next Steps: ${rec.nextSteps}\n`;
    }
    
    communication += `\n`;
  });
  
  // Overall Assessment
  communication += `OVERALL ASSESSMENT:\n${analysis.overallAssessment}\n\n`;
  
  // Priority Actions
  if (analysis.priorityActions && analysis.priorityActions.length > 0) {
    communication += `PRIORITY ACTIONS:\n`;
    analysis.priorityActions.forEach((action, index) => {
      communication += `${index + 1}. ${action}\n`;
    });
    communication += `\n`;
  }
  
  communication += `---\nThis analysis was generated using AI and should be reviewed by a qualified healthcare provider before making clinical decisions.`;
  
  return communication;
}

/**
 * Find or create the Gemini Device resource
 * @param medplum - Medplum client instance
 * @returns Promise resolving to the Gemini Device resource
 */
async function getGeminiDevice(medplum: MedplumClient): Promise<Device> {
  // First try to find existing Gemini device
  const existingDevice = await medplum.searchOne('Device', {
    manufacturer: 'Google',
    'device-name': 'Gemini',
    type: 'model-name'
  });

  if (existingDevice) {
    return existingDevice;
  }

  // Create new Gemini device if not found
  const geminiDevice: Device = {
    resourceType: 'Device',
    status: 'active',
    manufacturer: 'Google',
    deviceName: [
      {
        name: 'Gemini',
        type: 'model-name'
      }
    ],
  };

  return medplum.createResource(geminiDevice);
}

export async function handler(
  medplum: MedplumClient,
  event: BotEvent<ClinicalTrialsBotInput>
): Promise<ClinicalTrialsBotOutput> {
  try {
    const { patient, practitioner, searchRadius = 100 } = event.input;

    if (!patient?.id) {
      throw new Error('Patient information is required');
    }

    console.log(`Analyzing patient ${patient.id} for clinical trials within ${searchRadius} miles`);

    // Get API credentials
    const geminiApiKey = event.secrets["GEMINI_API_KEY"]?.valueString as string;

    if (!geminiApiKey) {
      throw new Error('Gemini API key not configured');
    }

    // Get or create Gemini Device
    const geminiDevice = await getGeminiDevice(medplum);

    // Analyze patient data
    const patientSummary = await analyzePatient(medplum, patient);
    console.log('Patient summary:', patientSummary);

    // Search for clinical trials
    const trials = await searchClinicalTrials(patientSummary);
    console.log(`Found ${trials.length} clinical trials`);  

    // Generate AI analysis of patient + trials
    const clinicalFindings = await generateClinicalFindings(patientSummary, trials, geminiApiKey);
    console.log('Gemini analysis completed');

    // Create Task resource
    const task: Task = {
      resourceType: 'Task',
      status: 'in-progress',
      intent: 'proposal',
      code: {
        coding: [
          {
            system: 'http://snomed.info/sct',
            code: '386053000',
            display: 'Evaluation procedure'
          }
        ],
        text: 'Evaluation procedure'
      },
      for: {
        reference: `Patient/${patient.id}`,
        display: patient.name?.[0] ? `${patient.name[0].given?.join(' ')} ${patient.name[0].family}` : 'Patient'
      },
      description: 'Analysis of relevant clinical trials for the patient',
      priority: 'routine',
      requester: {
        reference: `Device/${geminiDevice.id}`,
        display: 'Gemini AI'
      },
      note: [
        {
          text: clinicalFindings
        }
      ]
    };

    // Add owner (practitioner) if provided
    if (practitioner?.id) {
      task.owner = {
        reference: `Practitioner/${practitioner.id}`,
        display: practitioner.name?.[0] ? `${practitioner.name[0].given?.join(' ')} ${practitioner.name[0].family}` : 'Practitioner'
      };
    }

    // Create the task in the FHIR server
    const createdTask = await medplum.createResource(task);

    console.log(`Created task ${createdTask.id} with Gemini analysis of ${trials.length} clinical trials`);

    return {
      task: createdTask,
      trialsFound: trials.length,
    };
  } catch (error) {
    console.error('Clinical trials bot error:', error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Clinical trials search failed: ${errorMessage}`);
  }
} 