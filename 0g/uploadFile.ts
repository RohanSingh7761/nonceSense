async function uploadFile(filePath) {
  const file = await ZgFile.fromFilePath(filePath);

  // Must call merkleTree() before upload — populates internal state
  const [tree, treeErr] = await file.merkleTree();
  if (treeErr !== null) throw new Error(`Merkle tree error: ${treeErr}`);

  console.log("Root Hash:", tree?.rootHash());

  const [tx, uploadErr] = await indexer.upload(file, RPC_URL, signer);
  if (uploadErr !== null) throw new Error(`Upload error: ${uploadErr}`);

  await file.close(); // Always close when done

  // Handle both single and fragmented (>4GB) responses
  if ('rootHash' in tx) {
    return { rootHash: tx.rootHash, txHash: tx.txHash };
  } else {
    return { rootHashes: tx.rootHashes, txHashes: tx.txHashes };
  }
}