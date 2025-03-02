import { ProfileResource, getReferenceString } from '@medplum/core';
import {
  AppShell,
  Loading,
  Logo,
  NotificationIcon,
  useMedplum,
  useMedplumNavigate,
  useMedplumProfile,
} from '@medplum/react';
import {
  IconChecklist,
  IconClipboardCheck,
  IconClipboardText,
  IconForms,
  IconMail,
  IconRobot,
  IconUser,
  IconUsersGroup,
} from '@tabler/icons-react';
import { Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { ResourceCreatePage } from './pages/resource/ResourceCreatePage';
import { HomePage } from './pages/HomePage';
import { OnboardingPage } from './pages/OnboardingPage';
import { SearchPage } from './pages/SearchPage';
import { SignInPage } from './pages/SignInPage';
import { EditTab } from './pages/patient/EditTab';
import { EncounterChart } from './pages/encounter/EncounterChart';
import { EncounterModal } from './pages/encounter/EncounterModal';
import { PatientPage } from './pages/patient/PatientPage';
import { PatientSearchPage } from './pages/patient/PatientSearchPage';
import { TimelineTab } from './pages/patient/TimelineTab';
import { ResourceDetailPage } from './pages/resource/ResourceDetailPage';
import { ResourceEditPage } from './pages/resource/ResourceEditPage';
import { ResourceHistoryPage } from './pages/resource/ResourceHistoryPage';
import { QuestionnairePreviewPage } from './pages/resource/QuestionnairePreviewPage';
import { ResourcePage } from './pages/resource/ResourcePage';
import { CommunicationTab } from './pages/patient/CommunicationTab';
import { TaskTab } from './pages/patient/TaskTab';
import { UploadDataPage } from './pages/UploadDataPage';
import { SourceDocumentPage } from './pages/resource/SourceDocumentPage';
import { ResourceLang2FHIRCreatePage } from './pages/resource/ResourceLang2FHIRCreatePage';
import { CreateCohortPage } from './pages/resource/CreateCohortPage';
import { TaskDetails } from './pages/tasks/TaskDetails';


export function App(): JSX.Element | null {
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const navigate = useMedplumNavigate();

  if (medplum.isLoading()) {
    return null;
  }

  return (
    <AppShell
      logo={<Logo size={24} />}
      menus={[
        {
          title: 'Charts',
          links: [{ icon: <IconUser />, label: 'Patients', href: '/' }],
        },
        {
          title: 'Bots',
          links: [
            { icon: <IconRobot />, label: 'Upload Bot', href: '/upload/bot' },
          ],
        },
        {
          title: 'Upload Forms',
          links: [
            { icon: <IconClipboardText />, label: 'Upload Questionnaire', href: '/upload/Questionnaire' },
            { icon: <IconForms />, label: 'Upload Questionnaire Response', href: '/upload/QuestionnaireResponse' },
          ],
        },   
        {
          title: 'Create Resources',
          links: [
            { icon: <IconUsersGroup />, label: 'Create Cohort', href: '/create-cohort' },
            { icon: <IconChecklist />, label: 'Create Plan Definition', href: '/PlanDefinition/new' },
          ],
        },     
      ]}
      resourceTypeSearchDisabled={true}
      notifications={
        profile && (
          <>
            <NotificationIcon
              label="Mail"
              resourceType="Communication"
              countCriteria={`recipient=${getReferenceString(profile as ProfileResource)}&status:not=completed&_summary=count`}
              subscriptionCriteria={`Communication?recipient=${getReferenceString(profile as ProfileResource)}`}
              iconComponent={<IconMail />}
              onClick={() =>
                navigate(
                  `/Communication?recipient=${getReferenceString(profile as ProfileResource)}&status:not=completed&_fields=sender,recipient,subject,status,_lastUpdated`
                )
              }
            />
            <NotificationIcon
              label="Tasks"
              resourceType="Task"
              countCriteria={`owner=${getReferenceString(profile as ProfileResource)}&status:not=completed&_summary=count`}
              subscriptionCriteria={`Task?owner=${getReferenceString(profile as ProfileResource)}`}
              iconComponent={<IconClipboardCheck />}
              onClick={() =>
                navigate(
                  `/Task?owner=${getReferenceString(profile as ProfileResource)}&status:not=completed&_fields=subject,code,description,status,_lastUpdated`
                )
              }
            />
          </>
        )
      }
    >
      <Suspense fallback={<Loading />}>
        <Routes>
          {profile ? (
            <>
              <Route path="/" element={<HomePage />} />
              <Route path="/Patient/:patientId" element={<PatientPage />}>
              <Route path="Encounter/new" element={<EncounterModal />} />
                <Route path="Encounter/:encounterId" element={<EncounterChart />}>
                  <Route path="Task/:taskId" element={<TaskDetails />} />
                </Route>
                <Route path="edit" element={<EditTab />} />
                <Route path="communication" element={<CommunicationTab />} />
                <Route path="communication/:id" element={<CommunicationTab />} />
                <Route path="task/:id/*" element={<TaskTab />} />
                <Route path="timeline" element={<TimelineTab />} />
                <Route path=":resourceType" element={<PatientSearchPage />} />
                <Route path=":resourceType/new" element={<ResourceCreatePage />} />
                <Route path=":resourceType/new/lang2fhir" element={<ResourceLang2FHIRCreatePage />} />
                <Route path=":resourceType/:id" element={<ResourcePage />}>
                  <Route path="" element={<ResourceDetailPage />} />
                  <Route path="edit" element={<ResourceEditPage />} />
                  <Route path="history" element={<ResourceHistoryPage />} />
                  <Route path="preview" element={<QuestionnairePreviewPage />} />
                  <Route path="source" element={<SourceDocumentPage />} />
                </Route>
                <Route path="" element={<TimelineTab />} />
              </Route>
              <Route path="Task/:id/*" element={<TaskTab />} />
              <Route path="/onboarding" element={<OnboardingPage />} />
              <Route path="/signin" element={<SignInPage />} />
              <Route path="/:resourceType" element={<SearchPage />} />
              <Route path="/:resourceType/new" element={<ResourceCreatePage />} />
              <Route path=":resourceType/new/lang2fhir" element={<ResourceLang2FHIRCreatePage />} />
              <Route path="/:resourceType/:id" element={<ResourcePage />}>
                <Route path="" element={<ResourceDetailPage />} />
                <Route path="edit" element={<ResourceEditPage />} />
                <Route path="history" element={<ResourceHistoryPage />} />
                <Route path="preview" element={<QuestionnairePreviewPage />} />
                <Route path="source" element={<SourceDocumentPage />} />
              </Route>
              <Route path="/upload/:dataType" element={<UploadDataPage />} />
              <Route path="create-cohort" element={<CreateCohortPage />} />


            </>
          ) : (
            <>
              <Route path="/signin" element={<SignInPage />} />
              <Route path="*" element={<Navigate to="/signin" replace />} />
            </>
          )}
        </Routes>
      </Suspense>
    </AppShell>
  );
}
