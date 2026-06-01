import { Fragment } from 'react';
import { Transition } from '@headlessui/react';
import { ProgressCard } from './ProgressCard';

interface ProgressPopupProps {
  isOpen: boolean;
  progress: number;
  estimatedTimeRemaining?: string;
  onCancel: () => void;
  statusMessage?: string;
  operationType?: 'sync' | 'load' | 'library' | 'audiobook';
  cancelText?: string;
  onClick?: () => void;
  currentChapter?: string;
  totalChapters?: number;
  completedChapters?: number;
}

export function ProgressPopup({
  isOpen,
  progress,
  estimatedTimeRemaining,
  onCancel,
  statusMessage,
  operationType,
  cancelText = 'Cancel',
  onClick,
  currentChapter,
  completedChapters
}: ProgressPopupProps) {
  return (
    <Transition
      show={isOpen}
      as={Fragment}
      enter="transform transition ease-standard duration-slow"
      enterFrom="opacity-0 -translate-y-4"
      enterTo="opacity-100 translate-y-0"
      leave="transform transition ease-standard duration-base"
      leaveFrom="opacity-100 translate-y-0"
      leaveTo="opacity-0 -translate-y-4"
    >
      <div className="fixed inset-x-0 top-2 z-[60] pointer-events-none px-4">
        <div className="w-full max-w-md mx-auto">
          <div 
            className={`pointer-events-auto shadow-elev-3 ${
              onClick ? 'cursor-pointer' : ''
            }`}
            onClick={onClick}
          >
            <ProgressCard
              progress={progress}
              estimatedTimeRemaining={estimatedTimeRemaining}
              onCancel={(e) => {
                e?.stopPropagation();
                onCancel();
              }}
              operationType={operationType}
              cancelText={cancelText}
              currentChapter={currentChapter}
              completedChapters={completedChapters}
              statusMessage={statusMessage}
            />
          </div>
        </div>
      </div>
    </Transition>
  );
}
