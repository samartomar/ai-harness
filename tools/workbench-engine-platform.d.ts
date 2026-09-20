/**
 * The only globals the Policy Workbench engine may assume, for
 * tsconfig.workbench-engine.json. That program has neither DOM nor Node types,
 * so anything the engine uses beyond the language must be named here. Each of
 * these exists in every host the engine runs in: browsers and Node 20+.
 * Adding a name is a reviewed decision about the engine's host contract.
 */

declare function structuredClone<T>(value: T): T;

declare class TextEncoder {
  encode(input?: string): Uint8Array;
}

declare class URL {
  constructor(url: string, base?: string | URL);
  readonly hash: string;
  readonly host: string;
  readonly hostname: string;
  readonly href: string;
  readonly origin: string;
  readonly password: string;
  readonly pathname: string;
  readonly port: string;
  readonly protocol: string;
  readonly search: string;
  readonly username: string;
  toString(): string;
}
