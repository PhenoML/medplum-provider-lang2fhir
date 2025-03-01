import { Button, Container, Text, Box, LoadingOverlay, Alert } from '@mantine/core';
import { normalizeErrorString, MedplumClient, getReferenceString, WithId } from '@medplum/core';
import { AttachmentButton, Document, useMedplum, useMedplumProfile, ResourceBadge, ResourceInput } from '@medplum/react';
import { useNavigate, useParams } from 'react-router-dom';
import { showNotification } from '@mantine/notifications';
import { Attachment, Bot, Bundle, Questionnaire, QuestionnaireResponse, Resource, Patient, OperationOutcome, DocumentReference,  BundleEntry } from '@medplum/fhirtypes';
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
      await deployBots(medplum, profile.meta?.project as string);
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
      const createBotUrl = new URL('admin/projects/' + (projectId as string) + '/bot', medplum.getBaseUrl());
      existingBot = (await medplum.post(createBotUrl, {
        name: botName,
      })) as WithId<Bot>;
    }

    botIds[botName] = existingBot.id as string;

    // Replace the Bot id placeholder in the bundle
    transactionString = transactionString
      .replaceAll(`$bot-${botName}-reference`, getReferenceString(existingBot))
      .replaceAll(`$bot-${botName}-id`, existingBot.id as string);
  }


  // Execute the transaction to upload / update the bot
  const transaction = JSON.parse(transactionString);
  await medplum.executeBatch(transaction);

  // Deploy the new bots
  for (const entry of botEntries) {
    const botName = (entry?.resource as Bot)?.name as string;
    const distUrl = (entry.resource as Bot).executableCode?.url;
    const distBinaryEntry = exampleBotData.entry.find((e) => e.fullUrl === distUrl);
    // Decode the base64 encoded code and deploy
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

