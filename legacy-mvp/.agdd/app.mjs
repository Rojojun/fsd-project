export function createHandler(tasks) {
  return async request => {
    if (request.method !== 'GET' || new URL(request.url).pathname !== '/tasks') {
      return new Response(null, { status: 404 });
    }
    const result = tasks.toSorted((a, b) =>
      b.createdAt.localeCompare(a.createdAt));
    return Response.json(result);
  };
}
