export type LeadResult = {
  ok: true;
  discountCode?: string;
  discountUrl?: string;
};

export async function saveLead(lead: { id: string; name: string; phone?: string }): Promise<LeadResult> {
  const response = await fetch('/api/leads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(lead),
    signal: AbortSignal.timeout(30000),
  });

  const result = await response.json();

  if (result?.error === 'duplicate_phone') {
    throw new Error('DUPLICATE_PHONE');
  }

  if (!response.ok || result.ok !== true) {
    throw new Error('Unable to save. Please try again.');
  }

  return result as LeadResult;
}
