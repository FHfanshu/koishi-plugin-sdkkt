declare module 'pngjs' {
  export class PNG {
    width: number;
    height: number;
    data: Buffer;
    gamma: number;
    text?: Record<string, string>;

    static sync: {
      read(buffer: Buffer, options?: any): PNG;
      write(png: PNG, options?: any): Buffer;
    };

    constructor(options?: any);
    parse(buffer: Buffer, callback?: (error: Error | null, data: PNG) => void): PNG;
    pack(): any;
  }
}
