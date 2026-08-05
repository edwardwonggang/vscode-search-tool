import { StringDecoder } from 'string_decoder';

/**
 * 跨 chunk 的 UTF-8 安全解码器：ssh2 数据包边界可能落在多字节字符中间，
 * 每次独立 toString('utf8') 会产生 U+FFFD 乱码；用 Node 的 StringDecoder
 * 跨 chunk 保持半字符状态，使解码结果等价于对整个字节流一次解码。
 * 入参为 Buffer 时经 StringDecoder 解码；已解码的字符串原样返回。
 */
export class Utf8ChunkDecoder {
  private readonly decoder = new StringDecoder('utf8');

  public write(chunk: Buffer | string): string {
    return typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
  }

  /** 流结束调用：返回缓冲区中残余字节的解码结果（正常结束时应为空串）。 */
  public end(): string {
    return this.decoder.end();
  }
}
