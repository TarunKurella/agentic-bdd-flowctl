import { useNavigate } from 'react-router-dom';
import { CustomerSelect } from '../ui/CustomerSelect';

export function PersonalApplicantPage() {
  const navigate = useNavigate();

  function continueToReview() {
    navigate('/applications/review');
  }

  return (
    <main>
      <h1>Primary applicant</h1>
      <CustomerSelect name="primaryApplicantId" label="Primary applicant" required />
      <input name="productCode" aria-label="Product code" minLength={3} required />
      <button onClick={continueToReview}>Review personal application</button>
    </main>
  );
}
