import { useNavigate } from 'react-router-dom';
import { CustomerSelect } from '../ui/CustomerSelect';

export function JointPrimaryApplicantPage() {
  const navigate = useNavigate();

  function continueToJointApplicant() {
    navigate('/applications/joint/secondary');
  }

  return (
    <main>
      <h1>Primary joint applicant</h1>
      <CustomerSelect name="primaryApplicantId" label="Primary applicant" required />
      <button onClick={continueToJointApplicant}>Add joint applicant</button>
    </main>
  );
}
