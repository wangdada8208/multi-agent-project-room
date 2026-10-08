const address = process.env.VITE_XMTP_WORKER_ADDRESS;
if (!/^0x[0-9a-fA-F]{40}$/.test(address ?? '') || /^0x0{40}$/i.test(address)) {
  throw new Error('Release requires a valid public VITE_XMTP_WORKER_ADDRESS. Configure the repository variable before building.');
}
if (!['production', 'dev', 'local'].includes(process.env.VITE_XMTP_ENV ?? 'production')) {
  throw new Error('Invalid VITE_XMTP_ENV');
}
