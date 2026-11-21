import type { ReactNode } from 'react';
import { AlertCircle, ChevronDown, Inbox, LoaderCircle } from 'lucide-react';
import Link from 'next/link';
import { buttonVariants } from './ui/button';
import { verdictLabel } from '@/lib/format';
import type { InvoiceStatus, Verdict } from '@/lib/types';

const statusTone: Record<string, string> = { Queued: 'neutral', Investigating: 'info', Held: 'warn', Cleared: 'good', Rejected: 'bad', Match: 'good', Mismatch: 'warn', Unknown: 'neutral' };
export const verdictTone = { NO_NEW_FLAGS: 'good', HOLD_FOR_VERIFICATION: 'warn', REJECT_PAYMENT_REQUEST: 'bad' } as const;

export function Badge({ children, tone = 'neutral', dot = false }: { children: ReactNode; tone?: string; dot?: boolean }) {
  return <span className={'badge tone-' + tone}>{dot && <span className="status-dot" />}{children}</span>;
}
export function Status({ value }: { value: InvoiceStatus | 'Match' | 'Mismatch' | 'Unknown' }) {
  return <Badge tone={statusTone[value]} dot>{value}</Badge>;
}
export function VerdictBadge({ verdict }: { verdict: Verdict }) {
  return <Badge tone={verdictTone[verdict]} dot>{verdictLabel[verdict]}</Badge>;
}

export function PageHeading({ title, description, actions, eyebrow }: { title: string; description: string; actions?: ReactNode; eyebrow?: string }) {
  return <div className="page-heading"><div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h1>{title}</h1><p>{description}</p></div>{actions && <div className="actions">{actions}</div>}</div>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="empty"><Inbox size={24} /><strong>{title}</strong>{children && <div className="muted">{children}</div>}</div>;
}

export function ErrorBox({ message }: { message: string }) {
  return <div role="alert" className="callout tone-bad"><AlertCircle size={17} /><span>{message}</span></div>;
}

export function Skeleton({ label = 'Loading workspace' }: { label?: string }) {
  return <div className="card skeleton-wrap" role="status" aria-label={label}><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /></div>;
}

export function SelectWrap({ children }: { children: ReactNode }) {
  return <span className="select-wrap">{children}<ChevronDown size={15} aria-hidden="true" /></span>;
}

export function LoadingIcon() { return <LoaderCircle className="animate-spin" size={16} />; }

export function LinkButton({ href, children, primary = false }: { href: string; children: ReactNode; primary?: boolean }) {
  return <Link href={href} className={buttonVariants({ variant: primary ? 'default' : 'outline' })}>{children}</Link>;
}
