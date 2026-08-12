"use client";

export default function CaseWorkspaceError({ reset }: { readonly reset: () => void }) {
  return (
    <section className="max-w-[1500px] mx-auto workspace-section">
      <h2 className="section-title">Case workspace is temporarily unavailable</h2>
      <p className="section-detail">The request could not be completed. Retry without changing the current case context.</p>
      <button type="button" className="secondary-button mt-4" onClick={reset}>Retry</button>
    </section>
  );
}
