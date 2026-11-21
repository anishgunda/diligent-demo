import type { AuthAdapter, Identity, IdentityTwinApi, InvestigationEvent } from './types';

export function createHttpAdapter(base: string, auth: Pick<AuthAdapter, 'token'>): IdentityTwinApi & { me(signal?: AbortSignal): Promise<Identity> } {
  const listeners = new Set<() => void>();
  async function request(path: string, options?: RequestInit) {
    if (!base) throw new Error('Configure NEXT_PUBLIC_API_URL to connect to FastAPI.');
    const token = await auth.token();
    const headers = new Headers(options?.headers);
    if (!token) throw new Error('Sign in to access the organisation API.');
    headers.set('Authorization', 'Bearer ' + token);
    if (typeof options?.body === 'string') headers.set('Content-Type', 'application/json');
    const response = await fetch(base.replace(/\/$/, '') + '/api' + path, { ...options, headers, cache: 'no-store' });
    if (!response.ok) {
      const problem = await response.json().catch(() => null) as { detail?: string } | null;
      throw new Error(typeof problem?.detail === 'string' ? problem.detail : 'The API returned HTTP ' + response.status + '.');
    }
    return response;
  }

  async function json<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const response = await request(path, { method, body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body) });
    const result: T = await response.json();
    if (method !== 'GET' && /^\/(?:invoices|suppliers|cases|investigate)(?:\/|$)/.test(path)) {
      listeners.forEach(listener => listener());
    }
    return result;
  }

  const demoOnly = async () => { throw new Error('This action is available in mock mode.'); };
  return {
    me: async signal => (await request('/me', { signal })).json(),
    extract(input) {
      const form = new FormData();
      if (input.file) form.append('file', input.file);
      form.append('sample', String(input.sample));
      form.append('senderEmail', input.senderEmail);
      form.append('message', input.message);
      return json('/extract', 'POST', form);
    },
    listInvoices: () => json('/invoices'),
    getInvoice: id => json('/invoices/' + encodeURIComponent(id)),
    saveInvoice: input => json('/invoices', 'POST', input),
    submitDemoInvoice: demoOnly,
    startInvestigation: input => json('/investigate', 'POST', input),
    async *events(id, { after = 0, signal } = {}) {
      const response = await request('/investigations/' + encodeURIComponent(id) + '/events?after=' + after, {
        signal, headers: { Accept: 'text/event-stream', 'Last-Event-ID': id + '-' + after },
      });
      if (response.status === 204) return;
      if (!response.body || !response.headers.get('Content-Type')?.includes('text/event-stream')) throw new Error('Investigation stream is unavailable.');
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let pending = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) return;
          pending += value;
          let boundary = /\r?\n\r?\n/.exec(pending);
          while (boundary) {
            const chunk = pending.slice(0, boundary.index);
            pending = pending.slice(boundary.index + boundary[0].length);
            const data = chunk.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
            if (data) {
              const event = JSON.parse(data) as InvestigationEvent;
              if (event.investigationId !== id || !Number.isInteger(event.sequence)) throw new Error('Invalid investigation event.');
              if (event.sequence > after) {
                after = event.sequence;
                yield event;
              }
              if (['completed', 'error', 'investigation_completed', 'investigation_failed'].includes(event.type)) return;
            }
            boundary = /\r?\n\r?\n/.exec(pending);
          }
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    },
    verify: (id, input) => json('/cases/' + encodeURIComponent(id) + '/verify', 'POST', input),
    requestVerification: id => json('/cases/' + encodeURIComponent(id) + '/verification-request', 'POST'),
    listSuppliers: () => json('/suppliers'),
    saveSupplier: (input, id) => json(id ? '/suppliers/' + encodeURIComponent(id) : '/suppliers', id ? 'PATCH' : 'POST', input),
    listPaymentOptions: id => json('/suppliers/' + encodeURIComponent(id) + '/payment-options'),
    proposePayment: (id, paymentId) => json('/suppliers/' + encodeURIComponent(id) + '/payment-proposals', 'POST', { paymentId }),
    createPaymentCandidate: input => json('/payment-candidates', 'POST', input),
    approvePayment: (id, proposalId, review) => json('/suppliers/' + encodeURIComponent(id) + '/payment-proposals/' + encodeURIComponent(proposalId) + '/approve', 'POST', review),
    getDocument: async id => (await request('/invoices/' + encodeURIComponent(id) + '/document')).blob(),
    listReports: () => json('/reports'),
    listEvals: () => json('/evals'),
    reset: demoOnly,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
