import { Stack, Text, Textarea, Button } from '@mantine/core';
import { showNotification } from '@mantine/notifications';
import { normalizeErrorString, normalizeOperationOutcome } from '@medplum/core';
import { OperationOutcome, Resource } from '@medplum/fhirtypes';
import { Document, OperationOutcomeAlert, useMedplum } from '@medplum/react';
import { IconCircleCheck, IconRobot } from '@tabler/icons-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

export function CreateCohortPage(): JSX.Element {
  const medplum = useMedplum();
  const [outcome, setOutcome] = useState<OperationOutcome | undefined>();
  const [inputText, setInputText] = useState<string>('');
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (): Promise<void> => {
    if (outcome) {
      setOutcome(undefined);
    }
    
    setLoading(true);
    try {
      // First, get the generated resource from the bot
      const phenomlCohortBot = await medplum.searchOne('Bot', { name: 'phenoml-cohort' });
      if (!phenomlCohortBot?.id) {
        throw new Error('Bot "phenoml-cohort" not found or invalid');
      }
      showNotification({
        icon: <IconRobot />,
        title: 'Creating cohort...',
        message: 'Analyzing language and generating cohort...',
      });

      const generatedResource = await medplum.executeBot(phenomlCohortBot.id, {
        text: inputText,
      }) as Resource;

      // Then create the resource in Medplum

      const createdResource = await medplum.createResource(generatedResource);
      showNotification({
        color: 'green',
        icon: <IconCircleCheck />,
        title: 'Success',
        message: 'Cohort created successfully',
      });
      // Navigate to the newly created resource
      navigate('/' + createdResource.resourceType + '/' + createdResource.id);
    } catch (err) {
      setOutcome(normalizeOperationOutcome(err));
      showNotification({
        color: 'red',
        message: normalizeErrorString(err),
        autoClose: false,
        styles: { description: { whiteSpace: 'pre-line' } },
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Document shadow="xs">
      <Stack>
        <Text fw={500}>New Cohort using Natural Language</Text>
        <Textarea
          label="Enter your description"
          placeholder={`Describe the cohort in natural language...`}
          minRows={4}
          value={inputText}
          onChange={(e) => setInputText(e.currentTarget.value)}
        />
        <Button 
          onClick={handleSubmit} 
          loading={loading}
          disabled={!inputText.trim()}
        >
          Create Cohort
        </Button>
        {outcome && <OperationOutcomeAlert outcome={outcome} />}
      </Stack>
    </Document>
  );
}
