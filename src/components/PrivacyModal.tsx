'use client';

import { Fragment, useState, useEffect, useCallback } from 'react';
import {
  Dialog,
  DialogPanel,
  DialogTitle,
  Transition,
  TransitionChild,
  Button,
} from '@headlessui/react';
import { updateAppConfig, getAppConfig } from '@/lib/dexie';

interface PrivacyModalProps {
  onAccept?: () => void;
  authEnabled?: boolean;
}

function PrivacyModalBody({ origin }: { origin: string }) {
  return (
    <div className="mt-4 space-y-4 text-sm text-foreground/90">
      <div className="rounded-lg border border-offbase bg-offbase/40 p-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted">Service Operator</div>
        <div className="mt-1">
          This instance is hosted at <span className="font-bold">{origin || 'this server'}</span>.
        </div>
      </div>

      <p className="leading-relaxed">
        We value your privacy. This application uses strictly necessary cookies for authentication
        and anonymous analytics to improve performance. Your documents are stored securely and encrypted at rest.
      </p>

      <p className="leading-relaxed">
        For full details on data collection, processing, and your rights, please review our complete Privacy Policy.
      </p>
    </div>
  );
}

export function PrivacyModal({ onAccept }: PrivacyModalProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [origin, setOrigin] = useState('');
  const [agreed, setAgreed] = useState(false);

  const checkPrivacyAccepted = useCallback(async () => {
    const config = await getAppConfig();
    if (!config?.privacyAccepted) {
      setIsOpen(true);
    }
  }, []);

  useEffect(() => {
    checkPrivacyAccepted().catch((err) => {
      console.error('Privacy acceptance check failed:', err);
    });
  }, [checkPrivacyAccepted]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    setOrigin(window.location.origin);
  }, []);

  const handleAccept = async () => {
    await updateAppConfig({ privacyAccepted: true });
    setIsOpen(false);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('openreader:privacyAccepted'));
    }
    onAccept?.();
  };

  return (
    <Transition appear show={isOpen} as={Fragment}>
      <Dialog as="div" className="relative z-[60]" onClose={() => { }}>
        <TransitionChild
          as={Fragment}
          enter="ease-out duration-300"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="ease-in duration-200"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <div className="fixed inset-0 overlay-dim backdrop-blur-sm" />
        </TransitionChild>

        <div className="fixed inset-0 overflow-y-auto">
          <div className="flex min-h-full items-start justify-center p-4 pt-6 text-center sm:items-center sm:pt-4">
            <TransitionChild
              as={Fragment}
              enter="ease-out duration-300"
              enterFrom="opacity-0 scale-95"
              enterTo="opacity-100 scale-100"
              leave="ease-in duration-200"
              leaveFrom="opacity-100 scale-100"
              leaveTo="opacity-0 scale-95"
            >
              <DialogPanel className="w-full max-w-md transform rounded-2xl bg-base p-6 text-left align-middle shadow-xl transition-all">
                <DialogTitle
                  as="h3"
                  className="text-lg font-semibold leading-6 text-foreground"
                >
                  Privacy & Data Usage
                </DialogTitle>

                <PrivacyModalBody origin={origin} />

                <div className="mt-6 space-y-4">
                  <div className="flex items-start gap-3 rounded-lg border border-offbase p-3 bg-offbase/20">
                    <div className="flex h-6 items-center">
                      <input
                        id="privacy-agree"
                        type="checkbox"
                        checked={agreed}
                        onChange={(e) => setAgreed(e.target.checked)}
                        className="h-4 w-4 rounded border-gray-300 text-accent focus:ring-accent bg-base"
                      />
                    </div>
                    <div className="text-sm leading-6">
                      <label htmlFor="privacy-agree" className="font-medium text-foreground select-none cursor-pointer">
                        I have read and agree to the
                      </label>{' '}
                      <a href="/privacy" target="_blank" className="font-semibold text-accent hover:underline">
                        Privacy Policy
                      </a>
                    </div>
                  </div>

                  <div className="flex justify-end">
                    <Button
                      type="button"
                      disabled={!agreed}
                      className="inline-flex justify-center rounded-lg bg-accent px-4 py-2 text-sm 
                               font-medium text-background hover:bg-secondary-accent
                               disabled:opacity-50 disabled:cursor-not-allowed
                               focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2
                               transform transition-transform duration-200 ease-in-out enabled:hover:scale-[1.04]"
                      onClick={handleAccept}
                    >
                      Continue
                    </Button>
                  </div>
                </div>
              </DialogPanel>
            </TransitionChild>
          </div>
        </div>
      </Dialog>
    </Transition>
  );
}

/**
 * Function to programmatically show the privacy popup
 * This can be called from signin/signup components
 */
export function showPrivacyModal(options?: { authEnabled?: boolean }): void {
  // Create a temporary container for the popup
  const container = document.createElement('div');
  container.id = 'privacy-modal-container';
  document.body.appendChild(container);

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  void options;

  // Import React and render the popup
  import('react-dom/client').then(({ createRoot }) => {
    import('react').then((React) => {
      const root = createRoot(container);

      const PopupWrapper = () => {
        const [show, setShow] = useState(true);

        const handleClose = () => {
          setShow(false);
        };

        return (
          <Transition
            appear
            show={show}
            as={Fragment}
            afterLeave={() => {
              root.unmount();
              container.remove();
            }}
          >
            <Dialog as="div" className="relative z-50" onClose={handleClose}>
              <TransitionChild
                as={Fragment}
                enter="ease-out duration-300"
                enterFrom="opacity-0"
                enterTo="opacity-100"
                leave="ease-in duration-200"
                leaveFrom="opacity-100"
                leaveTo="opacity-0"
              >
                <div className="fixed inset-0 overlay-dim backdrop-blur-sm" />
              </TransitionChild>

              <div className="fixed inset-0 overflow-y-auto">
                <div className="flex min-h-full items-start justify-center p-4 pt-6 text-center sm:items-center sm:pt-4">
                  <TransitionChild
                    as={Fragment}
                    enter="ease-out duration-300"
                    enterFrom="opacity-0 scale-95"
                    enterTo="opacity-100 scale-100"
                    leave="ease-in duration-200"
                    leaveFrom="opacity-100 scale-100"
                    leaveTo="opacity-0 scale-95"
                  >
                    <DialogPanel className="w-full max-w-md transform rounded-2xl bg-base p-6 text-left align-middle shadow-xl transition-all">
                      <DialogTitle
                        as="h3"
                        className="text-lg font-semibold leading-6 text-foreground"
                      >
                        Privacy & Data Usage
                      </DialogTitle>

                      <PrivacyModalBody origin={origin} />

                      <div className="mt-6 flex justify-end">
                        <Button
                          type="button"
                          className="inline-flex justify-center rounded-lg bg-accent px-4 py-2 text-sm 
                                   font-medium text-background hover:bg-secondary-accent focus:outline-none 
                                   focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2
                                   transform transition-transform duration-200 ease-in-out hover:scale-[1.04]"
                          onClick={handleClose}
                        >
                          Close
                        </Button>
                      </div>
                    </DialogPanel>
                  </TransitionChild>
                </div>
              </div>
            </Dialog>
          </Transition>
        );
      };

      root.render(React.createElement(PopupWrapper));
    });
  });
}
