import { SignIn } from '@clerk/nextjs';
import { redirect } from 'next/navigation';

export default function Page() {
  if (process.env.NEXT_PUBLIC_API_MODE !== 'live') redirect('/invoices');
  return <main className="main"><SignIn signUpUrl="/sign-up" fallbackRedirectUrl="/invoices" /></main>;
}
