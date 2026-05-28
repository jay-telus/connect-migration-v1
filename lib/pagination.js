export async function paginate(client, CommandCtor, input, resultKey, tokenIn = "NextToken", tokenOut = "NextToken") {
  const results = [];
  let token;
  do {
    const page = await client.send(new CommandCtor({ ...input, [tokenIn]: token }));
    const values = page[resultKey] || [];
    results.push(...values);
    token = page[tokenOut];
  } while (token);
  return results;
}

export function chunk(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

export async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
