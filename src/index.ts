/** Ringivo API client. Pre-release: the full client arrives in 0.1.0. */
export interface RingivoOptions {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
}

export class Ringivo {
  readonly baseUrl: string;
  constructor(opts: RingivoOptions) {
    if (!opts.baseUrl) throw new Error("baseUrl is required");
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
  }
}
