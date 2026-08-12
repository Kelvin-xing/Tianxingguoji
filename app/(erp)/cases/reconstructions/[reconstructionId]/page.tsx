import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function ReconstructionPage({
  params,
}: {
  readonly params: Promise<{ readonly reconstructionId: string }>;
}) {
  if (process.env.CASE_RECONSTRUCTION_ENABLED !== "true") notFound();
  const { reconstructionId } = await params;

  return (
    <main data-reconstruction-id={reconstructionId}>
      <h1>Case reconstruction</h1>
      <p>Reconstruction details are available after the approved HK runtime is configured.</p>
    </main>
  );
}
