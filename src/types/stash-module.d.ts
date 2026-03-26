declare module "@d2runewizard/d2s/lib/d2/stash.js" {
  export function read(
    buffer: Uint8Array,
    constants?: unknown,
    version?: number | null,
    userConfig?: unknown,
  ): Promise<unknown>;
}
