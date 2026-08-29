"use client";

export default function CaseWorkspaceError({ reset }: { readonly reset: () => void }) {
  return (
    <section className="max-w-[1500px] mx-auto workspace-section">
      <h2 className="section-title">案件工作區暫時無法使用</h2>
      <p className="section-detail">請稍後重試。</p>
      <button type="button" className="secondary-button mt-4" onClick={reset}>重新載入</button>
    </section>
  );
}
