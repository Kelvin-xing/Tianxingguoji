"use client";

import { useState, type FormEvent } from "react";

export function GuardianRelationshipPanel({ studentId }: { readonly studentId: string }) {
  const [guardianId, setGuardianId] = useState("");
  const [relationshipType, setRelationshipType] = useState("parent");
  const [successorGuardianId, setSuccessorGuardianId] = useState("");
  const [expectedVersion, setExpectedVersion] = useState("1");
  const [status, setStatus] = useState<"idle" | "saving" | "error" | "saved">("idle");

  async function attach(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("saving");
    const response = await fetch(`/api/v1/students/${studentId}/guardians`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({
        guardian_id: guardianId,
        relationship_type: relationshipType,
        is_legal_guardian: true,
        is_primary_contact: false,
        is_emergency_contact: false,
        is_billing_contact: false,
        notification_consent: true,
      }),
    });
    setStatus(response.ok ? "saved" : "error");
  }

  async function handoff(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("saving");
    const response = await fetch(`/api/v1/students/${studentId}/guardians/primary-handoffs`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({
        successor_guardian_id: successorGuardianId,
        expected_primary_record_version: Number(expectedVersion),
        reason: "guardian.primary.handoff",
      }),
    });
    setStatus(response.ok ? "saved" : "error");
  }

  return (
    <section aria-labelledby="guardian-relationships-heading">
      <h1 id="guardian-relationships-heading">Guardian Relationships</h1>
      <form onSubmit={attach}>
        <label htmlFor="guardian-id">Guardian ID</label>
        <input id="guardian-id" value={guardianId} onChange={(event) => setGuardianId(event.target.value)} required />
        <label htmlFor="relationship-type">Relationship</label>
        <input id="relationship-type" value={relationshipType} onChange={(event) => setRelationshipType(event.target.value)} required />
        <button type="submit" disabled={status === "saving"}>Add relationship</button>
      </form>
      <form onSubmit={handoff}>
        <label htmlFor="successor-guardian-id">Successor Guardian ID</label>
        <input id="successor-guardian-id" value={successorGuardianId} onChange={(event) => setSuccessorGuardianId(event.target.value)} required />
        <label htmlFor="primary-version">Current primary version</label>
        <input id="primary-version" type="number" min="1" value={expectedVersion} onChange={(event) => setExpectedVersion(event.target.value)} required />
        <button type="submit" disabled={status === "saving"}>Hand off primary</button>
      </form>
      <p role="status">{status === "error" ? "Request could not be completed." : status === "saved" ? "Saved." : ""}</p>
    </section>
  );
}
