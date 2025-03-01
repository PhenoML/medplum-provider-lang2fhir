import { Stack, Text, Textarea, Button } from '@mantine/core';
import { showNotification } from '@mantine/notifications';
import { normalizeErrorString, normalizeOperationOutcome } from '@medplum/core';
import { OperationOutcome, Resource, ResourceType } from '@medplum/fhirtypes';
import { Document, Loading, OperationOutcomeAlert, useMedplum } from '@medplum/react';
import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { usePatient } from '../../hooks/usePatient';
import { prependPatientPath } from '../patient/PatientPage.utils';

export function ResourceLang2FHIRCreatePage(): JSX.Element {
  const medplum = useMedplum();
  const [outcome, setOutcome] = useState<OperationOutcome | undefined>();
  const [inputText, setInputText] = useState<string>('');
  const patient = usePatient({ ignoreMissingPatientId: true, setOutcome });
  const navigate = useNavigate();
  const { patientId, resourceType } = useParams() as { patientId: string | undefined; resourceType: ResourceType };
  const [loadingPatient, setLoadingPatient] = useState(Boolean(patientId));
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (patient) {
      setLoadingPatient(false);
    }
  }, [patient]);

  const handleSubmit = async (): Promise<void> => {
    if (outcome) {
      setOutcome(undefined);
    }
    
    setLoading(true);
    try {
      // First, get the generated resource from the bot
      const lang2fhirCreateBot = await medplum.searchOne('Bot', { name: 'lang2fhir-create' });
      if (!lang2fhirCreateBot?.id) {
        throw new Error('Bot "lang2fhir-create" not found or invalid');
      }

      const generatedResource = await medplum.executeBot(lang2fhirCreateBot.id, {
        text: inputText,
        resourceType: resourceType,
        patient: patient,
      }) as Resource;

      // Then create the resource in Medplum
      const createdResource = await medplum.createResource(generatedResource);
      
      // Navigate to the newly created resource
      navigate(prependPatientPath(patient, '/' + createdResource.resourceType + '/' + createdResource.id));
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

  if (loadingPatient) {
    return <Loading />;
  }

  return (
    <Document shadow="xs">
      <Stack>
        <Text fw={500}>New {resourceType} using Natural Language</Text>
        <Textarea
          label="Enter your description"
          placeholder={`Describe the ${resourceType.toLowerCase()} in natural language...`}
          minRows={4}
          value={inputText}
          onChange={(e) => setInputText(e.currentTarget.value)}
        />
        <Button 
          onClick={handleSubmit} 
          loading={loading}
          disabled={!inputText.trim()}
        >
          Create {resourceType}
        </Button>
        {outcome && <OperationOutcomeAlert outcome={outcome} />}
      </Stack>
    </Document>
  );
}
