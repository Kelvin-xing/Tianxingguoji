"use client";

import { createContext, useContext, useState, type ReactNode } from "react";

import type { CaseWorkflowStatus } from "@/modules/cases/client";

interface CaseWorkflowContextValue {
  readonly workflowStatus: CaseWorkflowStatus;
  readonly setAuthoritativeWorkflowStatus: (status: CaseWorkflowStatus) => void;
}

const CaseWorkflowContext = createContext<CaseWorkflowContextValue | null>(null);

export function CaseWorkflowProvider({
  initialWorkflowStatus,
  children,
}: {
  readonly initialWorkflowStatus: CaseWorkflowStatus;
  readonly children: ReactNode;
}) {
  const [workflowStatus, setWorkflowStatus] = useState(initialWorkflowStatus);
  return (
    <CaseWorkflowContext.Provider value={{
      workflowStatus,
      setAuthoritativeWorkflowStatus: setWorkflowStatus,
    }}>
      {children}
    </CaseWorkflowContext.Provider>
  );
}

export function useCaseWorkflowContext(): CaseWorkflowContextValue {
  const value = useContext(CaseWorkflowContext);
  if (!value) throw new Error("Case workflow context is unavailable.");
  return value;
}
