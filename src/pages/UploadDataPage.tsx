import { Button, Container, Text, Box, LoadingOverlay, Alert } from '@mantine/core';
import { normalizeErrorString, MedplumClient } from '@medplum/core';
import { AttachmentButton, Document, useMedplum, useMedplumProfile, ResourceBadge, ResourceInput } from '@medplum/react';
import { useNavigate, useParams } from 'react-router-dom';
import { showNotification } from '@mantine/notifications';
import { Attachment, Bot, Bundle, Media, Questionnaire, QuestionnaireResponse, Resource, Patient, OperationOutcome } from '@medplum/fhirtypes';
import { IconCircleCheck, IconCircleOff, IconUpload, IconAlertCircle, IconRobot } from '@tabler/icons-react';
import { useCallback, useState } from 'react';
import exampleBotData from '../../data/example/example-bots.json';


export function UploadDataPage(): JSX.Element {
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const navigate = useNavigate();
  const { dataType } = useParams();
  
  const [pageDisabled, setPageDisabled] = useState<boolean>(false);
  const [error, setError] = useState<string>();
  const [selectedPatient, setSelectedPatient] = useState<Patient>();
  const [selectedQuestionnaire, setSelectedQuestionnaire] = useState<Questionnaire>();

  const handleFileUpload = useCallback(async (attachment: Attachment) => {
    setPageDisabled(true);
    try {
      showUploadNotification();
      showProcessingNotification();

      const generatedResource = await processDocument(
        medplum, 
        attachment, 
        dataType as string,
        selectedPatient,
        selectedQuestionnaire
      );

      showSuccessNotification('File processed successfully');
      navigate(`/${dataType}/${generatedResource.id}`);
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
      await deployBots(medplum, profile.meta.project);
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
            {dataType === 'bot' ? 'Deploy Lang2FHIR Bot' : `Upload ${dataType}`}
          </Text>
        </Box>
        {error && (
          <Alert icon={<IconAlertCircle size={16} />} color="red" mb="md">
            {error}
          </Alert>
        )}
        {dataType === 'bot' ? (
          <Button fullWidth onClick={handleBotUpload}>
            Deploy Bot
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
  const lang2fhirBot = await medplum.searchOne('Bot', { name: 'lang2fhir-document' });
  if (!lang2fhirBot?.id) {
    throw new Error('Bot "lang2fhir-document" not found or invalid');
  }

  // Create media resource
  const media = await medplum.createResource<Media>({
    resourceType: 'Media',
    status: 'completed',
    content: attachment,
  });

  // Process document
  const result = await medplum.executeBot(
    lang2fhirBot.id,
    { media, resourceType }
  ) as QuestionnaireResponse | Questionnaire;

  // Add references if QuestionnaireResponse
  if (result.resourceType === 'QuestionnaireResponse') {
    if (selectedPatient) {
      result.subject = {
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

// Bot deployment function
async function deployBots(medplum: MedplumClient, projectId: string): Promise<void> {
  const botEntries = (exampleBotData as Bundle).entry?.filter(
    e => (e.resource as Resource)?.resourceType === 'Bot'
  ) || [];

  for (const entry of botEntries) {
    const bot = entry.resource as Bot;
    if (!bot.name) {
      continue;
    }

    // Create or get existing bot
    let existingBot = await medplum.searchOne('Bot', { name: bot.name }) as Bot;
    if (!existingBot) {
      const createBotUrl = new URL(`admin/projects/${projectId}/bot`, medplum.getBaseUrl());
      existingBot = await medplum.post(createBotUrl, { name: bot.name });
    }

    // Deploy bot code
    const distUrl = bot.executableCode?.url;
    const distBinaryEntry = exampleBotData.entry.find(e => e.fullUrl === distUrl);
    if (distBinaryEntry?.resource?.data) {
      const code = atob(distBinaryEntry.resource.data);
      await medplum.post(medplum.fhirUrl('Bot', existingBot.id as string, '$deploy'), { code });
    }
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

