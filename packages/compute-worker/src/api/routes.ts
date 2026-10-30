import type { ComputeWorkerRouteContext } from './route-context';
import { createPlaybackSessionController } from './playback/session-controller';
import { createPlaybackSessionReadModel } from './playback/session-read-model';
import {
  registerAccountExportRoutes,
} from './routes/account-exports';
import { registerCleanupRoutes } from './routes/cleanup';
import {
  registerDocumentJobRoutes,
  registerDocumentResolutionRoutes,
} from './routes/document-jobs';
import { registerHealthRoutes } from './routes/health';
import { registerOperationRoutes } from './routes/operations';
import { registerEmailDeliveryRoutes } from './routes/email-deliveries';
import { registerModelRoutes } from './routes/models';
import { registerMaintenanceRoutes } from './routes/maintenance';
import { registerPlaybackAudioRoutes } from './routes/playback/audio';
import {
  registerPlaybackExportJobRoutes,
  registerPlaybackExportRoutes,
  registerPlaybackExportSessionRoutes,
} from './routes/playback/exports';
import {
  registerPlaybackJobRoutes,
  registerPlaybackSessionRoutes,
} from './routes/playback/sessions';
import { registerVoicePreviewRoutes } from './routes/playback/voice-preview';

export type { ComputeWorkerRouteDeps } from './route-context';

/** Composition root for the compute worker's domain-owned route registrars. */
export function registerComputeWorkerRoutes(context: ComputeWorkerRouteContext) {
  const playbackReadModel = createPlaybackSessionReadModel({
    storage: context.storage,
    playbackStorage: context.playbackStorage,
    logger: context.app.log,
  });
  const playbackController = createPlaybackSessionController(context, playbackReadModel);

  registerHealthRoutes(context);
  registerPlaybackExportRoutes(context);
  registerPlaybackSessionRoutes(context, playbackReadModel, playbackController);
  registerPlaybackExportSessionRoutes(context, playbackReadModel);
  const cleanup = registerCleanupRoutes(context, playbackReadModel);
  registerPlaybackAudioRoutes(context, playbackReadModel, playbackController);
  registerDocumentJobRoutes(context);
  registerPlaybackJobRoutes(context, playbackController);
  registerVoicePreviewRoutes(context);
  registerAccountExportRoutes(context);
  registerEmailDeliveryRoutes(context);
  registerModelRoutes(context);
  registerMaintenanceRoutes(context);
  registerPlaybackExportJobRoutes(context);
  registerDocumentResolutionRoutes(context);
  registerOperationRoutes(context);
  return cleanup;
}
