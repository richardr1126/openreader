import { Header } from '@/components/Header';
import { HomeContent } from '@/components/HomeContent';
import { SettingsModal } from '@/components/SettingsModal';
import { UserMenu } from '@/components/auth/UserMenu';
import { RateLimitBanner } from '@/components/auth/RateLimitBanner';

export default function Home() {
  return (
    <div className="flex flex-col h-full w-full">
      <Header
        title={
          <div className="flex items-center gap-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/icon.svg" alt="" className="w-5 h-5" aria-hidden="true" />
            <h1 className="text-xs sm:text-sm font-bold truncate text-foreground tracking-tight">OpenReader</h1>
          </div>
        }
        right={
          <div className="flex items-center gap-2">
            <SettingsModal />
            <UserMenu />
          </div>
        }
      />
      <section className="flex-1 px-4 pb-8 pt-4 overflow-auto">
        <div className="max-w-7xl mx-auto">
          <RateLimitBanner className="mb-6" />
          <HomeContent />
        </div>
      </section>
    </div>
  );
}
