export const gbp = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' });
const date = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/London' });
const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Europe/London' });
export const day = (value: string) => date.format(new Date(value));
export const clock = (value: string) => time.format(new Date(value));
export const verdictLabel = { NO_NEW_FLAGS: 'No new flags', HOLD_FOR_VERIFICATION: 'Hold for verification', REJECT_PAYMENT_REQUEST: 'Reject payment request' } as const;
export const errorText = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong.';
