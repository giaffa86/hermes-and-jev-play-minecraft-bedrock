import bedrock from 'bedrock-protocol';
const { ping } = bedrock;

(async () => {
  try {
    const res = await ping({ host: '<ip-server-bedrock>', port: 19132, transport: 'nethernet', timeout: 10000 });
    console.log('PING OK', JSON.stringify(res, (k, v) => typeof v === 'bigint' ? v.toString() : v, 2));
  } catch (e) {
    console.error('PING FAILED', e.message, e.stack);
  }
})();
