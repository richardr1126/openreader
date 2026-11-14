import type {
  MaintenanceJobRequest,
  MaintenanceJobResult,
  MaintenanceProgress,
  AccountExportJobRequest,
  AccountExportJobResult,
  AccountExportProgress,
  EmailDeliveryJobRequest,
  EmailDeliveryJobResult,
  ModelDownloadJobRequest,
  ModelDownloadJobResult,
  DocumentConversionJobRequest,
  DocumentConversionJobResult,
  DocumentConversionProgress,
  DocumentPreviewJobRequest,
  DocumentPreviewJobResult,
  PdfLayoutJobRequest,
  PdfLayoutJobResult,
  TtsPlaybackExportArtifactRequest,
  TtsPlaybackExportArtifactResult,
  TtsPlaybackExportProgress,
  TtsPlaybackJobRequest,
  TtsPlaybackJobResult,
  TtsPlaybackPlanJobRequest,
  TtsPlaybackPlanJobResult,
  TtsPlaybackProgress,
} from '../operations/contracts';
import type { JobAttempt, JobExecution } from '../operations/types';
import { createAccountExportHandler } from './account-export';
import type { PdfLayoutJobContext } from './context';
import { createDocumentConversionHandler } from './document-conversion';
import { createDocumentPreviewHandler } from './document-preview';
import { createPdfLayoutHandler, type PdfLayoutExecution } from './pdf-layout';
import { createTtsPlaybackExportHandler } from './playback/export-job';
import { createTtsPlaybackHandler } from './playback/playback-job';
import { createTtsPlaybackPlanHandler } from './playback/plan-job';
import { deliverEmail } from './email-delivery';
import { runModelDownload } from './model-download';
import type { ModelDownloadProgress } from '../inference/model-download';

export interface JobHandlers {
  runMaintenance?(payload: MaintenanceJobRequest, queueWaitMs: number, hooks?: { onProgress?: (progress: MaintenanceProgress) => Promise<void> }): Promise<MaintenanceJobResult>;
  runPdfLayout(payload: PdfLayoutJobRequest, queueWaitMs: number, hooks: PdfLayoutExecution): Promise<PdfLayoutJobResult>;
  runTtsPlayback(payload: TtsPlaybackJobRequest, queueWaitMs: number, hooks?: { onProgress?: (progress: TtsPlaybackProgress) => Promise<void> }): Promise<TtsPlaybackJobResult>;
  runTtsPlaybackPlan(payload: TtsPlaybackPlanJobRequest, queueWaitMs: number, attempt?: JobAttempt): Promise<TtsPlaybackPlanJobResult>;
  runTtsPlaybackExportArtifact(payload: TtsPlaybackExportArtifactRequest, queueWaitMs: number, hooks?: JobExecution<TtsPlaybackExportProgress>): Promise<TtsPlaybackExportArtifactResult>;
  runDocumentPreview(payload: DocumentPreviewJobRequest, queueWaitMs: number, attempt?: JobAttempt): Promise<DocumentPreviewJobResult>;
  runDocumentConversion(payload: DocumentConversionJobRequest, queueWaitMs: number, hooks?: JobExecution<DocumentConversionProgress>): Promise<DocumentConversionJobResult>;
  runAccountExport(payload: AccountExportJobRequest, queueWaitMs: number, hooks?: JobExecution<AccountExportProgress>): Promise<AccountExportJobResult>;
  runEmailDelivery?(payload: EmailDeliveryJobRequest): Promise<EmailDeliveryJobResult>;
  runModelDownload?(payload: ModelDownloadJobRequest, queueWaitMs: number, hooks?: { onProgress?: (progress: ModelDownloadProgress) => Promise<void> }): Promise<ModelDownloadJobResult>;
}

export function createJobHandlers(input: PdfLayoutJobContext): JobHandlers {
  return {
    runPdfLayout: createPdfLayoutHandler(input),
    runTtsPlayback: createTtsPlaybackHandler(input),
    runTtsPlaybackPlan: createTtsPlaybackPlanHandler(input),
    runTtsPlaybackExportArtifact: createTtsPlaybackExportHandler(input),
    runDocumentPreview: createDocumentPreviewHandler(input),
    runDocumentConversion: createDocumentConversionHandler(input),
    runAccountExport: createAccountExportHandler(input),
    runEmailDelivery: deliverEmail,
    runModelDownload,
  };
}
