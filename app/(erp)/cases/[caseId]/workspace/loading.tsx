import { CaseWorkspace } from "@/components/cases/CaseWorkspace";

export default function CaseWorkspaceLoading() {
  return <CaseWorkspace projection={{
    routeBase: "/cases",
    header: null,
    tabs: [],
    activeTab: "overview",
    panel: { kind: "loading" },
    conflict: null,
  }} />;
}
