// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Button, Container, Text, Box, LoadingOverlay, Alert, Space, Stack, Divider } from '@mantine/core';
import type { MedplumClient } from '@medplum/core';
import { normalizeErrorString, getReferenceString } from '@medplum/core';
import { AttachmentButton, AttachmentDisplay, Document, useMedplum, useMedplumProfile, ResourceBadge, ResourceInput } from '@medplum/react';
import { useNavigate, useParams } from 'react-router';
import { showNotification } from '@mantine/notifications';
import type { Attachment, Bot, Bundle, Extension, Questionnaire, QuestionnaireResponse, Resource, Patient, OperationOutcome, DocumentReference,  BundleEntry } from '@medplum/fhirtypes';
import { IconCircleCheck, IconCircleOff, IconUpload, IconAlertCircle, IconRobot } from '@tabler/icons-react';
import type { JSX } from 'react';
import { useCallback, useState } from 'react';
import exampleBotData from '../../data/example/example-bots.json';
import { PhenoMLBranding } from '../components/PhenoMLBranding';


export function UploadDataPage(): JSX.Element {
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const navigate = useNavigate();
  const { dataType } = useParams();
  
  const [pageDisabled, setPageDisabled] = useState<boolean>(false);
  const [error, setError] = useState<string>();
  const [selectedPatient, setSelectedPatient] = useState<Patient>();
  const [selectedQuestionnaire, setSelectedQuestionnaire] = useState<Questionnaire>();
  const [referralResult, setReferralResult] = useState<ReferralResult>();

  const handleFileUpload = useCallback(async (attachment: Attachment) => {
    setPageDisabled(true);
    try {
      showUploadNotification();
      showProcessingNotification();

      // Referrals produce a transaction Bundle of many resource types rather than a single
      // resource, so they use a distinct path that persists the Bundle and shows a results panel.
      if (dataType === 'referral') {
        const result = await processReferral(medplum, attachment);
        setReferralResult(result);
        showSuccessNotification('Referral processed successfully');
        return;
      }

      const generatedResource = await processDocument(
        medplum,
        attachment,
        dataType as string,
        selectedPatient,
        selectedQuestionnaire
      );

      showSuccessNotification('File processed successfully');
      const navResult = navigate(`/${dataType}/${generatedResource.id}`);
      if (navResult) {
        navResult.catch(console.error);
      }
    } catch (error) {
      console.error('Upload process error:', error);
      setError(normalizeErrorString(error));
      showErrorNotification(error as Error);
    } finally {
      setPageDisabled(false);
    }
  }, [medplum, navigate, dataType, selectedPatient, selectedQuestionnaire]);

  const handleBotUpload = useCallback(async () => {
    if (!profile?.meta?.project) {
      return;
    }
    
    setPageDisabled(true);
    try {
      await deployBots(medplum, profile.meta?.project);
      showSuccessNotification('Deployed Example Bots');
    } catch (error) {
      setError(normalizeErrorString(error));
      showErrorNotification(error as Error);
    } finally {
      setPageDisabled(false);
    }
  }, [medplum, profile]);

  return (
    <Document>
      <LoadingOverlay visible={pageDisabled} />
      <Container size="sm">
        <Box ta="center" mb="md">
          <Text size="lg">
            {dataType === 'bot' ? 'Deploy Bots' : `Upload ${dataType}`}
          </Text>
        </Box>
        {error && (
          <Alert icon={<IconAlertCircle size={16} />} color="red" mb="md">
            {error}
          </Alert>
        )}
        {dataType === 'bot' ? (
          <Button fullWidth onClick={handleBotUpload}>
            <IconRobot size={14} style={{ marginRight: 8 }} />
            Deploy Bots
          </Button>
        ) : (
          <>
            {dataType === 'QuestionnaireResponse' && (
              <>
                <Box mb="md">
                  <ResourceInput
                    resourceType="Patient"
                    name="patient"
                    placeholder="Search for patient..."
                    onChange={(patient) => setSelectedPatient(patient as Patient)}
                  />
                  {selectedPatient && <ResourceBadge value={selectedPatient} />}
                </Box>
                <Box mb="md">
                  <ResourceInput
                    resourceType="Questionnaire"
                    name="questionnaire"
                    placeholder="Search for questionnaire..."
                    onChange={(questionnaire) => setSelectedQuestionnaire(questionnaire as Questionnaire)}
                  />
                  {selectedQuestionnaire && <ResourceBadge value={selectedQuestionnaire} />}
                </Box>
              </>
            )}
            <AttachmentButton 
              onUpload={handleFileUpload} 
              onUploadError={showErrorNotification}
              disabled={dataType === 'QuestionnaireResponse' && !selectedPatient}
            >
              {(props) => (
                <Button fullWidth {...props}>
                  <IconUpload size={14} style={{ marginRight: 8 }} />
                  Choose Document
                </Button>
              )}
            </AttachmentButton>
          </>
        )}
        {dataType === 'referral' && referralResult && (
          <>
            <Space h="xl" />
            <Divider label="Extracted resources" labelPosition="center" mb="md" />
            {referralResult.patientRef && (
              <Button
                fullWidth
                mb="md"
                onClick={() => {
                  const navResult = navigate(`/${referralResult.patientRef}`);
                  if (navResult) {
                    navResult.catch(console.error);
                  }
                }}
              >
                View Patient Chart
              </Button>
            )}
            <Stack gap="xs" mb="md">
              {referralResult.created.map((item) => (
                <ResourceBadge key={item.reference} value={{ reference: item.reference }} link />
              ))}
            </Stack>
            <Divider label="Source document" labelPosition="center" mb="md" />
            <AttachmentDisplay value={referralResult.attachment} />
          </>
        )}
        {(dataType === 'QuestionnaireResponse' || dataType === 'Questionnaire') && (
          <>
            <Space h="xl" />
            <Box ta="center">
              <PhenoMLBranding />
            </Box>
          </>
        )}
        {dataType === 'referral' && (
          <>
            <Space h="xl" />
            <Box ta="center">
              <PhenoMLBranding />
            </Box>
          </>
        )}
      </Container>
    </Document>
  );
}

// Document processing functions
async function processDocument(
  medplum: MedplumClient, 
  attachment: Attachment,
  resourceType: string,
  selectedPatient?: Patient,
  selectedQuestionnaire?: Questionnaire
): Promise<Resource> {
  // Find bot
  const lang2fhirDocumentBot = await medplum.searchOne('Bot', { name: 'lang2fhir-document' });
  if (!lang2fhirDocumentBot?.id) {
    throw new Error('Bot "lang2fhir-document" not found or invalid');
  }

  // Create document reference resource
  const docref = await medplum.createResource<DocumentReference>({
    resourceType: 'DocumentReference',
    status: 'current',
    content: [{
      attachment: attachment,
    }],
  });

  // Process document
  const result = await medplum.executeBot(
    lang2fhirDocumentBot.id,
    { docref, resourceType }
  ) as QuestionnaireResponse | Questionnaire;

  // Add Media reference as extension
  result.extension = [{
    url: 'https://example.org/fhir/StructureDefinition/source-document',
    valueReference: {
      reference: `DocumentReference/${docref.id}`,
      display: 'Source Document'
    }
  }];

  if (result.resourceType === 'QuestionnaireResponse') {
    if (selectedPatient) {
      result.subject = {
        reference: `Patient/${selectedPatient.id}`,
        display: `Patient/${selectedPatient.id}`
      };
      result.source = {
        reference: `Patient/${selectedPatient.id}`,
        display: `Patient/${selectedPatient.id}`
      };
    }
    if (selectedQuestionnaire) {
      result.questionnaire = `Questionnaire/${selectedQuestionnaire.id}`;
    }
  }

  const resource = await medplum.createResource(result);
  return resource;
}

interface ReferralResult {
  patientRef?: string;
  created: { reference: string; display: string }[];
  attachment: Attachment;
}

// Referral processing: a PDF referral is converted into a FHIR transaction Bundle of many
// resource types (Patient, Conditions, etc.). The original PDF is retained as a
// DocumentReference, the Bundle is persisted, and each created resource is linked back to the
// source document via the shared source-document extension.
async function processReferral(medplum: MedplumClient, attachment: Attachment): Promise<ReferralResult> {
  const referralBot = await medplum.searchOne('Bot', { name: 'referral-intake' });
  if (!referralBot?.id) {
    throw new Error('Bot "referral-intake" not found or invalid');
  }

  // Retain the uploaded PDF as a DocumentReference (backed by a Binary).
  const docref = await medplum.createResource<DocumentReference>({
    resourceType: 'DocumentReference',
    status: 'current',
    content: [
      {
        attachment: attachment,
      },
    ],
  });

  // The bot returns a FHIR transaction Bundle of extracted resources.
  const bundle = (await medplum.executeBot(referralBot.id, { docref })) as Bundle;

  // Link every extracted resource back to the source document.
  const sourceExtension: Extension = {
    url: 'https://example.org/fhir/StructureDefinition/source-document',
    valueReference: {
      reference: `DocumentReference/${docref.id}`,
      display: 'Source Document',
    },
  };
  for (const entry of bundle.entry ?? []) {
    const resource = entry.resource as { extension?: Extension[] } | undefined;
    if (resource) {
      resource.extension = [...(resource.extension ?? []), sourceExtension];
    }
  }

  // Persist the Bundle.
  const batchResult = await medplum.executeBatch(bundle);
  const created = (batchResult.entry ?? [])
    .map((e) => e.response?.location)
    .filter((loc): loc is string => Boolean(loc))
    .map((loc) => {
      const reference = loc.split('/').slice(0, 2).join('/');
      return { reference, display: reference };
    });

  // Link the source document to the created Patient so the PDF appears on the patient chart.
  const patientRef = created.find((c) => c.reference.startsWith('Patient/'))?.reference;
  if (patientRef && docref.id) {
    await medplum.updateResource<DocumentReference>({
      ...docref,
      subject: { reference: patientRef },
    });
  }

  return { patientRef, created, attachment };
}


async function deployBots(medplum: MedplumClient, projectId: string): Promise<void> {

  let transactionString = JSON.stringify(exampleBotData);
  const botEntries: BundleEntry[] =
    (exampleBotData as Bundle).entry?.filter((e) => e.resource?.resourceType === 'Bot') || [];
  const botNames = botEntries.map((e) => (e.resource as Bot).name ?? '');
  const botIds: Record<string, string> = {};

  for (const botName of botNames) {
    let existingBot = await medplum.searchOne('Bot', { name: botName });
    // Create a new Bot if it doesn't already exist
    if (!existingBot) {
      const createBotUrl = new URL('admin/projects/' + (projectId) + '/bot', medplum.getBaseUrl());
      existingBot = await medplum.post(createBotUrl, {
        name: botName,
      });
    }

    if (!existingBot?.id) {
      throw new Error(`Failed to find or create Bot: ${botName}`);
    }

    botIds[botName] = existingBot.id;

    transactionString = transactionString
      .replaceAll(`$bot-${botName}-reference`, getReferenceString(existingBot))
      .replaceAll(`$bot-${botName}-id`, existingBot.id);
  }

  const transaction = JSON.parse(transactionString);
  await medplum.executeBatch(transaction);

  for (const entry of botEntries) {
    const botName = (entry?.resource as Bot)?.name as string;
    const distUrl = (entry.resource as Bot).executableCode?.url;
    const distBinaryEntry = exampleBotData.entry.find((e) => e.fullUrl === distUrl);
    const code = atob(distBinaryEntry?.resource.data as string);
    await medplum.post(medplum.fhirUrl('Bot', botIds[botName], '$deploy'), { code });
  }

}

// Helper notification functions
const showUploadNotification = (): void => {
  showNotification({
    icon: <IconUpload />,
    title: 'Uploading document...',
    message: 'Creating attachment ...',
  });
};

const showProcessingNotification = (): void => {
  showNotification({
    icon: <IconRobot />,
    title: 'Processing document...',
    message: 'Extracting data from document to generate resource...',
  });
};

const showSuccessNotification = (message: string): void => {
  showNotification({
    color: 'green',
    icon: <IconCircleCheck />,
    title: 'Success',
    message,
  });
};

const showErrorNotification = (error: Error | OperationOutcome): void => {
  let message: string;
  if (error instanceof Error) {
    message = error.message;
  } else {
    // Handle OperationOutcome
    message = error.issue?.[0]?.diagnostics || 'Unknown error';
  }
  
  showNotification({
    color: 'red',
    icon: <IconCircleOff />,
    title: 'Error',
    message,
  });
};

