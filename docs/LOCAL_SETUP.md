# Local Development Setup Guide

Complete guide for running the Medplum Provider with Lang2FHIR locally.

## Prerequisites

### Required

| Requirement | Version | Verification |
|-------------|---------|--------------|
| Node.js | ^20.19.0 or >=22.12.0 | `node --version` |
| npm | ^10.9.3 | `npm --version` |
| Medplum Stack | Local or Hosted | See below |
| PhenoML Account | Core plan for production | [developer.pheno.ml](https://developer.pheno.ml) |

### Optional

| Requirement | Purpose |
|-------------|---------|
| Gemini API Key | Clinical trials AI analysis |
| Docker | For running Medplum locally |

## Medplum Options

You have two options for the Medplum backend:

### Option A: Hosted Medplum (Recommended for Getting Started)

Use Medplum's hosted service at [app.medplum.com](https://app.medplum.com/):

1. Create an account at [app.medplum.com](https://app.medplum.com/)
2. Create a new project
3. No additional configuration needed in `main.tsx`

### Option B: Local Medplum Stack

Run Medplum locally for development:

1. Follow [Medplum's local setup guide](https://www.medplum.com/docs/contributing/run-the-stack)
2. Start the Medplum stack (typically runs on `http://localhost:8103`)
3. Configure `main.tsx` to point to local instance (see Step 2 below)

## Step-by-Step Setup

### Step 1: Clone and Install

```bash
# Clone the repository
git clone https://github.com/PhenoML/medplum-provider-lang2fhir.git
cd medplum-provider-lang2fhir

# Install dependencies
npm install
```

### Step 2: Configure Medplum Connection

Edit `src/main.tsx` to configure your Medplum backend:

**For Hosted Medplum (default):**
```typescript
const medplum = new MedplumClient({
  onUnauthenticated: () => (window.location.href = '/'),
  // Uses hosted Medplum at app.medplum.com by default
  cacheTime: 60000,
  autoBatchTime: 100,
});
```

**For Local Medplum:**
```typescript
const medplum = new MedplumClient({
  onUnauthenticated: () => (window.location.href = '/'),
  baseUrl: 'http://localhost:8103/',  // Uncomment this line
  cacheTime: 60000,
  autoBatchTime: 100,
});
```

### Step 3: Configure Bot Runtime

Edit `src/scripts/deploy-bots.ts` line 58 to set the bot runtime:

**For Hosted Medplum (production):**
```typescript
runtimeVersion: 'awslambda',
```

**For Local Medplum:**
```typescript
runtimeVersion: 'vmcontext',
```

> **Important:** This setting must match your Medplum deployment. Using the wrong runtime will cause bots to fail.

### Step 4: Build Bots

```bash
npm run build:bots
```

This command:
1. Cleans previous builds (`rimraf dist`)
2. Runs linting (`eslint .`)
3. Compiles TypeScript bot code with `tsconfig-bots.json`
4. Generates `data/example/example-bots.json` containing bot bundles

### Step 5: Start Development Server

```bash
npm run dev
```

This command:
1. Builds bots (runs `npm run build:bots`)
2. Starts Vite dev server on `http://localhost:3000`
3. Enables hot-reload for frontend changes

### Step 6: Configure PhenoML Secrets

Once the app is running at `http://localhost:3000`:

1. **Sign in** with your Medplum credentials
2. **Navigate to Admin** → Click "Project" in sidebar
3. **Go to Secrets tab**
4. **Add two secrets:**

| Name | Value |
|------|-------|
| `PHENOML_EMAIL` | Your PhenoML email |
| `PHENOML_PASSWORD` | Your PhenoML password |

> Get your PhenoML credentials from [developer.pheno.ml](https://developer.pheno.ml)

### Step 7: (Optional) Configure Gemini API Key

For the clinical trials bot to provide AI-powered analysis:

1. In Medplum Admin → Secrets
2. Add secret:
   - Name: `GEMINI_API_KEY`
   - Value: Your Google Gemini API key

## Project Structure

```
medplum-provider-lang2fhir/
├── src/
│   ├── main.tsx                 # App entry point (Medplum config)
│   ├── App.tsx                  # React routing & UI shell
│   ├── bots/                    # Medplum bots (TypeScript)
│   │   ├── lang2fhir-create.ts  # Text → FHIR resources
│   │   ├── lang2fhir-document.ts # Documents → FHIR
│   │   ├── phenoml-cohort.ts    # Patient cohorts
│   │   ├── clinical-trials-bot.ts # Clinical trials search
│   │   └── phenoml-workflow.ts  # Workflow execution
│   ├── scripts/
│   │   └── deploy-bots.ts       # Bot deployment script
│   ├── pages/                   # React pages
│   ├── components/              # React components
│   └── utils/                   # Helper functions
├── data/
│   └── example/
│       └── example-bots.json    # Generated bot bundle
├── package.json
├── tsconfig.json                # Main TypeScript config
├── tsconfig-bots.json           # Bot TypeScript config (CommonJS)
└── vite.config.ts               # Vite build config
```

## Available npm Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Build bots + start dev server (http://localhost:3000) |
| `npm run build:bots` | Build and deploy bots |
| `npm run build` | Production build |
| `npm run lint` | Run ESLint |
| `npm run lint:fix` | Auto-fix linting issues |
| `npm run preview` | Preview production build |
| `npm run test` | Run tests with Vitest |
| `npm run test:coverage` | Run tests with coverage |

## Complete Startup Sequence

```bash
# 1. Verify prerequisites
node --version  # Should be ^20.19.0 or >=22.12.0
npm --version   # Should be ^10.9.3

# 2. Clone and install
git clone https://github.com/PhenoML/medplum-provider-lang2fhir.git
cd medplum-provider-lang2fhir
npm install

# 3. Configure main.tsx (if using local Medplum)
# Edit src/main.tsx, line 17: uncomment baseUrl

# 4. Configure deploy-bots.ts (if using local Medplum)
# Edit src/scripts/deploy-bots.ts, line 58: change to 'vmcontext'

# 5. Start the app
npm run dev

# 6. Open browser
open http://localhost:3000

# 7. Login with Medplum credentials

# 8. Set PhenoML secrets
# Admin → Project → Secrets → Add PHENOML_EMAIL and PHENOML_PASSWORD
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| **Bots not executing** | Verify `runtimeVersion` in `deploy-bots.ts` matches your Medplum deployment (`vmcontext` for local, `awslambda` for hosted) |
| **Authentication fails** | Check Medplum credentials and ensure project is created |
| **PhenoML API errors** | Verify `PHENOML_EMAIL` and `PHENOML_PASSWORD` secrets are set correctly in Medplum Admin |
| **Port 3000 in use** | Change port in `vite.config.ts` or kill process on port 3000 |
| **Build fails** | Run `npm run lint:fix` then try again |
| **Bots return undefined** | Check browser console for errors; verify PhenoML credentials are valid |
| **Document upload fails** | Ensure file is PDF, PNG, or JPEG; check file size limits |

## Environment Variables Reference

The application uses Medplum secrets (not environment variables) for configuration:

| Secret Name | Required | Description |
|-------------|----------|-------------|
| `PHENOML_EMAIL` | Yes | PhenoML account email |
| `PHENOML_PASSWORD` | Yes | PhenoML account password |
| `GEMINI_API_KEY` | No | Google Gemini API key (for clinical trials bot) |

## PhenoML Plan Requirements

| Plan | Usage |
|------|-------|
| **Experiment** | Non-production, testing, development |
| **Core** | Production, PHI data, clinical use |

> **Important:** Use the Core plan for any production or PHI-containing workloads.

## Next Steps

- Read [ARCHITECTURE.md](./ARCHITECTURE.md) to understand the system design
- Read [BOTS.md](./BOTS.md) to learn about the bot system
- Read [PHENOML_INTEGRATION.md](./PHENOML_INTEGRATION.md) for integration details
