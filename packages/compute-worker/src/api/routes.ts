import type { ComputeWorkerRouteContext } from './route-context';
import { createPlaybackSessionController } from './playback/session-controller';
import { createPlaybackSessionReadModel } from './playback/session-read-model';
import {
  registerAccountExportRetentionRoute,
  registerAccountExportRoutes,
} from './routes/account-exports';
import { registerCleanupRoutes } from './routes/cleanup';
import {
  registerDocumentJobRoutes,
  registerDocumentResolutionRoutes,
} from './routes/document-jobs';
import { registerHealthRoutes } from './routes/health';
import { registerOperationRoutes } from './routes/operations';
import { registerPlaybackAudioRoutes } from './routes/playback/audio';
import {
  registerPlaybackExportJobRoutes,
  registerPlaybackExportRetentionRoute,
  registerPlaybackExportRoutes,
} from './routes/playback/exports';
import {
  registerPlaybackJobRoutes,
  registerPlaybackSessionRoutes,
} from './routes/playback/sessions';

export type { ComputeWorkerRouteDeps } from './route-context';

/** Composition root for the compute worker's domain-owned route registrars. */
export function registerComputeWorkerRoutes(context: ComputeWorkerRouteContext): void {
  const playbackReadModel = createPlaybackSessionReadModel(context);
  const playbackController = createPlaybackSessionController(context, playbackReadModel);

  registerHealthRoutes(context);
  registerPlaybackExportRoutes(context);
  registerPlaybackSessionRoutes(context, playbackReadModel, playbackController);
  registerCleanupRoutes(context, playbackReadModel);
  registerAccountExportRetentionRoute(context);
  registerPlaybackExportRetentionRoute(context);
  registerPlaybackAudioRoutes(context, playbackReadModel, playbackController);
  registerDocumentJobRoutes(context);
  registerPlaybackJobRoutes(context, playbackController);
  registerAccountExportRoutes(context);
  registerPlaybackExportJobRoutes(context);
  registerDocumentResolutionRoutes(context);
  registerOperationRoutes(context);
}
