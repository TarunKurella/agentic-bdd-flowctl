import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CustomerSelect } from '../ui/CustomerSelect';
import { createApplication } from '../services/applicationApi';

export function JointApplicantPage() {
  const navigate = useNavigate();
  const [primaryApplicantId, setPrimaryApplicantId] = useState('');
  const [jointApplicantId, setJointApplicantId] = useState('');
  const [productCode, setProductCode] = useState('');

  async function submitJointApplication() {
    const response = await createApplication({
      applicationType: 'JOINT',
      primaryApplicantId,
      jointApplicantId,
      productCode,
    });
    navigate(`/applications/${response.applicationId}/confirmation`);
  }

  return (
    <main>
      <h1>Joint applicant</h1>
      <CustomerSelect name="primaryApplicantId" label="Primary applicant" value={primaryApplicantId} onChange={setPrimaryApplicantId} required />
      <CustomerSelect name="jointApplicantId" label="Joint applicant" value={jointApplicantId} onChange={setJointApplicantId} required />
      <input name="productCode" aria-label="Product code" value={productCode} onChange={(event) => setProductCode(event.target.value)} minLength={3} required />
      <button onClick={submitJointApplication}>Submit joint application</button>
    </main>
  );
}
