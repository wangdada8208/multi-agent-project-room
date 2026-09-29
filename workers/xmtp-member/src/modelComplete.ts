export interface CompleteWithFetchInput {
  apiKey: string;
  url: string;
  prompt: string;
  fetchImpl?: typeof fetch;
}

export async function completeWithFetch(input: CompleteWithFetchInput): Promise<string> {
  const fetchFn = input.fetchImpl ?? fetch;
  const res = await fetchFn(input.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${input.apiKey}`,
    },
    body: JSON.stringify({ prompt: input.prompt }),
  });

  if (!res.ok) {
    throw new Error(`Model request failed with status: ${res.status}`);
  }

  let data: any;
  try {
    data = await res.json();
  } catch {
    throw new Error(`Model response parse failed with status: ${res.status}`);
  }

  if (!data || typeof data.text !== "string") {
    throw new Error(`Model response missing text field with status: ${res.status}`);
  }

  return data.text;
}
