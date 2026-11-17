'use client';

import { createContext, useContext, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Page, TranslatedText } from '@/components/ui/standard';

const SystemDataTarget = createContext<HTMLDivElement | null | undefined>(undefined);

/** Only moves rendered metadata; lock values stay in their owning components. */
export function CaseSystemDataProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  return <SystemDataTarget.Provider value={target}>
    <Page>
      {children}
      <details className="ui-history">
        <summary><TranslatedText translationKey="caseUi.systemData" /></summary>
        <div className="ui-stack" ref={setTarget} />
      </details>
    </Page>
  </SystemDataTarget.Provider>;
}

export function CaseSystemDataEntry({ children }: { children: ReactNode }) {
  const target = useContext(SystemDataTarget);
  // Standalone assessment pages still expose their metadata, collapsed after the editor.
  if (target === undefined) return <details className="ui-history">
    <summary><TranslatedText translationKey="caseUi.systemData" /></summary>{children}
  </details>;
  return target ? createPortal(<div className="ui-stack">{children}</div>, target) : null;
}
