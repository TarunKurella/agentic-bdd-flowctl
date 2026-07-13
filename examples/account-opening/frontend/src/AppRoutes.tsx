import { Route, Routes } from 'react-router-dom';
import { ApplicationTypePage } from './pages/ApplicationTypePage';
import { PersonalApplicantPage } from './pages/PersonalApplicantPage';
import { JointPrimaryApplicantPage } from './pages/JointPrimaryApplicantPage';
import { JointApplicantPage } from './pages/JointApplicantPage';
import { ReviewApplicationPage } from './pages/ReviewApplicationPage';
import { ConfirmationPage } from './pages/ConfirmationPage';

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/applications/new" element={<ApplicationTypePage />} />
      <Route path="/applications/personal" element={<PersonalApplicantPage />} />
      <Route path="/applications/joint/primary" element={<JointPrimaryApplicantPage />} />
      <Route path="/applications/joint/secondary" element={<JointApplicantPage />} />
      <Route path="/applications/review" element={<ReviewApplicationPage />} />
      <Route path="/applications/:applicationId/confirmation" element={<ConfirmationPage />} />
    </Routes>
  );
}
