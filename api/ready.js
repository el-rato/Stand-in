export default {
  fetch() {
    return Response.json({ ok: true, runtime: 'node' });
  },
};
