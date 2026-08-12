"use client";

import { useState } from "react";
import type { FormEvent } from "react";

export default function NewReconstructionPage() {
  const [pilotReference, setPilotReference] = useState("");
  const [status, setStatus] = useState<string | null>(null);

  async function createDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("Creating draft...");
    const response = await fetch("/api/v1/cases/reconstructions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": `reconstruction-${crypto.randomUUID()}`,
      },
      body: JSON.stringify({ pilot_reference: pilotReference }),
    });
    setStatus(response.ok ? "Draft created." : "Draft could not be created.");
  }

  return (
    <main>
      <h1>New case reconstruction</h1>
      <form onSubmit={createDraft}>
        <label htmlFor="pilot-reference">Pilot reference</label>
        <input
          id="pilot-reference"
          name="pilot_reference"
          value={pilotReference}
          onChange={(event) => setPilotReference(event.target.value)}
          required
          pattern="[A-Za-z0-9][A-Za-z0-9._:-]{0,127}"
        />
        <button type="submit">Create draft</button>
      </form>
      {status ? <p role="status">{status}</p> : null}
    </main>
  );
}
