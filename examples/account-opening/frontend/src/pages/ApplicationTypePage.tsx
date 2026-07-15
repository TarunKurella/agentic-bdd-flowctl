import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

export function ApplicationTypePage() {
  const navigate = useNavigate();
  const [applicationType, setApplicationType] = useState<'PERSONAL' | 'JOINT'>('PERSONAL');

  function continuePersonal() {
    navigate('/applications/personal');
  }

  function continueJoint() {
    navigate('/applications/joint');
  }

  return (
    <main>
      <h1>Choose application type</h1>
      <label>
        <input name="applicationType" type="radio" value="PERSONAL" onChange={() => setApplicationType('PERSONAL')} required />
        Personal
      </label>
      <label>
        <input name="applicationType" type="radio" value="JOINT" onChange={() => setApplicationType('JOINT')} required />
        Joint
      </label>

      {applicationType === 'PERSONAL' && <button onClick={continuePersonal}>Continue</button>}
      {applicationType === 'JOINT' && <button onClick={continueJoint}>Continue</button>}
    </main>
  );
}
