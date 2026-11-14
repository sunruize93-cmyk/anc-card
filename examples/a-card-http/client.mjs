export async function fetchExample(send) {
  let response = await send();
  if (response.status === 429) {
    response = await send();
  }
  return response.body;
}
