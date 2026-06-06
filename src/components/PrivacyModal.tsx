'use client';

import { useState, useEffect } from 'react';
import { updateAppConfig } from '@/lib/client/dexie';
import { Button, Checkbox, ModalFrame, ModalTitle } from '@/components/ui';

interface PrivacyModalProps {
  isOpen: boolean;
  onAccept?: () => void;
  onDismiss?: () => void;
}

function PrivacyModalBody({ origin }: { origin: string }) {
  return (
    <div className="mt-4 space-y-4 text-sm text-soft">
      <div className="rounded-lg border border-line bg-surface-sunken p-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-soft">Service Operator</div>
        <div className="mt-1">
          This instance is hosted at <span className="font-bold">{origin || 'this server'}</span>.
        </div>
      </div>

      <p className="leading-relaxed">
        We value your privacy. This application uses strictly necessary cookies for authentication
        and optional analytics only when consent allows it. Your documents are stored encrypted at rest.
      </p>

      <p className="leading-relaxed">
        OpenReader does not currently provide end-to-end encryption.
      </p>

      <p className="leading-relaxed">
        The owner of this instance may be able to access stored metadata and uploaded files needed to operate the
        service.
      </p>

      <p className="leading-relaxed">
        Passwords are not stored as readable plaintext.
      </p>

      <p className="leading-relaxed">
        For full details on data collection, processing, and your rights, please review our complete{' '}
        <a href="/privacy" target="_blank" className="font-semibold text-accent hover:underline">Privacy Policy</a>.
      </p>
    </div>
  );
}

export function PrivacyModal({ isOpen, onAccept, onDismiss }: PrivacyModalProps) {
  const [origin, setOrigin] = useState('');
  const [agreed, setAgreed] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    setOrigin(window.location.origin);
  }, []);

  useEffect(() => {
    if (isOpen) {
      setAgreed(false);
    }
  }, [isOpen]);

  const handleAccept = async () => {
    await updateAppConfig({ privacyAccepted: true });
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('openreader:privacyAccepted'));
    }
    onAccept?.();
  };

  return (
    <ModalFrame open={isOpen} onClose={onDismiss ?? (() => {})} panelTestId="privacy-modal" className="z-[80]">
      <ModalTitle>Privacy & Data Usage</ModalTitle>

      <PrivacyModalBody origin={origin} />

      <div className="mt-6 space-y-4">
        <div className="flex items-start gap-3 rounded-lg border border-line p-3 bg-surface-sunken">
          <div className="flex h-6 items-center">
            <Checkbox
              data-testid="privacy-agree-checkbox"
              id="privacy-agree"
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
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
            data-testid="privacy-continue-button"
            variant="primary"
            size="lg"
            disabled={!agreed}
            onClick={handleAccept}
          >
            Continue
          </Button>
        </div>
      </div>
    </ModalFrame>
  );
}

/**
 * Function to programmatically show the privacy popup
 * This can be called from signin/signup components
 */
export function showPrivacyModal(): void {
  // Create a temporary container for the popup
  const container = document.createElement('div');
  container.id = 'privacy-modal-container';
  document.body.appendChild(container);

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
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
          <ModalFrame
            open={show}
            onClose={handleClose}
            afterLeave={() => {
              root.unmount();
              container.remove();
            }}
          >
            <ModalTitle>Privacy & Data Usage</ModalTitle>

            <PrivacyModalBody origin={origin} />

            <div className="mt-6 flex justify-end">
              <Button
                variant="primary"
                size="lg"
                onClick={handleClose}
              >
                Close
              </Button>
            </div>
          </ModalFrame>
        );
      };

      root.render(React.createElement(PopupWrapper));
    });
  });
}
