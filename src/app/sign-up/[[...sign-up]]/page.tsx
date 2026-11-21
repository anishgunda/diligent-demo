import { SignUp } from '@clerk/nextjs';
import { redirect } from 'next/navigation';

export default function Page() {
  if (process.env.NEXT_PUBLIC_API_MODE !== 'live') redirect('/invoices');
  return <main className="main"><SignUp signInUrl="/sign-in" fallbackRedirectUrl="/invoices" /></main>;
}
