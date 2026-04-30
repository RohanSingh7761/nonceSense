// Upload data to 0G-KV
async function uploadToKV(streamId, key, value) {
  const [nodes, err] = await indexer.selectNodes(1);
  if (err !== null) {
    throw new Error(`Error selecting nodes: ${err}`);
  }

  const batcher = new Batcher(1, nodes, flowContract, RPC_URL);

  const keyBytes = Uint8Array.from(Buffer.from(key, 'utf-8'));
  const valueBytes = Uint8Array.from(Buffer.from(value, 'utf-8'));
  batcher.streamDataBuilder.set(streamId, keyBytes, valueBytes);

  const [tx, batchErr] = await batcher.exec();
  if (batchErr !== null) {
    throw new Error(`Batch execution error: ${batchErr}`);
  }

  console.log("KV upload successful! TX:", tx);
}

// Download data from 0G-KV
async function downloadFromKV(streamId, key) {
  const kvClient = new KvClient("http://3.101.147.150:6789");
  const keyBytes = Uint8Array.from(Buffer.from(key, 'utf-8'));
  const value = await kvClient.getValue(streamId, ethers.encodeBase64(keyBytes));
  return value;
}