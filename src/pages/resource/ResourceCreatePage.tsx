import { Stack, Text, Group, Button } from '@mantine/core';
import { showNotification } from '@mantine/notifications';
import { createReference, normalizeErrorString, normalizeOperationOutcome } from '@medplum/core';
import { OperationOutcome, Patient, Resource, ResourceType } from '@medplum/fhirtypes';
import { Document, Loading, useMedplum } from '@medplum/react';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { IconSparkles } from '@tabler/icons-react';
import { usePatient } from '../../hooks/usePatient';
import { prependPatientPath } from '../patient/PatientPage.utils';
import { ResourceFormWithRequiredProfile } from '../../components/ResourceFormWithRequiredProfile';
import { RESOURCE_PROFILE_URLS } from './utils';

const PatientReferencesElements: Partial<Record<ResourceType, string[]>> = {
  Task: ['for'],
  MedicationRequest: ['subject'],
  ServiceRequest: ['subject'],
  Device: ['patient'],
  DiagnosticReport: ['subject'],
  DocumentReference: ['subject'],
  Appointment: ['participant.actor'],
  CarePlan: ['subject'],
};

function getDefaultValue(resourceType: ResourceType, patient: Patient | undefined): Partial<Resource> {
  const dv = { resourceType } as Partial<Resource>;
  const refKeys = PatientReferencesElements[resourceType];
  if (patient && refKeys) {
    for (const key of refKeys) {
      const keyParts = key.split('.');
      if (keyParts.length === 1) {
        (dv as any)[key] = createReference(patient);
      } else if (keyParts.length === 2) {
        const [first, second] = keyParts;
        (dv as any)[first] = [{ [second]: createReference(patient) }];
      } else {
        throw new Error('Can only process keys with one or two parts');
      }
    }
  }

  return dv;
}

// Define supported resource types
const LANG2FHIR_SUPPORTED_TYPES = [
  'QuestionnaireResponse',
  'Observation',
  'Procedure',
  'Condition',
  'MedicationRequest',
  'CarePlan'
] as const;

type Lang2FHIRSupportedType = typeof LANG2FHIR_SUPPORTED_TYPES[number];

function isLang2FHIRSupported(resourceType: string): resourceType is Lang2FHIRSupportedType {
  return LANG2FHIR_SUPPORTED_TYPES.includes(resourceType as Lang2FHIRSupportedType);
}

export function ResourceCreatePage(): JSX.Element {
  const medplum = useMedplum();
  const [outcome, setOutcome] = useState<OperationOutcome | undefined>();
  const patient = usePatient({ ignoreMissingPatientId: true, setOutcome });
  const navigate = useNavigate();
  const { patientId, resourceType } = useParams() as { patientId: string | undefined; resourceType: ResourceType };
  const [loadingPatient, setLoadingPatient] = useState(Boolean(patientId));
  const [defaultValue, setDefaultValue] = useState<Partial<Resource>>(() => getDefaultValue(resourceType, patient));
  const profileUrl = resourceType && RESOURCE_PROFILE_URLS[resourceType];

  useEffect(() => {
    if (patient) {
      setDefaultValue(getDefaultValue(resourceType, patient));
    }
    setLoadingPatient(false);
  }, [patient, resourceType]);

  const handleSubmit = (newResource: Resource): void => {
    if (outcome) {
      setOutcome(undefined);
    }
    medplum
      .createResource(newResource)
      .then((result) => navigate(prependPatientPath(patient, '/' + result.resourceType + '/' + result.id)))
      .catch((err) => {
        if (setOutcome) {
          setOutcome(normalizeOperationOutcome(err));
        }
        showNotification({
          color: 'red',
          message: normalizeErrorString(err),
          autoClose: false,
          styles: { description: { whiteSpace: 'pre-line' } },
        });
      });
  };

  const handleLang2FHIRClick = (): void => {
    const basePath = patientId ? `/Patient/${patientId}/${resourceType}` : `/${resourceType}`;
    navigate(`${basePath}/new/lang2fhir`);
  };

  if (loadingPatient) {
    return <Loading />;
  }

  return (
    <Document shadow="xs">
      <Stack>
        <Group justify="space-between">
          <Text fw={500}>New {resourceType}</Text>
          {isLang2FHIRSupported(resourceType) && (
            <Button 
              variant="light" 
              leftSection={<IconSparkles size={16} />}
              onClick={handleLang2FHIRClick}
            >
              Create with Natural Language
            </Button>
          )}
        </Group>
        <ResourceFormWithRequiredProfile
          defaultValue={defaultValue}
          onSubmit={handleSubmit}
          outcome={outcome}
          profileUrl={profileUrl}
        />
      </Stack>
    </Document>
  );
}
