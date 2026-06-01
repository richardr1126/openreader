'use client';

import { useState } from 'react';
import { CopyIcon, CheckIcon } from '@/components/icons/Icons';
import { Button } from '@/components/ui';

export function CodeBlock({ children }: { children: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(children);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative group my-2">
      <pre className="bg-background p-3 rounded-md overflow-x-auto text-xs text-left
                      font-mono text-foreground border border-line">
        <code>{children}</code>
      </pre>
      <Button
        onClick={handleCopy}
        variant="secondary"
        size="icon"
        className="absolute top-2 right-2 h-7 w-7 opacity-0 group-hover:opacity-100 focus:opacity-100"
        title="Copy to clipboard"
      >
        {copied ? <CheckIcon className="w-4 h-4" /> : <CopyIcon className="w-4 h-4" />}
      </Button>
    </div>
  );
}
