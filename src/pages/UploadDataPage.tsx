import { Button, Container, Text, Box, LoadingOverlay, Alert } from '@mantine/core';
import { getReferenceString, normalizeErrorString, WithId } from '@medplum/core';
import { AttachmentButton, Document, useMedplum, useMedplumProfile, ResourceBadge, ResourceInput } from '@medplum/react';
import { useNavigate, useParams } from 'react-router-dom';

import { showNotification } from '@mantine/notifications';
import { Attachment, Bot, Bundle, BundleEntry, Media, Questionnaire, QuestionnaireResponse, Resource, Patient } from '@medplum/fhirtypes';
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

  const handleFileUpload = useCallback(
    async (attachment: Attachment) => {
      setPageDisabled(true); // Add this line at the start
      try {

        // First check if the bot exists
        const lang2fhirBot = await medplum.searchOne('Bot', { name: 'lang2fhir-document' }).catch(error => {
          const msg = `Failed to find bot: ${normalizeErrorString(error)}`;
          throw new Error(msg);
        });

        if (!lang2fhirBot) {
          throw new Error('Bot "lang2fhir-document" not found. Please deploy the bot first.');
        }

        showNotification({
          icon: <IconUpload />,
          title: 'Uploading document...',
          message: 'Creating attachment ...',
        });

        const media = await medplum.createResource<Media>({
          resourceType: 'Media',
          status: 'completed',
          content: attachment,
        });

        const botId = lang2fhirBot.id;
        if (!botId) {
          throw new Error('Bot ID is missing');
        }

        showNotification({
          icon: <IconRobot />,
          title: 'Processing document...',
          message: 'Extracting data from document to generate resource...',
        });
        const resourceType = dataType;
        type resultType = Questionnaire | QuestionnaireResponse;
        const result = await medplum.executeBot(
          botId,
          {media,
          resourceType}
        ).catch(error => {
          let errorMessage = normalizeErrorString(error);
          if (error.response) {
            try {
              const responseData = error.response.data;
              if (typeof responseData === 'string') {
                errorMessage += '\nResponse: ' + responseData;
              } else {
                errorMessage += '\nResponse: ' + JSON.stringify(responseData, null, 2);
              }
            } catch (e) {
              console.error('Error parsing error response:', e);
            }
          }
          throw new Error(`Bot execution failed: ${errorMessage}`);
        }) as resultType;

        if (result.resourceType === 'QuestionnaireResponse' && selectedPatient) {
          result.subject = {
            reference: `Patient/${selectedPatient.id}`,
            display: `Patient/${selectedPatient.id}`
          };
        }

        const generatedResource = await medplum.createResource<resultType>(result).catch(error => {
          const errorMessage = error instanceof Error ? error.message : normalizeErrorString(error);
          throw new Error(`Error creating ${dataType}: ${errorMessage}`);
        });

        showNotification({
          color: 'green',
          icon: <IconCircleCheck />,
          title: 'Success',
          message: 'File processed successfully',
        });


        // Navigate to the created resource
        navigate(`/${dataType}/${generatedResource.id}`);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : normalizeErrorString(error);
        console.error('Upload process error:', error);
        setError(errorMessage);
        showNotification({
          color: 'red',
          icon: <IconCircleOff />,
          title: 'Error',
          message: errorMessage,
        });
      } finally {
        setPageDisabled(false);
      }
    },
    [medplum, navigate, dataType, selectedPatient]
  );

  const handleUploadError = useCallback((error: any) => {
    setPageDisabled(false);
    showNotification({
      color: 'red',
      icon: <IconCircleOff />,
      title: 'Upload Error',
      message: normalizeErrorString(error),
    });
  }, []);


  async function handleBotUpload(): Promise<void> {
    if (!profile) {
      return;
    }
    let transactionString = JSON.stringify(exampleBotData);
    const botEntries: BundleEntry[] =
      (exampleBotData as Bundle).entry?.filter((e: any) => (e.resource as Resource)?.resourceType === 'Bot') || [];
    const botNames = botEntries.map((e) => (e.resource as Bot).name ?? '');
    const botIds: Record<string, string> = {};
  
    for (const botName of botNames) {
      let existingBot = await medplum.searchOne('Bot', { name: botName });
      // Create a new Bot if it doesn't already exist
      if (!existingBot) {
        const projectId = profile.meta?.project;
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
      const distBinaryEntry = exampleBotData.entry.find((e: any) => e.fullUrl === distUrl);
      // Decode the base64 encoded code and deploy
      const code = atob(distBinaryEntry?.resource.data as string);
      await medplum.post(medplum.fhirUrl('Bot', botIds[botName], '$deploy'), { code });
    }
  
    showNotification({
      icon: <IconCircleCheck />,
      title: 'Success',
      message: 'Deployed Example Bots',
    });
  }


  // Render UI based on upload type
  return (
    <Document>
      <LoadingOverlay visible={pageDisabled} />
      <Container size="sm">
        <Box ta="center" mb="md">
          <Text size="lg">
            {dataType === 'bot'
              ? 'Deploy Lang2FHIR Bot'
              : `Upload ${dataType}`}
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
              <Box mb="md">
                <ResourceInput
                  resourceType="Patient"
                  name="patient"
                  placeholder="Search for patient..."
                  onChange={(patient) => setSelectedPatient(patient as Patient)}
                />
                {selectedPatient && (
                  <ResourceBadge value={selectedPatient} />
                )}
              </Box>
            )}
            <AttachmentButton 
              onUpload={handleFileUpload} 
              onUploadError={handleUploadError}
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