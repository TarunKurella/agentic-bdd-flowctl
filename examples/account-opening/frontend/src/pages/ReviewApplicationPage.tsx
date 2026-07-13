import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { createApplication } from '../services/applicationApi';
import { hasPermission } from '../services/session';

export function ReviewApplicationPage() {
  const navigate = useNavigate();
  const [submitting, setSubmitting] = useState(false);
  const canSubmit = hasPermission('APPLICATION_CREATE');

  async function submitApplication() {
    setSubmitting(true);
    const response = await createApplication({ applicationType: 'JOINT' });
    navigate(`/applications/${response.applicationId}/confirmation`);
  }

  return (
    <main>
      <h1>Review application</h1>
      <button onClick={submitApplication} disabled={!canSubmit || submitting}>Submit application</button>
    </main>
  );
}
