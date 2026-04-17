# How the Bots Work in Practice

This document explains how Medplum bots function as the integration layer between the frontend UI and PhenoML's AI-powered healthcare APIs.

## What Are Medplum Bots?

Medplum bots are **TypeScript functions** that run on the server (in AWS Lambda or a local Node.js VM). They act as the **integration layer** between the Medplum FHIR server and external services like PhenoML.

```
┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐
│   Frontend UI   │ ───> │   Medplum Bot   │ ───> │  PhenoML API    │
│  (React App)    │      │ (TypeScript)    │      │  (Go Backend)   │
└─────────────────┘      └─────────────────┘      └─────────────────┘
                                │
                                ▼
                         ┌─────────────────┐
                         │  Medplum FHIR   │
                         │    Server       │
                         └─────────────────┘
```

## The 5 Bots in This Application

| Bot | File | Purpose |
|-----|------|---------|
| **lang2fhir-create** | `src/bots/lang2fhir-create.ts` | Convert natural language text → FHIR resources |
| **lang2fhir-document** | `src/bots/lang2fhir-document.ts` | Convert PDF/images → FHIR Questionnaires |
| **phenoml-cohort** | `src/bots/phenoml-cohort.ts` | Natural language → Patient cohort (Group) |
| **clinical-trials-bot** | `src/bots/clinical-trials-bot.ts` | Find clinical trials for a patient |
| **phenoml-workflow** | `src/bots/phenoml-workflow.ts` | Execute custom PhenoML workflows |

---

## Practical Example: lang2fhir-create Bot

Let's walk through what happens when a provider types "Blood pressure 120/80 mmHg":

### Step 1: Frontend Invokes the Bot

```typescript
// In the UI (ResourceLang2FHIRCreatePage.tsx)
const result = await medplum.executeBot(
  { reference: `Bot/${botId}` },
  {
    text: "Blood pressure 120/80 mmHg",
    resourceType: "Observation",
    patient: currentPatient
  }
);
```

### Step 2: Bot Receives Input and Calls PhenoML

```typescript
// In lang2fhir-create.ts
export async function handler(
  medplum: MedplumClient,
  event: BotEvent<CreateBotInput>
): Promise<AllowedResourceTypes> {
  const { text, resourceType, patient } = event.input;

  // Get credentials from Medplum secrets
  const email = event.secrets["PHENOML_EMAIL"].valueString;
  const password = event.secrets["PHENOML_PASSWORD"].valueString;

  // Initialize PhenoML SDK
  const phenomlClient = new PhenoMLClient({ username: email, password });

  // Call Lang2FHIR API
  const generatedResource = await phenomlClient.lang2Fhir.create({
    version: 'R4',
    resource: 'simple-observation',  // Profile for Observation
    text: "Blood pressure 120/80 mmHg"
  });

  // Add patient reference
  generatedResource.subject = {
    reference: `Patient/${patient.id}`,
    display: patient.name[0].text
  };

  return generatedResource;
}
```

### Step 3: PhenoML Backend Processes the Request

```
PhenoML Backend (Go):

1. Construe module extracts medical codes:
   - LOINC: 85354-9 (Blood pressure panel)
   - LOINC: 8480-6 (Systolic BP)
   - LOINC: 8462-4 (Diastolic BP)

2. Gemini LLM generates FHIR with constrained codes:
   - Uses function calling to ensure valid structure
   - Only uses extracted codes (prevents hallucination)

3. Returns complete FHIR Observation
```

### Step 4: Frontend Receives the Result

```json
{
  "resourceType": "Observation",
  "status": "final",
  "code": {
    "coding": [{
      "system": "http://loinc.org",
      "code": "85354-9",
      "display": "Blood pressure panel"
    }]
  },
  "subject": {
    "reference": "Patient/123",
    "display": "John Smith"
  },
  "component": [
    {
      "code": {"coding": [{"system": "http://loinc.org", "code": "8480-6"}]},
      "valueQuantity": {"value": 120, "unit": "mmHg"}
    },
    {
      "code": {"coding": [{"system": "http://loinc.org", "code": "8462-4"}]},
      "valueQuantity": {"value": 80, "unit": "mmHg"}
    }
  ]
}
```

### Step 5: User Reviews and Saves

The frontend displays this resource for review, then the user clicks save to persist it to Medplum.

---

## How Secrets Work

Bots access credentials via `event.secrets`:

```typescript
// Secrets are configured in Medplum Admin → Project → Secrets
const email = event.secrets["PHENOML_EMAIL"].valueString;
const password = event.secrets["PHENOML_PASSWORD"].valueString;
```

This keeps credentials secure - they're never in the code or frontend.

---

## Bot Runtime: vmcontext vs awslambda

| Runtime | Use Case | How It Works |
|---------|----------|--------------|
| `vmcontext` | Local development | Runs in Node.js VM on Medplum server |
| `awslambda` | Production | Runs in AWS Lambda (scalable, isolated) |

Configure the runtime in `src/scripts/deploy-bots.ts`:

```typescript
runtimeVersion: 'vmcontext', // Local development
// runtimeVersion: 'awslambda', // Production
```

---

## Cohort Bot Example

When a user types "Female patients over 40 with diabetes":

```typescript
// phenoml-cohort.ts
const queries = await phenomlClient.cohort.analyze({
  text: "Female patients over 40 with diabetes",
  exclude_deceased: true
});

// PhenoML returns:
// [
//   {concept: "female patients over 40", resourceType: "Patient",
//    searchParams: "gender=female&birthdate=lt1984-01-13"},
//   {concept: "diabetes", resourceType: "Condition",
//    searchParams: "code=E11", exclude: false}
// ]

// Bot executes each search against Medplum
for (const query of queries) {
  const results = await medplum.searchResources(
    query.resourceType,
    query.searchParams
  );
  patientIds = intersect(patientIds, extractPatientIds(results));
}

// Creates FHIR Group with matching patients
const group = {
  resourceType: "Group",
  type: "person",
  actual: true,
  member: patientIds.map(id => ({ entity: { reference: `Patient/${id}` }}))
};
```

---

## Document Processing Bot

The `lang2fhir-document` bot handles PDF and image uploads:

```typescript
// lang2fhir-document.ts
export async function handler(
  medplum: MedplumClient,
  event: BotEvent<DocumentBotInput>
): Promise<Questionnaire | QuestionnaireResponse> {
  const { docref, resourceType } = event.input;

  // Download the document from Medplum
  const documentRef = await medplum.readResource('DocumentReference', docref);
  const binaryUrl = documentRef.content[0].attachment.url;
  const binary = await medplum.download(binaryUrl);

  // Convert to base64
  const content = Buffer.from(await binary.arrayBuffer()).toString('base64');
  const mimeType = documentRef.content[0].attachment.contentType;

  // Call PhenoML document API
  const phenomlClient = new PhenoMLClient({ username, password });
  const result = await phenomlClient.lang2Fhir.document({
    content: content,
    file_type: mimeType,  // 'application/pdf', 'image/png', 'image/jpeg'
    resource: resourceType
  });

  return result;
}
```

---

## Clinical Trials Bot

The `clinical-trials-bot` searches ClinicalTrials.gov and uses Gemini for analysis:

```typescript
// clinical-trials-bot.ts
export async function handler(medplum, event) {
  const { patient, searchRadius } = event.input;

  // 1. Gather patient data
  const conditions = await medplum.searchResources('Condition',
    `subject=Patient/${patient.id}`);
  const medications = await medplum.searchResources('MedicationRequest',
    `subject=Patient/${patient.id}`);

  // 2. Search ClinicalTrials.gov
  const trials = await searchClinicalTrials({
    conditions: conditions.map(c => c.code.text),
    location: patient.address[0]
  });

  // 3. Use Gemini to analyze eligibility
  const analysis = await analyzeWithGemini({
    patient: { age, sex, conditions, medications },
    trials: trials
  });

  // 4. Create Task with findings
  const task = {
    resourceType: "Task",
    status: "ready",
    intent: "proposal",
    for: { reference: `Patient/${patient.id}` },
    description: "Clinical Trial Recommendations",
    note: [{ text: analysis.recommendations }]
  };

  return await medplum.createResource(task);
}
```

---

## Visual Flow Summary

```
┌──────────────────────────────────────────────────────────────────┐
│                        USER INTERACTION                          │
│  "Blood pressure 120/80 mmHg" → [Create Observation]             │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│                         MEDPLUM BOT                              │
│  1. Get credentials from secrets                                 │
│  2. Initialize PhenoML SDK                                       │
│  3. Call phenomlClient.lang2Fhir.create()                        │
│  4. Add patient reference to result                              │
│  5. Return FHIR resource                                         │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│                      PHENOML BACKEND                             │
│  1. Construe: Extract SNOMED/LOINC/ICD codes via vector search   │
│  2. Gemini LLM: Generate FHIR JSON with function calling         │
│  3. Post-process: Add display names, validate structure          │
│  4. Return valid FHIR R4 resource                                │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│                         FRONTEND UI                              │
│  1. Display generated resource for review                        │
│  2. User edits if needed                                         │
│  3. User clicks Save → medplum.createResource()                  │
│  4. Resource persisted to Medplum FHIR server                    │
└──────────────────────────────────────────────────────────────────┘
```

---

## Key Takeaways

1. **Bots are the secure bridge** - They hold credentials, call external APIs, and return structured FHIR data
2. **Secrets stay secure** - Credentials are stored in Medplum, never exposed to frontend
3. **Human-in-the-loop** - Users review generated resources before saving
4. **PhenoML does the AI work** - Code extraction (Construe) + LLM generation (Gemini)
5. **Medplum stores the data** - Final FHIR resources are persisted to Medplum

## Related Documentation

- [ARCHITECTURE.md](./ARCHITECTURE.md) - System architecture
- [PHENOML_INTEGRATION.md](./PHENOML_INTEGRATION.md) - Integration details
- [BOT_VS_AGENT.md](./BOT_VS_AGENT.md) - Comparison with agent-based approach
