// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Stack, Text, Button, Box, Space } from '@mantine/core';
import { showNotification } from '@mantine/notifications';
import { normalizeErrorString, normalizeOperationOutcome } from '@medplum/core';
import type { OperationOutcome, Resource, ResourceType } from '@medplum/fhirtypes';
import { Document, Loading, OperationOutcomeAlert, useMedplum } from '@medplum/react';
import type { JSX } from 'react';
import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router';
import { usePatient } from '../../hooks/usePatient';
import { ScribeTextarea } from '../../components/ScribeTextarea';
import { prependPatientPath } from '../patient/PatientPage.utils';
import { PhenoMLBranding } from '../../components/PhenoMLBranding';
import { IconSparkles } from '@tabler/icons-react';


// Define which resource types don't require a patient
const PATIENT_INDEPENDENT_RESOURCES = ['PlanDefinition', 'Questionnaire', 'ResearchStudy'] as const;
type PatientIndependentResource = typeof PATIENT_INDEPENDENT_RESOURCES[number];

export function ResourceLang2FHIRCreatePage(): JSX.Element {
  const medplum = useMedplum();
  const [outcome, setOutcome] = useState<OperationOutcome | undefined>();
  const [inputText, setInputText] = useState('');
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
        
        <ScribeTextarea
          label="Enter your description"
          placeholder={`Describe the ${resourceType.toLowerCase()} in natural language...`}
          minRows={4}
          value={inputText}
          onChange={setInputText}
        />

        <Button
          onClick={handleSubmit}
          loading={loading}
          disabled={!inputText.trim()}
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
