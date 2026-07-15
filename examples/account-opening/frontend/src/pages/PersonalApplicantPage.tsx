import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CustomerSelect } from '../ui/CustomerSelect';
import { createApplication } from '../services/applicationApi';

export function PersonalApplicantPage() {
  const navigate = useNavigate();
  const [primaryApplicantId, setPrimaryApplicantId] = useState('');
  const [productCode, setProductCode] = useState('');

  async function submitPersonalApplication() {
    const response = await createApplication({
      applicationType: 'PERSONAL',
      primaryApplicantId,
      productCode,
    });
    navigate(`/applications/${response.applicationId}/confirmation`);
  }

  return (
    <main>
      <h1>Primary applicant</h1>
      <CustomerSelect name="primaryApplicantId" label="Primary applicant" value={primaryApplicantId} onChange={setPrimaryApplicantId} required />
      <input name="productCode" aria-label="Product code" value={productCode} onChange={(event) => setProductCode(event.target.value)} minLength={3} required />
      <button onClick={submitPersonalApplication}>Submit personal application</button>
    </main>
  );
}
