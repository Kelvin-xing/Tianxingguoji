import Link from "next/link";

import { InviteActivationForm } from "./InviteActivationForm";

const errorMessages: Readonly<Record<string, string>> = {
  invalid_invite: "啟用資訊無效、已使用或已過期。",
  service_unavailable: "啟用服務暫時不可用，請聯絡系統管理員。",
  configuration: "啟用服務尚未完成設定。",
};

export default async function InviteActivationPage({
  searchParams,
}: {
  searchParams: Promise<{ readonly error?: string }>;
}) {
  const { error } = await searchParams;
  const errorMessage = error ? errorMessages[error] : undefined;

  return (
    <main className="min-h-screen flex items-center justify-center p-6" style={{ background: "var(--page-bg)" }}>
      <section className="w-full max-w-md">
        <div className="mb-8">
          <div className="eyebrow">公司工作台</div>
          <h1 className="text-2xl font-semibold mt-2" style={{ color: "var(--text-primary)" }}>
            啟用公司帳戶
          </h1>
          <p className="mt-2 text-sm leading-6" style={{ color: "var(--text-secondary)" }}>
            輸入邀請通知提供的啟用資訊，完成帳戶設定。
          </p>
        </div>
        {errorMessage ? (
          <p className="form-error mb-4" role="alert">{errorMessage}</p>
        ) : null}
        <InviteActivationForm />
        <Link className="inline-block mt-6 text-sm" href="/login">
          返回登入
        </Link>
      </section>
    </main>
  );
}
