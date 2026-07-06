function hasUnsupportedMountSourceChar(value: string): boolean {
  return [...value].some((char) => {
    const code = char.charCodeAt(0);
    return char === "," || code <= 0x1f || code === 0x7f;
  });
}

export function dockerBindMountArg(source: string, target: string): string {
  if (hasUnsupportedMountSourceChar(source)) {
    throw new Error("unsupported Docker bind mount source path: comma/control characters");
  }
  return `type=bind,source=${source},target=${target},readonly`;
}
