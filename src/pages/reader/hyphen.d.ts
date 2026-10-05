declare module "hyphen/tr" {
  export function hyphenateSync(
    text: string,
    options?: { minWordLength?: number; hyphenChar?: string },
  ): string;
}
