export interface Call {
  url: string;
  init: RequestInit | undefined;
}

export function mockFetch(responder: (url: string, init?: RequestInit) => { status: number; body: unknown }) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const { status, body } = responder(url, init);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fn, calls };
}
