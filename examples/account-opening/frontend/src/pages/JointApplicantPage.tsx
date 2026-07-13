import { useNavigate } from 'react-router-dom';
import { CustomerSelect } from '../ui/CustomerSelect';

export function JointApplicantPage() {
  const navigate = useNavigate();

  function continueToReview() {
    navigate('/applications/review');
  }

  return (
    <main>
      <h1>Joint applicant</h1>
      <CustomerSelect name="jointApplicantId" label="Joint applicant" required />
      <input name="productCode" aria-label="Product code" minLength={3} required />
      <button onClick={continueToReview}>Review joint application</button>
    </main>
  );
}
