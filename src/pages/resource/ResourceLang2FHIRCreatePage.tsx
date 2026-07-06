// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Stack, Text, Textarea, Button, Box, Space, ActionIcon, Group } from '@mantine/core';
import { showNotification } from '@mantine/notifications';
import { normalizeErrorString, normalizeOperationOutcome } from '@medplum/core';
import type { OperationOutcome, Resource, ResourceType } from '@medplum/fhirtypes';
import { Document, Loading, OperationOutcomeAlert, useMedplum } from '@medplum/react';
import type { JSX } from 'react';
import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router';
import { usePatient } from '../../hooks/usePatient';
import { useScribeTranscription } from '../../hooks/useScribeTranscription';
import { prependPatientPath } from '../patient/PatientPage.utils';
import { PhenoMLBranding } from '../../components/PhenoMLBranding';
import { IconSparkles, IconMicrophone, IconMicrophoneOff } from '@tabler/icons-react';


// Define which resource types don't require a patient
const PATIENT_INDEPENDENT_RESOURCES = ['PlanDefinition', 'Questionnaire', 'ResearchStudy'] as const;
type PatientIndependentResource = typeof PATIENT_INDEPENDENT_RESOURCES[number];

export function ResourceLang2FHIRCreatePage(): JSX.Element {
  const medplum = useMedplum();
  const [outcome, setOutcome] = useState<OperationOutcome | undefined>();
  const {
    transcript: inputText,
    setTranscript: setInputText,
    isRecording,
    isModelLoading,
    isProcessing,
    startRecording,
    stopRecording,
  } = useScribeTranscription();
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

  useEffect(() => {
    if (patient) {
      setLoadingPatient(false);
    }
  }, [patient]);

  const handleSubmit = async (): Promise<void> => {
    try {
      if (outcome) {
        setOutcome(undefined);
      }
      
      if (isRecording) {
        stopRecording();
      }
      
      setLoading(true);
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
      
      // Navigate based on whether resource is patient-dependent
      const navigationPath = requiresPatient && patient
        ? prependPatientPath(patient, `/${createdResource.resourceType}/${createdResource.id}`)
        : `/${createdResource.resourceType}/${createdResource.id}`;
      
      const navResult = navigate(navigationPath);
      if (navResult) {
        navResult.catch(console.error);
      }
    } catch (error) {
      setOutcome(normalizeOperationOutcome(error));
      showNotification({
        color: 'red',
        message: normalizeErrorString(error),
        autoClose: false,
        styles: { description: { whiteSpace: 'pre-line' } },
      });
    } finally {
      setLoading(false);
    }
  };

  if (loadingPatient) {
    return <Loading />;
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
            value={inputText}
            onChange={(e) => setInputText(e.currentTarget.value)}
          />
          <ActionIcon 
            size="lg"
            variant="light"
            color={isRecording ? "red" : "blue"}
            onClick={isRecording ? stopRecording : startRecording}
            mt={25}
            disabled={isModelLoading || isProcessing}
            title={isRecording ? "Stop recording" : "Start recording"}
          >
            {isRecording ? <IconMicrophoneOff size={20} /> : <IconMicrophone size={20} />}
          </ActionIcon>
        </Group>

        {(isModelLoading || isProcessing) && (
          <Text size="sm" c="dimmed">
            {isModelLoading ? "Loading speech recognition model..." : "Processing audio..."}
          </Text>
        )}

        <Button 
          onClick={handleSubmit} 
          loading={loading}
          disabled={!inputText.trim() || isRecording || isProcessing}
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
