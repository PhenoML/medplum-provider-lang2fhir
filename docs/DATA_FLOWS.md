# Data Flow Documentation

Detailed data flow diagrams for all major operations in the Medplum Provider with Lang2FHIR application.

## Overview

This document provides comprehensive sequence diagrams showing how data flows through the system for each major operation.

## Flow 1: Text to FHIR Resource

Convert natural language clinical text into structured FHIR resources.

### Sequence Diagram

```mermaid
sequenceDiagram
    participant User
    participant UI as Medplum UI
    participant Bot as lang2fhir-create Bot
    participant Secrets as Medplum Secrets
    participant SDK as PhenoML SDK
    participant Auth as PhenoML Auth
    participant API as Lang2FHIR API
    participant Construe as Construe Module
    participant LLM as Gemini LLM
    participant FHIR as Medplum FHIR

    User->>UI: Enter clinical text<br/>"BP 120/80 mmHg"
    UI->>Bot: executeBot(botId, {text, resourceType, patient})

    Bot->>Secrets: Get PHENOML_EMAIL, PHENOML_PASSWORD
    Secrets-->>Bot: Credentials

    Bot->>SDK: new PhenoMLClient(credentials)
    SDK->>Auth: Authenticate
    Auth-->>SDK: JWT Token

    Bot->>SDK: client.lang2Fhir.create({text, resource, version})
    SDK->>API: POST /lang2fhir/create

    API->>Construe: Extract medical codes from text
    Note over Construe: Vector search in Firestore<br/>768-dim embeddings
    Construe-->>API: LOINC: 85354-9 (BP panel)<br/>LOINC: 8480-6 (systolic)<br/>LOINC: 8462-4 (diastolic)

    API->>LLM: Generate FHIR with constrained schema
    Note over LLM: Function calling with<br/>code enum constraints
    LLM-->>API: Structured FHIR Observation JSON

    API->>API: Post-process: add display names
    API-->>SDK: Complete FHIR Observation
    SDK-->>Bot: Resource object

    Bot->>Bot: Add patient reference<br/>subject: {reference: "Patient/123"}
    Bot-->>UI: FHIR Observation

    UI->>FHIR: createResource(observation)
    FHIR-->>UI: Created resource with ID
    UI-->>User: Display success
```

### Key Points

- **Code Extraction**: Construe uses vector search to find valid medical codes
- **Constrained Generation**: LLM can only use extracted codes (prevents hallucination)
- **Patient Linking**: Bot adds patient reference before returning

---

## Flow 2: Document Processing

Upload PDF or images and convert to FHIR Questionnaires.

### Sequence Diagram

```mermaid
sequenceDiagram
    participant User
    participant UI as Medplum UI
    participant FHIR as Medplum FHIR
    participant Bot as lang2fhir-document Bot
    participant Secrets as Medplum Secrets
    participant SDK as PhenoML SDK
    participant API as Lang2FHIR API
    participant Extract as Text Extraction
    participant LLM as Gemini Vision/LLM

    User->>UI: Upload PDF/Image
    UI->>FHIR: Create DocumentReference + Binary
    FHIR-->>UI: DocumentReference ID

    UI->>Bot: executeBot(botId, {docref, resourceType})

    Bot->>Secrets: Get credentials
    Secrets-->>Bot: PHENOML_EMAIL, PHENOML_PASSWORD

    Bot->>FHIR: Get DocumentReference
    FHIR-->>Bot: DocumentReference with content URL

    Bot->>FHIR: Download Binary content
    FHIR-->>Bot: Raw file bytes

    Bot->>Bot: Base64 encode content
    Bot->>Bot: Determine MIME type

    Bot->>SDK: new PhenoMLClient(credentials)
    Bot->>SDK: client.lang2Fhir.document({content, fileType, resource})
    SDK->>API: POST /lang2fhir/document

    alt PDF Document
        API->>Extract: docconv text extraction
        Extract-->>API: Extracted text
    else Image (PNG/JPEG)
        API->>LLM: Gemini Vision processing
        LLM-->>API: Extracted text + structure
    end

    API->>LLM: Convert to FHIR Questionnaire
    Note over LLM: Resource-specific prompts<br/>for form structure
    LLM-->>API: FHIR Questionnaire

    API-->>SDK: Questionnaire resource
    SDK-->>Bot: Resource object
    Bot-->>UI: FHIR Questionnaire

    UI->>User: Display questionnaire for review
```

### Supported File Types

| Type | MIME | Processing Method |
|------|------|-------------------|
| PDF | `application/pdf` | docconv text extraction |
| PNG | `image/png` | Gemini Vision |
| JPEG | `image/jpeg` | Gemini Vision |

---

## Flow 3: Cohort Creation

Create patient cohorts from natural language descriptions.

### Sequence Diagram

```mermaid
sequenceDiagram
    participant User
    participant UI as Medplum UI
    participant Bot as phenoml-cohort Bot
    participant Secrets as Medplum Secrets
    participant SDK as PhenoML SDK
    participant API as Cohort API
    participant LLM as Gemini LLM
    participant FHIR as Medplum FHIR

    User->>UI: Enter cohort description<br/>"Female patients over 40 with diabetes"
    UI->>Bot: executeBot(botId, {text, config})

    Bot->>Secrets: Get credentials
    Secrets-->>Bot: Credentials

    Bot->>SDK: new PhenoMLClient(credentials)
    Bot->>SDK: client.cohort.analyze({text, exclude_deceased})
    SDK->>API: POST /cohort

    API->>LLM: Detect search concepts
    Note over LLM: add_concept() function calling<br/>for each criterion
    LLM-->>API: Concepts array

    API->>API: Convert concepts to FHIR searches
    Note over API: "female" → gender=female<br/>"over 40" → birthdate=lt{date}<br/>"diabetes" → code=E11

    API-->>SDK: Array of SearchConcept
    SDK-->>Bot: Queries with include/exclude flags

    loop For each query
        Bot->>FHIR: searchResources(resourceType, searchParams)
        FHIR-->>Bot: Matching resources
        Bot->>Bot: Extract patient IDs
    end

    Bot->>Bot: Initialize: all patients from first query
    Bot->>Bot: Intersect with subsequent include queries
    Bot->>Bot: Remove patients from exclude queries

    Bot->>Bot: Create FHIR Group resource
    Note over Bot: type: "person"<br/>actual: true<br/>member: [...patient refs]

    Bot-->>UI: FHIR Group
    UI->>FHIR: createResource(group)
    FHIR-->>UI: Group ID
    UI-->>User: Display cohort with patient count
```

### Set Operation Logic

```mermaid
flowchart TB
    A[Query 1: Female Patients] --> B[Initial Set: 100 patients]
    C[Query 2: Age > 40] --> D[Intersect]
    B --> D
    D --> E[Remaining: 60 patients]
    F[Query 3: Diabetes] --> G[Intersect]
    E --> G
    G --> H[Remaining: 25 patients]
    I[Query 4: NOT Hypertension] --> J[Exclude]
    H --> J
    J --> K[Final Cohort: 18 patients]
```

---

## Flow 4: Clinical Trials Search

Find and analyze clinical trials for a specific patient.

### Sequence Diagram

```mermaid
sequenceDiagram
    participant User
    participant UI as Medplum UI
    participant Bot as clinical-trials-bot
    participant FHIR as Medplum FHIR
    participant CT as ClinicalTrials.gov API
    participant Gemini as Google Gemini

    User->>UI: Click "Find Clinical Trials"
    UI->>Bot: executeBot(botId, {patient, practitioner, searchRadius})

    Bot->>FHIR: Get patient conditions
    FHIR-->>Bot: Condition resources
    Bot->>FHIR: Get patient medications
    FHIR-->>Bot: MedicationRequest resources
    Bot->>FHIR: Get patient demographics
    FHIR-->>Bot: Patient resource with address

    Bot->>Bot: Build patient summary
    Note over Bot: age, sex, conditions,<br/>medications, location

    Bot->>CT: Search trials (condition + city + state)
    CT-->>Bot: Trial results (or empty)

    alt No results with city
        Bot->>CT: Search trials (condition + state)
        CT-->>Bot: Trial results (or empty)
    end

    alt No results with state
        Bot->>CT: Search trials (condition only)
        CT-->>Bot: Trial results
    end

    Bot->>Gemini: Analyze patient eligibility
    Note over Gemini: Patient profile +<br/>Trial inclusion/exclusion criteria

    Gemini-->>Bot: Structured recommendations
    Note over Gemini: recommendation: high/medium/low<br/>reasoning<br/>eligibilityAssessment<br/>medicationConsiderations<br/>nextSteps

    Bot->>Bot: Format findings as Task notes
    Bot->>FHIR: Create Task resource
    Note over FHIR: status: ready<br/>intent: proposal<br/>for: Patient reference<br/>description: AI findings
    FHIR-->>Bot: Task ID

    Bot-->>UI: Task with trial recommendations
    UI-->>User: Display trial analysis
```

### Search Strategy

```mermaid
flowchart TB
    A[Start Search] --> B{Condition + City + State}
    B -->|Results| Z[Return Trials]
    B -->|No Results| C{Condition + State}
    C -->|Results| Z
    C -->|No Results| D{Condition Only}
    D -->|Results| Z
    D -->|No Results| E[No Trials Found]
```

---

## Flow 5: Workflow Execution

Execute custom PhenoML workflows.

### Sequence Diagram

```mermaid
sequenceDiagram
    participant User
    participant UI as Medplum UI
    participant Bot as phenoml-workflow Bot
    participant Secrets as Medplum Secrets
    participant SDK as PhenoML SDK
    participant API as Workflows API
    participant Engine as Workflow Engine

    User->>UI: Trigger workflow
    UI->>Bot: executeBot(botId, {workflowId, inputData})

    Bot->>Secrets: Get credentials
    Secrets-->>Bot: Credentials

    Bot->>Bot: Validate workflowId and inputData

    Bot->>SDK: new PhenoMLClient(credentials)
    Bot->>SDK: client.workflows.execute(workflowId, {input_data})
    SDK->>API: POST /workflows/execute

    API->>Engine: Load workflow definition
    Engine->>Engine: Execute workflow graph
    Note over Engine: Step 1 → Step 2 → Step 3...<br/>Each step may call tools/APIs

    Engine-->>API: Execution results
    API-->>SDK: Response with results
    SDK-->>Bot: Workflow output

    Bot-->>UI: {success, message, results}
    UI-->>User: Display workflow results
```

---

## Flow 6: Encounter Charting with Auto-Save

Real-time encounter documentation with debounced updates.

### Sequence Diagram

```mermaid
sequenceDiagram
    participant Provider as Healthcare Provider
    participant UI as Encounter Chart UI
    participant Hook as useDebouncedUpdate
    participant FHIR as Medplum FHIR
    participant Bot as lang2fhir-create Bot

    Provider->>UI: Type in SOAP note field
    UI->>Hook: Update local state
    Hook->>Hook: Reset 100ms debounce timer

    Provider->>UI: Continue typing...
    UI->>Hook: Update local state
    Hook->>Hook: Reset debounce timer

    Note over Hook: 100ms passes without typing

    Hook->>FHIR: updateResource(ClinicalImpression)
    FHIR-->>Hook: Updated resource
    UI->>UI: Show "Saved" indicator

    Provider->>UI: Click "Add Condition"
    UI->>UI: Open Lang2FHIR dialog
    Provider->>UI: Enter "Patient has hypertension"

    UI->>Bot: executeBot(lang2fhir-create, {...})
    Bot-->>UI: FHIR Condition resource

    UI->>UI: Display condition for review
    Provider->>UI: Click "Save"
    UI->>FHIR: createResource(Condition)
    FHIR-->>UI: Condition ID
    UI->>UI: Add to encounter problem list
```

### Debounce Configuration

```typescript
const DEBOUNCE_MS = 100;

// In useEncounterChart hook
const debouncedUpdate = useDebouncedUpdateResource(
  DEBOUNCE_MS
);
```

---

## Flow 7: Multi-Resource Extraction

Extract multiple related FHIR resources from a single clinical note.

### Sequence Diagram

```mermaid
sequenceDiagram
    participant User
    participant UI as Medplum UI
    participant SDK as PhenoML SDK
    participant API as Lang2FHIR API
    participant LLM as Gemini LLM
    participant FHIR as Medplum FHIR

    User->>UI: Enter complex clinical note
    Note over User: "45yo female with T2DM,<br/>prescribed Metformin 500mg,<br/>BP 140/90"

    UI->>SDK: client.lang2Fhir.createMulti({text, version})
    SDK->>API: POST /lang2fhir/create/multi

    API->>LLM: Detect all resource concepts
    LLM-->>API: Concepts with UUIDs
    Note over API: Patient: uuid-1<br/>Condition (T2DM): uuid-2<br/>MedicationRequest: uuid-3<br/>Observation (BP): uuid-4

    API->>LLM: Determine references between resources
    LLM-->>API: Reference mappings
    Note over API: Condition.subject → Patient<br/>MedicationRequest.subject → Patient<br/>MedicationRequest.reasonReference → Condition

    loop For each concept
        API->>API: Create individual resource
        API->>API: Inject references using UUIDs
    end

    API->>API: Build transaction Bundle
    API-->>SDK: Bundle + individual resources
    SDK-->>UI: {bundle, resources}

    UI->>UI: Display resources for review
    User->>UI: Approve and save

    UI->>FHIR: Transaction Bundle POST
    FHIR-->>UI: Created resources with IDs
    UI-->>User: Success with resource count
```

### Bundle Structure

```json
{
  "resourceType": "Bundle",
  "type": "transaction",
  "entry": [
    {
      "fullUrl": "urn:uuid:uuid-1",
      "resource": { "resourceType": "Patient", ... },
      "request": { "method": "POST", "url": "Patient" }
    },
    {
      "fullUrl": "urn:uuid:uuid-2",
      "resource": {
        "resourceType": "Condition",
        "subject": { "reference": "urn:uuid:uuid-1" },
        ...
      },
      "request": { "method": "POST", "url": "Condition" }
    },
    {
      "fullUrl": "urn:uuid:uuid-3",
      "resource": {
        "resourceType": "MedicationRequest",
        "subject": { "reference": "urn:uuid:uuid-1" },
        "reasonReference": [{ "reference": "urn:uuid:uuid-2" }],
        ...
      },
      "request": { "method": "POST", "url": "MedicationRequest" }
    }
  ]
}
```

---

## Summary

| Flow | Purpose | Key Components |
|------|---------|----------------|
| **Text to FHIR** | NLP → structured data | Construe, Gemini, Function Calling |
| **Document Processing** | PDF/Image → Questionnaire | Vision LLM, docconv |
| **Cohort Creation** | Language → Patient groups | Concept detection, Set operations |
| **Clinical Trials** | Patient matching | ClinicalTrials.gov, Gemini analysis |
| **Workflow Execution** | Custom automation | Workflow engine |
| **Encounter Charting** | Real-time documentation | Debounced updates |
| **Multi-Resource** | Complex notes | Reference resolution, Bundles |

## Related Documentation

- [ARCHITECTURE.md](./ARCHITECTURE.md) - System architecture
- [PHENOML_INTEGRATION.md](./PHENOML_INTEGRATION.md) - Integration details
- [PHENOML_APIS.md](./PHENOML_APIS.md) - API reference
- [BOTS.md](./BOTS.md) - Bot implementation
