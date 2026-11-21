import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHttpAdapter } from '../src/lib/http-adapter.ts';

const caseId = '11111111-1111-4111-8111-111111111111';

test('live client authenticates calls, resumes SSE and surfaces errors', async context => {
  const event = { id: caseId + '-2', investigationId: caseId, sequence: 2, type: 'investigation_completed' };
  const calls = context.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(options.headers.get('Authorization'), 'Bearer test-session');
    if (url.endsWith('/me')) return Response.json({ organisationId: 'org_alpha' });
    if (url.includes('/events?after=1')) {
      assert.equal(options.headers.get('Last-Event-ID'), caseId + '-1');
      const sse = new ReadableStream({
        start(controller) {
          const frame = 'id: ' + event.id + '\r\ndata: ' + JSON.stringify(event) + '\r\n\r\n';
          controller.enqueue(new TextEncoder().encode(frame.slice(0, 16)));
          controller.enqueue(new TextEncoder().encode(frame.slice(16)));
          controller.close();
        },
      });
      return new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } });
    }
    return Response.json({ detail: 'Finance Controller access is required.' }, { status: 403 });
  });
  const api = createHttpAdapter('https://api.example/', { token: async () => 'test-session' });
  assert.equal((await api.me()).organisationId, 'org_alpha');
  const received = [];
  for await (const item of api.events(caseId, { after: 1 })) received.push(item);
  assert.deepEqual(received, [event]);
  await assert.rejects(api.verify('invoice', {}), /Finance Controller access is required/);
  await assert.rejects(createHttpAdapter('https://api.example', { token: async () => undefined }).listInvoices(), /Sign in/);
  assert.equal(calls.mock.callCount(), 3);
});
