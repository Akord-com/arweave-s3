import BigNumber from "bignumber.js";
import type Api from "./lib/api";
import { getError } from "./lib/error";
import type FallbackApi from "./lib/fallbackApi";
import * as ArweaveUtils from "./lib/utils";
import { MAX_CHUNK_SIZE } from "./lib/merkle";

export type TransactionChunkMetadataResponse = {
  size: string;
  offset: string;
};

export type TransactionChunkResponse = {
  chunk: string;
  data_path: string;
  tx_path: string;
};

export default class Chunks {
  constructor(private api: Api | FallbackApi) {}

  async getTransactionMetadata(id: string): Promise<TransactionChunkMetadataResponse> {
    const resp = await this.api.get(`tx/${id}/offset`);
    if (resp.status === 200) {
      return resp.data;
    }
    throw new Error(`Unable to get transaction offset: ${getError(resp)}`);
  }

  async getChunk(offset: string | number | bigint): Promise<TransactionChunkResponse> {
    const resp = await this.api.get(`chunk/${offset}`);
    if (resp.status === 200) {
      return resp.data;
    }
    throw new Error(`Unable to get chunk: ${getError(resp)}`);
  }

  async getChunkData(offset: string | number | bigint): Promise<Uint8Array> {
    const chunk = await this.getChunk(offset);
    const buf = ArweaveUtils.b64UrlToBuffer(chunk.chunk);
    return buf;
  }

  firstChunkOffset(offsetResponse: TransactionChunkMetadataResponse): number {
    return parseInt(offsetResponse.offset) - parseInt(offsetResponse.size) + 1;
  }

  async downloadChunkedData(id: string): Promise<Uint8Array> {
    // const offsetResponse = await this.getTransactionOffset(id);
    // const size = parseInt(offsetResponse.size);
    // const endOffset = parseInt(offsetResponse.offset);
    // const startOffset = endOffset - size + 1;

    // const data = new Uint8Array(size);
    // let byte = 0;

    // while (byte < size) {
    //   if (this?.api?.config?.logging) {
    //     console.log(`[chunk] ${byte}/${size}`);
    //   }

    //   let chunkData;
    //   try {
    //     chunkData = await this.getChunkData(startOffset + byte);
    //   } catch (error) {
    //     console.error(`[chunk] Failed to fetch chunk at offset ${startOffset + byte}`);
    //     console.error(`[chunk] This could indicate that the chunk wasn't uploaded or hasn't yet seeded properly to a particular gateway/node`);
    //   }

    //   if (chunkData) {
    //     data.set(chunkData, byte);
    //     byte += chunkData.length;
    //   } else {
    //     throw new Error(`Couldn't complete data download at ${byte}/${size}`);
    //   }
    // }

    // return data;
    const offsetResponse = await this.getTransactionMetadata(id);
    const size = parseInt(offsetResponse.size);
    const data = new Uint8Array(size);
    let byte = 0;
    for await (const chunkData of this.concurrentDownloadChunkedData(id)) {
      data.set(chunkData, byte);
      byte += chunkData.length;
    }
    return data;
  }

  async *concurrentDownloadChunkedData(id: string, options?: { concurrency?: number }): AsyncGenerator<Uint8Array, void, unknown> {
    const opts = { concurrency: 10, ...options };
    const metadata = await this.getTransactionMetadata(id);

    // use big numbers for safety
    const endOffset = new BigNumber(metadata.offset);
    const size = new BigNumber(metadata.size);
    const startOffset = endOffset.minus(size).plus(1);
    let processedBytes = 0;

    const chunks = Math.ceil(size.dividedBy(MAX_CHUNK_SIZE).toNumber());

    const downloadData = (offset: BigNumber): Promise<Uint8Array> =>
      this.getChunkData(offset.toString()).then((r) => {
        processedBytes += r.length;
        return r;
      });

    const processing: Promise<Uint8Array>[] = [];
    // only parallelise everything except last two chunks.
    // last two due to merkle rebalancing due to minimum chunk size, see https://github.com/ArweaveTeam/arweave-js/blob/ce441f8d4e66a2524cfe86bbbcaed34b887ba193/src/common/lib/merkle.ts#LL53C19-L53C19
    const parallelChunks = chunks - 2;

    const concurrency = Math.min(parallelChunks, opts.concurrency);
    let currChunk = 0;

    // logger.debug(`[downloadTx] Tx ${txId} start ${startOffset} size ${size} chunks ${chunks} concurrency ${concurrency}`);

    for (let i = 0; i < concurrency; i++) processing.push(downloadData(startOffset.plus(MAX_CHUNK_SIZE * currChunk++)));

    while (currChunk < parallelChunks) {
      processing.push(downloadData(startOffset.plus(MAX_CHUNK_SIZE * currChunk++)));
      // yield await so that processedBytes works properly
      yield processing.shift()!;
    }

    while (processing.length > 0) yield processing.shift()!;

    yield downloadData(startOffset.plus(MAX_CHUNK_SIZE * currChunk++));
    if (size.isGreaterThan(processedBytes)) yield downloadData(startOffset.plus(MAX_CHUNK_SIZE * currChunk++));

    if (!size.isEqualTo(processedBytes)) throw new Error(`got ${processedBytes}B, expected ${size.toString()}B`);

    return;
  }
}
