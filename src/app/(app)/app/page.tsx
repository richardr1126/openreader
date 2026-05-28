import { HomeContent } from '@/components/HomeContent';
import { RateLimitBanner } from '@/components/auth/RateLimitBanner';

export default function Home() {
  return (
    <div className="flex flex-col h-full w-full">
      <section className="flex-1 min-h-0 flex flex-col overflow-hidden">
        <RateLimitBanner className="mx-2 mt-2" />
        <div className="flex-1 min-h-0">
          <HomeContent />
        </div>
      </section>
    </div>
  );
}
