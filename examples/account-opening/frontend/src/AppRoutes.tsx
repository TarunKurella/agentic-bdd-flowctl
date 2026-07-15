import { Route, Routes } from 'react-router-dom';
import { ApplicationTypePage } from './pages/ApplicationTypePage';
import { PersonalApplicantPage } from './pages/PersonalApplicantPage';
import { JointApplicantPage } from './pages/JointApplicantPage';
import { ConfirmationPage } from './pages/ConfirmationPage';

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/applications/new" element={<ApplicationTypePage />} />
      <Route path="/applications/personal" element={<PersonalApplicantPage />} />
      <Route path="/applications/joint" element={<JointApplicantPage />} />
      <Route path="/applications/:applicationId/confirmation" element={<ConfirmationPage />} />
    </Routes>
  );
}
