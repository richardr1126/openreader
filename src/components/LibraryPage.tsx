import { HomeContent } from '@/components/HomeContent';
import { RateLimitBanner } from '@/components/auth/RateLimitBanner';
import type { UploadRequest } from '@/components/doclist/useDocumentListController';

/** The library page, optionally opening the upload dialog as the /app/upload link asks. */
export function LibraryPage({ uploadTo }: { uploadTo?: UploadRequest } = {}) {
  return (
    <div className="flex flex-col h-full w-full">
      <section className="flex-1 min-h-0 flex flex-col overflow-hidden">
        <RateLimitBanner className="mx-2 mt-2" />
        <div className="flex-1 min-h-0">
          <HomeContent uploadTo={uploadTo} />
        </div>
      </section>
    </div>
  );
}
