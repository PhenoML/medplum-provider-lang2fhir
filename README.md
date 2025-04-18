<h1 align="center">AI Powered Charting Demo</h1>
<p align="center">
<a href="https://github.com/medplum/medplum-hello-world/blob/main/LICENSE.txt">
    <img src="https://img.shields.io/badge/license-Apache-blue.svg" />
  </a>
</p>

This example app is a fork of the [Medplum Charting Demo](https://github.com/medplum/medplum-provider) with PhenoML's [Lang2FHIR](https://developer.pheno.ml/reference/post_lang2fhir-create) integration showcasing an AI powered charting experience.

### :robot: AI use cases powered by Lang2FHIR in this demo application

- Upload pdfs and images and convert them to FHIR Questionnaire and QuestionnaireResponse resources
- Describe plan definitions, medication requests, and care plans in natural language and have them converted to FHIR resources
- AI medical scribe in the browser (using [Hugging Face's Transformers.js](https://huggingface.co/docs/transformers.js/en/index) with whisper-tiny model) to convert audio to FHIR resources
- Describe a patient cohort in language and generate a FHIR Group resource

### :video_camera: Demo Video

[![YouTube](http://i.ytimg.com/vi/q0bikQTw36c/hqdefault.jpg)](https://www.youtube.com/watch?v=q0bikQTw36c)

### :gear: Getting Started

PhenoML Auth Token:
Follow instructions here to get started with PhenoML's Lang2FHIR, you'll need to create an account and get your credentials(free trial and no credit card required to sign up for an Experiment plan): [PhenoML Developer Docs](https://developer.pheno.ml/docs/getting-started), [PhenoML Plans](https://www.phenoml.com/plans)

This app uses PhenoML's Lang2FHIR API, which requires the auth token from your PhenoML account. Authentication is handled by bots, but the necessary secrets must be set up in your Medplum project. Importantly, PhenoML's Experiment and Develop plans are for non-production/non PHI use, you'll need to be on a Launch plan to use lang2FHIR for production/PHI usage.

Your credentials can be accessed in your PhenoML account by signing in to the [PhenoMLDeveloper Portal](https://developer.pheno.ml) with your email to generate a one-time link. Navigate to [Getting Started](https://developer.pheno.ml/reference/getting-started#/) and copy the credentials populated. If your credentials aren't populated and you have signed up for a plan please contact support: [support@phenoml.com](mailto:support@phenoml.com)

Once you have copied your credentials you'll need to update them as secrets in your Medplum project. This can be done in the Medplum App. Navigate to admin page by clicking on Project in the Admin section of the sidebar. In the Secrets tab, click Add Secret and create secrets for your PhenoML email and and password with names of PHENOML_EMAIL and PHENOML_PASSWORD. 

### :exclamation::exclamation: **IMPORTANT**: Medplum Pre-Requisites
**This demo application will NOT work unless you already have the Medplum stack set up** either locally or using Medplum's hosted services.

If you want to run this app locally with locally hosted Medplum you will need to follow the instructions here including all pre-requisites for Medplum: [here](https://www.medplum.com/docs/contributing/run-the-stack)

Medplum: 
If you haven't already done so, follow the instructions in [this tutorial](https://www.medplum.com/docs/tutorials/register) to register a Medplum project to store your data.

[Fork](https://github.com/PhenoML/medplum-provider-lang2fhir/fork) and clone the repo.

Next, install the dependencies.

```bash
npm install
```

Then, build the bots. Of note, if you are running this app locally with a locally hosted Medplum server you'll need to modify the context of the bots to use the `vmcontext` instead of `awslambda`. To do this, modify `runtimeVersion: 'awslambda'` to be `runtimeVersion: 'vmcontext'` in the  `deploy-bots.ts` script and then build the bots. 

```bash
npm run build:bots
```

Then, run the app

```bash
npm run dev
```

This app should run on `http://localhost:3000/`

### About PhenoML
:sparkles: [PhenoML](https://phenoml.com/) is a developer platform for healthcare AI. 

PhenoML's Lang2FHIR API converts natural language to FHIR resources. It's a powerful tool for healthcare AI, and it's used in this demo app to convert natural language to FHIR resources. For benchmarking results on lang2FHIR API performance and accuracy, see [PhenoML's Lang2FHIR API Benchmark](https://github.com/PhenoML/phenoml_benchmarks).

- Read our [docs](https://developer.pheno.ml)
- Check out our [Youtube channel](https://www.youtube.com/@phenomldev)
- Come hang on [Discord](https://discord.gg/QgxDjNBxdV)

### About Medplum

[Medplum](https://www.medplum.com/) is an open-source, API-first EHR. Medplum makes it easy to build healthcare apps quickly with less code.

Medplum supports self-hosting and provides a [hosted service](https://app.medplum.com/). Medplum Hello World uses the hosted service as a backend.

- Read the [documentation](https://www.medplum.com/docs)
- Browse the [react component library](https://storybook.medplum.com/)
- Join the [Discord](https://discord.gg/medplum)
