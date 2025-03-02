import 'regenerator-runtime/runtime';
import { Stack, Text, Textarea, Button, Box, Space, ActionIcon, Group } from '@mantine/core';
import { showNotification } from '@mantine/notifications';
import { normalizeErrorString, normalizeOperationOutcome } from '@medplum/core';
import { OperationOutcome, Resource, ResourceType } from '@medplum/fhirtypes';
import { Document, Loading, OperationOutcomeAlert, useMedplum } from '@medplum/react';
import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { usePatient } from '../../hooks/usePatient';
import { prependPatientPath } from '../patient/PatientPage.utils';
import { PhenoMLBranding } from '../../components/PhenoMLBranding';
import { IconSparkles, IconMicrophone, IconMicrophoneOff } from '@tabler/icons-react';
import SpeechRecognition, { useSpeechRecognition } from 'react-speech-recognition';

// Define which resource types don't require a patient
const PATIENT_INDEPENDENT_RESOURCES = ['PlanDefinition', 'Questionnaire'] as const;
type PatientIndependentResource = typeof PATIENT_INDEPENDENT_RESOURCES[number];

export function ResourceLang2FHIRCreatePage(): JSX.Element {
  const medplum = useMedplum();
  const [outcome, setOutcome] = useState<OperationOutcome | undefined>();
  const [inputText, setInputText] = useState<string>('');
  const navigate = useNavigate();
  const { patientId, resourceType } = useParams() as { patientId: string | undefined; resourceType: ResourceType };
  const [loading, setLoading] = useState(false);

  // Only fetch patient if the resource type requires it AND we have a patientId
  const requiresPatient = !PATIENT_INDEPENDENT_RESOURCES.includes(resourceType as PatientIndependentResource);
  const patient = usePatient({ 
    ignoreMissingPatientId: !requiresPatient || !patientId,
    setOutcome: requiresPatient ? setOutcome : undefined // Only set outcome if we actually need a patient
  });
  const [loadingPatient, setLoadingPatient] = useState(Boolean(patientId && requiresPatient));

  const {
    listening,
    browserSupportsSpeechRecognition,
    isMicrophoneAvailable,
    finalTranscript,
    interimTranscript,
    resetTranscript
  } = useSpeechRecognition({
    clearTranscriptOnListen: false
  });

  useEffect(() => {
    if (patient) {
      setLoadingPatient(false);
    }
  }, [patient]);

  useEffect(() => {
  }, [listening, isMicrophoneAvailable, interimTranscript, finalTranscript]);

  useEffect(() => {
    if (finalTranscript) {
      setInputText((prev) => {
        const space = prev.endsWith(' ') ? '' : ' ';
        const newText = prev + space + finalTranscript;
        return newText;
      });
      resetTranscript();
    }
  }, [finalTranscript, resetTranscript]);

  useEffect(() => {
    console.log('Speech recognition supported:', browserSupportsSpeechRecognition);
  }, [browserSupportsSpeechRecognition]);

  const handleSubmit = async (): Promise<void> => {
    if (outcome) {
      setOutcome(undefined);
    }
    
    if (listening) {
      await stopListening();
    }
    
    setLoading(true);
    try {
      const lang2fhirCreateBot = await medplum.searchOne('Bot', { name: 'lang2fhir-create' });
      if (!lang2fhirCreateBot?.id) {
        throw new Error('Bot "lang2fhir-create" not found or invalid');
      }

      // Only include patient in bot input if resource type requires it
      const botInput = {
        text: inputText,
        resourceType,
        ...(requiresPatient && patient && { patient }),
      };

      const generatedResource = await medplum.executeBot(
        lang2fhirCreateBot.id, 
        botInput
      ) as Resource;

      const createdResource = await medplum.createResource(generatedResource);
      
      // Navigate appropriately based on whether resource is patient-dependent
      const navigationPath = requiresPatient && patient
        ? prependPatientPath(patient, `/${createdResource.resourceType}/${createdResource.id}`)
        : `/${createdResource.resourceType}/${createdResource.id}`;
      
      navigate(navigationPath);
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

  const startListening = async (): Promise<void> => {
    try {
      await SpeechRecognition.startListening({ 
        continuous: true,
        language: 'en-US',
        interimResults: true
      });
    } catch (error) {
      showNotification({
        color: 'red',
        message: 'Failed to start speech recognition',
        autoClose: 3000
      });
      console.error('Speech recognition error:', error);
    }
  };

  const stopListening = async (): Promise<void> => {
    await SpeechRecognition.stopListening();
  };

  const toggleListening = async (): Promise<void> => {
    if (!browserSupportsSpeechRecognition) {
      showNotification({
        color: 'yellow',
        message: 'Speech recognition is not supported in this browser',
        autoClose: 3000
      });
      return;
    }

    if (listening) {
      await stopListening();
    } else {
      await startListening();
    }
  };

  const displayText = inputText + (interimTranscript ? ` ${interimTranscript}` : '');

  if (loadingPatient) {
    return <Loading />;
  }

  if (!browserSupportsSpeechRecognition) {
    return (
      <Document shadow="xs">
        <Stack>
          <Text fw={500}>Create a new {resourceType} using Natural Language</Text>
          <Textarea
            label="Enter your description"
            placeholder={`Describe the ${resourceType.toLowerCase()} in natural language...`}
            minRows={4}
            value={displayText}
            onChange={(e) => setInputText(e.currentTarget.value)}
          />
          <Button 
            onClick={handleSubmit} 
            loading={loading}
            disabled={!displayText.trim()}
          >
            <IconSparkles size={14} style={{ marginRight: 8 }} />
            Create {resourceType}
          </Button>
          {outcome && <OperationOutcomeAlert outcome={outcome} />}
          <Space h="xl" />
          <Box ta="center">
            <PhenoMLBranding />
          </Box>
        </Stack>
      </Document>
    );
  }

  return (
    <Document shadow="xs">
      <Stack>
        <Text fw={500}>Create a new {resourceType} using Natural Language</Text>
        <Group align="flex-start">
          <Textarea
            style={{ flex: 1 }}
            label="Enter your description"
            placeholder={`Describe the ${resourceType.toLowerCase()} in natural language...`}
            minRows={4}
            value={displayText}
            onChange={(e) => setInputText(e.currentTarget.value)}
          />
          <ActionIcon 
            size="lg"
            variant="light"
            color={listening ? "red" : "blue"}
            onClick={toggleListening}
            mt={25}
            title={listening ? "Stop recording" : "Start recording"}
          >
            {listening ? <IconMicrophoneOff size={20} /> : <IconMicrophone size={20} />}
          </ActionIcon>
        </Group>
        <Button 
          onClick={handleSubmit} 
          loading={loading}
          disabled={!displayText.trim()}
        >
          <IconSparkles size={14} style={{ marginRight: 8 }} />
          Create {resourceType}
        </Button>
        {outcome && <OperationOutcomeAlert outcome={outcome} />}
        <Space h="xl" />
        <Box ta="center">
          <PhenoMLBranding />
        </Box>
      </Stack>
    </Document>
  );
}
