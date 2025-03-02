import { Alert, Anchor, Stack} from '@mantine/core';
import { Questionnaire, QuestionnaireResponse, DocumentReference } from '@medplum/fhirtypes';
import {  useResource } from '@medplum/react';
import { IconAlertCircle } from '@tabler/icons-react';
import { useParams } from 'react-router-dom';

export function SourceDocumentPage(): JSX.Element | null {
  const { resourceType, id } = useParams();
  const resource = useResource<Questionnaire | QuestionnaireResponse>({ reference: resourceType + '/' + id });
  const document = useResource<DocumentReference>({ 
    reference: resource?.extension?.find(
      ext => ext.url === 'https://example.org/fhir/StructureDefinition/source-document'
    )?.valueReference?.reference || '' 
  });

  if (!resource) {
    return null;
  }

  const docId = document?.id;

  const contentUrl = document?.content?.[0]?.attachment?.url;

  const contentType = document?.content?.[0]?.attachment?.contentType;
  
  const showDocAlert = (resourceType === 'Questionnaire' || resourceType === 'QuestionnaireResponse') && docId;


  return (
    <Stack>
      {showDocAlert && document && (
        <Alert icon={<IconAlertCircle size={16} />} mb="xl">
          Source Document:
          <br />
          <Anchor href={`/DocumentReference/${docId}`}>{`/DocumentReference/${docId}`}</Anchor>
          {contentUrl && (
            <object
              data={contentUrl}
              type={contentType}
              style={{ width: '100%', height: '100%' }}
            >
              <p><a href={contentUrl}>View document</a></p>
            </object>
          )}
        </Alert>
      )}
    </Stack>
  );
}
