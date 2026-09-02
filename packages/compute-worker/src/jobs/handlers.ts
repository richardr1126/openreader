import type {
  AccountExportJobRequest,
  AccountExportJobResult,
  AccountExportProgress,
  DocumentConversionJobRequest,
  DocumentConversionJobResult,
  DocumentConversionProgress,
  DocumentPreviewJobRequest,
  DocumentPreviewJobResult,
  PdfLayoutJobRequest,
  PdfLayoutJobResult,
  PdfLayoutProgress,
  TtsPlaybackExportArtifactRequest,
  TtsPlaybackExportArtifactResult,
  TtsPlaybackExportProgress,
  TtsPlaybackJobRequest,
  TtsPlaybackJobResult,
  TtsPlaybackPlanJobRequest,
  TtsPlaybackPlanJobResult,
  TtsPlaybackProgress,
} from '../operations/contracts';
import { createAccountExportHandler } from './account-export';
import type { JobHandlerContext } from './context';
import { createDocumentConversionHandler } from './document-conversion';
import { createDocumentPreviewHandler } from './document-preview';
import { createPdfLayoutHandler } from './pdf-layout';
import { createTtsPlaybackExportHandler } from './playback/export-job';
import { createTtsPlaybackHandler } from './playback/playback-job';
import { createTtsPlaybackPlanHandler } from './playback/plan-job';

export interface JobHandlers {
  runPdfLayout(payload: PdfLayoutJobRequest, queueWaitMs: number, hooks?: { onProgress?: (progress: PdfLayoutProgress) => Promise<void> }): Promise<PdfLayoutJobResult>;
  runTtsPlayback(payload: TtsPlaybackJobRequest, queueWaitMs: number, hooks?: { onProgress?: (progress: TtsPlaybackProgress) => Promise<void> }): Promise<TtsPlaybackJobResult>;
  runTtsPlaybackPlan(payload: TtsPlaybackPlanJobRequest, queueWaitMs: number): Promise<TtsPlaybackPlanJobResult>;
  runTtsPlaybackExportArtifact(payload: TtsPlaybackExportArtifactRequest, queueWaitMs: number, hooks?: { onProgress?: (progress: TtsPlaybackExportProgress) => Promise<void> }): Promise<TtsPlaybackExportArtifactResult>;
  runDocumentPreview(payload: DocumentPreviewJobRequest, queueWaitMs: number): Promise<DocumentPreviewJobResult>;
  runDocumentConversion(payload: DocumentConversionJobRequest, queueWaitMs: number, hooks?: { onProgress?: (progress: DocumentConversionProgress) => Promise<void> }): Promise<DocumentConversionJobResult>;
  runAccountExport(payload: AccountExportJobRequest, queueWaitMs: number, hooks?: { onProgress?: (progress: AccountExportProgress) => Promise<void> }): Promise<AccountExportJobResult>;
}

export function createJobHandlers(input: JobHandlerContext): JobHandlers {
  return {
    runPdfLayout: createPdfLayoutHandler(input),
    runTtsPlayback: createTtsPlaybackHandler(input),
    runTtsPlaybackPlan: createTtsPlaybackPlanHandler(input),
    runTtsPlaybackExportArtifact: createTtsPlaybackExportHandler(input),
    runDocumentPreview: createDocumentPreviewHandler(input),
    runDocumentConversion: createDocumentConversionHandler(input),
    runAccountExport: createAccountExportHandler(input),
  };
}
