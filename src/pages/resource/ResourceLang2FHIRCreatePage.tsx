import 'regenerator-runtime/runtime';
import { Stack, Text, Textarea, Button, Box, Space, ActionIcon, Group } from '@mantine/core';
import { showNotification } from '@mantine/notifications';
import { normalizeErrorString, normalizeOperationOutcome } from '@medplum/core';
import { OperationOutcome, Resource, ResourceType } from '@medplum/fhirtypes';
import { Document, Loading, OperationOutcomeAlert, useMedplum } from '@medplum/react';
import { useState, useEffect, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { usePatient } from '../../hooks/usePatient';
import { prependPatientPath } from '../patient/PatientPage.utils';
import { PhenoMLBranding } from '../../components/PhenoMLBranding';
import { IconSparkles, IconMicrophone, IconMicrophoneOff } from '@tabler/icons-react';
import { env, pipeline } from '@huggingface/transformers';


// Define which resource types don't require a patient
const PATIENT_INDEPENDENT_RESOURCES = ['PlanDefinition', 'Questionnaire', 'ResearchStudy'] as const;
type PatientIndependentResource = typeof PATIENT_INDEPENDENT_RESOURCES[number];

env.allowLocalModels = false;
env.useBrowserCache = true;

export function ResourceLang2FHIRCreatePage(): JSX.Element {
  const medplum = useMedplum();
  const [outcome, setOutcome] = useState<OperationOutcome | undefined>();
  const [inputText, setInputText] = useState<string>('');
  const navigate = useNavigate();
  const { patientId, resourceType } = useParams() as { patientId: string | undefined; resourceType: ResourceType };
  const [loading, setLoading] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isModelLoading, setIsModelLoading] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const whisperRef = useRef<any>(null);
  const streamRef = useRef<MediaStream | null>(null);


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

  // Initialize Whisper model
  useEffect(() => {
    initWhisper().catch(console.error);
  }, []);


  const initWhisper = async (): Promise<void> => {
    try {
      setIsModelLoading(true);
      whisperRef.current = await pipeline(
        'automatic-speech-recognition',
        'Xenova/whisper-tiny.en'
      );
      console.log('Whisper initialized');
    } catch (error) {
      console.error('Failed to initialize Whisper:', error);
    } finally {
      setIsModelLoading(false);
    }
  };

  // Start recording
  const startRecording = async (): Promise<void> => {
    if (!whisperRef.current) {
      await initWhisper();
    }

    try {
      chunksRef.current = [];
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream; // Store stream for cleanup
      const mediaRecorder = new MediaRecorder(stream);
      
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunksRef.current.push(e.data);
        }
      };

      mediaRecorder.onstop = () => {
        const audioBlob = new Blob(chunksRef.current, { type: 'audio/wav' });
        transcribeAudio(audioBlob).catch(console.error);
      };

      mediaRecorderRef.current = mediaRecorder;
      mediaRecorder.start(1000); // Collect data every second
      setIsRecording(true);
    } catch (error) {
      console.error('Error starting recording:', error);
    }
  };

  // Stop recording
  const stopRecording = (): void => {
    if (mediaRecorderRef.current) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
    
    // Stop all tracks in the stream
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
  };

  // Transcribe audio
  const transcribeAudio = async (audioBlob: Blob): Promise<void> => {
    let audioContext: AudioContext | undefined;
    
    try {
      setIsProcessing(true);
      const arrayBuffer = await audioBlob.arrayBuffer();
      audioContext = new AudioContext({ sampleRate: 16000 });
      const audioData = await audioContext.decodeAudioData(arrayBuffer);
      const audioArray = audioData.getChannelData(0);
      const result = await whisperRef.current(audioArray);
      
      setInputText(prev => {
        const newText = prev + (prev.length > 0 ? ' ' : '') + result.text;
        console.log('Updated text will be:', newText);
        return newText;
      });
    } catch (error) {
      console.error('Transcription error:', error);
    } finally {
      setIsProcessing(false);
      await audioContext?.close();
    }
  };

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
      
      navigate(navigationPath);
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
