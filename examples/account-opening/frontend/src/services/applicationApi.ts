export async function createApplication(payload: unknown): Promise<{ applicationId: string }> {
  const response = await fetch('/api/applications', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error('Application submission failed');
  return response.json();
}
