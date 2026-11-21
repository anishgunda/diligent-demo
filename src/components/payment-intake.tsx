'use client';

import { useState } from 'react';
import { useApi } from '@/lib/api-context';
import { errorText } from '@/lib/format';
import type { Payment } from '@/lib/types';
import { ErrorBox } from './common';
import { Button } from './ui/button';

export function PaymentIntake({ onSaved }: { onSaved: (payment: Payment) => void }) {
  const api = useApi();
  const [sortCode, setSortCode] = useState('');
  const [account, setAccount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <details className="review-block">
    <summary className="text-link">Enter a payment destination securely</summary>
    <div className="form-stack">
      <label>New sort code<input type="password" inputMode="numeric" autoComplete="off" maxLength={8} value={sortCode} onChange={event => setSortCode(event.target.value)} /></label>
      <label>New account number<input type="password" inputMode="numeric" autoComplete="off" maxLength={9} value={account} onChange={event => setAccount(event.target.value)} /></label>
      {error && <ErrorBox message={error} />}
      <Button variant="outline" disabled={busy || !sortCode || !account} onClick={async () => {
        setBusy(true);
        setError('');
        try {
          const payment = await api.createPaymentCandidate({ sortCode, account });
          setSortCode('');
          setAccount('');
          onSaved(payment);
        } catch (reason) { setError(errorText(reason)); }
        finally { setBusy(false); }
      }}>Use masked destination</Button>
    </div>
  </details>;
}
